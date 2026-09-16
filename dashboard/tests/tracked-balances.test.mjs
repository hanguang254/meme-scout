import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readTrackedHoldings,
  encodeAggregate3,
  encodeBalanceOf,
  decodeAggregate3,
  decodeUint,
  packChunks,
  bodyBytes,
  bodyLimits,
  rpcFor,
  MULTICALL3,
  MAX_BODY,
  CHUNK,
} from '../scanner/tracked-balances.mjs';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
// The shape a node returns for aggregate3: (bool success, bytes returnData)[].
const encodeResults = (rows) => {
  const offsets = [];
  const items = [];
  let offset = rows.length * 32;
  for (const row of rows) {
    const data = row.data.replace(/^0x/, '');
    const words = Math.ceil(data.length / 64);
    offsets.push(word(offset));
    items.push(
      word(row.success ? 1 : 0) +
        word(64) +
        word(data.length / 2) +
        data.padEnd(words * 64, '0'),
    );
    offset += 32 * (3 + words);
  }
  return `0x${word(32)}${word(rows.length)}${offsets.join('')}${items.join('')}`;
};
const ok = (value) => ({ success: true, data: `0x${word(value)}` });
const failed = { success: false, data: '0x' };
test('balanceOf 编码是选择器加左补零的地址', () => {
  assert.equal(
    encodeBalanceOf('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'),
    '0x70a08231'.slice(2) +
      '000000000000000000000000abcdef0123456789abcdef0123456789abcdef01',
  );
});
test('aggregate3 编码后能被同样的规则解回来', () => {
  const calls = [
    { target: TOKEN, allowFailure: true, callData: encodeBalanceOf(A) },
    { target: TOKEN, allowFailure: true, callData: encodeBalanceOf(B) },
  ];
  const encoded = encodeAggregate3(calls);
  assert.ok(encoded.startsWith('82ad56cb'), '选择器应为 aggregate3');
  const args = encoded.slice(8);
  assert.equal(args.slice(0, 64), word(32), '数组偏移');
  assert.equal(args.slice(64, 128), word(2), '数组长度');
  // 两个元素的偏移分别指向紧跟在偏移表之后的两段结构体。
  assert.equal(args.slice(128, 192), word(64));
  assert.equal(args.slice(192, 256), word(64 + 192));
  // 第一段结构体：target、allowFailure、bytes 偏移、bytes 长度。
  const first = args.slice(256, 256 + 64 * 6);
  assert.equal(first.slice(0, 64), word(TOKEN));
  assert.equal(first.slice(64, 128), word(1));
  assert.equal(first.slice(128, 192), word(96));
  assert.equal(first.slice(192, 256), word(36));
  assert.equal(first.slice(256, 256 + 72), encodeBalanceOf(A));
});
test('解码逐条还原成功位和返回值', () => {
  const rows = decodeAggregate3(encodeResults([ok(7), failed, ok(0)]), 3);
  assert.equal(rows.length, 3);
  assert.equal(decodeUint(rows[0].data), 7n);
  assert.equal(rows[1].success, false);
  assert.equal(decodeUint(rows[1].data), null, '空返回不能当成 0');
  assert.equal(decodeUint(rows[2].data), 0n);
});
test('条数对不上或响应被截断时报错，而不是给出半份答案', () => {
  assert.throws(
    () => decodeAggregate3(encodeResults([ok(1)]), 2),
    /返回 1 条，本批请求 2 条/,
  );
  assert.throws(() => decodeAggregate3('0x1234', 1), /截断/);
});
// 一次扫描的最小可控环境：请求函数按调用顺序回答。
function harness({ balances = {}, decimals = 18, chunkSize = 400 } = {}) {
  const calls = [];
  const request = async (url, body) => {
    calls.push({ url, body });
    if (Array.isArray(body))
      return [
        { id: 1, result: '0x1237' },
        { id: 2, result: '0x10' },
        { id: 3, result: '0x6080' },
      ];
    const data = body.params[0].data.slice(10);
    const count = Number(BigInt(`0x${data.slice(64, 128)}`));
    const rows = [];
    for (let i = 0; i < count; i++) {
      // 元素偏移是相对"长度字之后"的，也就是从第 128 个十六进制字符算起。
      const item =
        128 + Number(BigInt(`0x${data.slice(128 + i * 64, 192 + i * 64)}`)) * 2;
      const selector = data.slice(item + 64 * 4, item + 64 * 4 + 8);
      if (selector === '313ce567') {
        rows.push(decimals === null ? failed : ok(decimals));
        continue;
      }
      const wallet = `0x${data.slice(item + 64 * 4 + 32, item + 64 * 4 + 72)}`;
      const value = balances[wallet];
      rows.push(value === undefined ? failed : ok(value));
    }
    return { id: body.id, result: encodeResults(rows) };
  };
  return { calls, request, chunkSize };
}
// 一页币加一份名单，也就是这一列平时真正要发的那种请求。
const sweep = (tokenCount = 40, walletCount = 94) => ({
  tokens: Array.from({ length: tokenCount }, (_, i) => ({
    id: `robinhood:token${i}`,
    address: TOKEN,
  })),
  wallets: Array.from({ length: walletCount }, (_, i) =>
    i === 0 ? A : `0x${String(i + 1).padStart(40, '0')}`,
  ),
});
test('一次扫描把整页币和整份名单压进很少几个请求', async () => {
  const { calls, request } = harness({
    balances: { [A]: 5n * 10n ** 18n, [B]: 0n },
  });
  const r = await readTrackedHoldings({
    chain: 'robinhood',
    ...sweep(),
    request,
  });
  // 40 × 94 个 balanceOf 加 40 个 decimals，一次链头，其余按请求体大小装箱。
  assert.ok(calls.length <= 16, `${calls.length} 个请求，比预期多`);
  assert.equal(r.requests, calls.length);
  assert.equal(r.block, 16);
  assert.equal(r.failedChunks, 0);
});
test('每一个请求体都留在上限之内，装多少条由字节数决定', async () => {
  // 这一列在 Arc 上一直空着，就是因为这里从来没有人量过请求体：按条数装箱的
  // 400 条是一个 175KB 的 POST，而端点在 131072 字节就整个拒收——每一轮都拒，
  // 不是偶尔拒。所以要钉住的是字节数，不是条数。
  const oneCall = bodyBytes({ callData: encodeBalanceOf(A) });
  assert.equal(oneCall, 448);
  assert.ok(CHUNK * oneCall > 131072, '旧的 400 条装箱本来就超出常见端点的上限');
  const { calls, request } = harness({ balances: { [A]: 1n } });
  await readTrackedHoldings({ chain: 'robinhood', ...sweep(), request });
  for (const call of calls.slice(1)) {
    const bytes = JSON.stringify(call.body).length;
    assert.ok(bytes <= MAX_BODY, `请求体 ${bytes} 字节，超过上限 ${MAX_BODY}`);
  }
});
test('条数上限和字节上限各管各的，谁先到就听谁的', () => {
  const call = { callData: encodeBalanceOf(A) };
  const many = Array.from({ length: 1000 }, () => call);
  // 字节先到：一批装不下 CHUNK 条。
  assert.ok(packChunks(many)[0].length < CHUNK);
  // 条数先到：把字节上限放宽，条数上限仍然生效，因为它管的是节点要算多少 gas。
  assert.equal(packChunks(many, Infinity)[0].length, CHUNK);
  // 一条就超出上限的调用仍然发出去，由节点去说，而不是在这里悄悄丢掉。
  assert.deepEqual(packChunks([call, call], 1), [[call], [call]]);
  assert.equal(packChunks([]).length, 0);
});
test('余额固定在同一个区块上读，一屏数字说的是同一个瞬间', async () => {
  const { calls, request } = harness({ balances: { [A]: 1n } });
  await readTrackedHoldings({
    chain: 'robinhood',
    tokens: [{ id: 'robinhood:t', address: TOKEN }],
    wallets: [A, B],
    request,
  });
  for (const call of calls.slice(1)) {
    assert.equal(call.body.params[1], '0x10', '每一批都钉在同一个区块');
    assert.equal(call.body.params[0].to, MULTICALL3);
  }
});
test('只有余额大于 0 的地址算命中，读到 0 的算已查未持有', async () => {
  const { request } = harness({ balances: { [A]: 3n * 10n ** 18n, [B]: 0n } });
  const r = await readTrackedHoldings({
    chain: 'robinhood',
    tokens: [{ id: 'robinhood:t', address: TOKEN }],
    wallets: [A, B],
    request,
  });
  const row = r.tokens['robinhood:t'];
  assert.equal(row.status, 'ok');
  assert.equal(row.unknown, 0);
  assert.deepEqual(row.hits, [{ wallet: A, raw: '3000000000000000000' }]);
});
test('调用失败的地址记成未核验，不会被当作余额为 0', async () => {
  // B 不在 balances 里，模拟 balanceOf revert 的非标准代币。
  const { request } = harness({ balances: { [A]: 1n } });
  const r = await readTrackedHoldings({
    chain: 'robinhood',
    tokens: [{ id: 'robinhood:t', address: TOKEN }],
    wallets: [A, B],
    request,
  });
  const row = r.tokens['robinhood:t'];
  assert.equal(row.status, 'partial');
  assert.equal(row.unknown, 1);
  assert.equal(row.hits.length, 1);
});
test('端点嫌请求太大时对半拆开重问，并记住它的上限', async () => {
  bodyLimits.clear();
  const inner = harness({ balances: { [A]: 1n } });
  const seen = [];
  // 一个比默认上限严得多的端点：超过 20KB 就整个拒收。
  const request = async (url, body) => {
    if (Array.isArray(body)) return inner.request(url, body);
    const bytes = JSON.stringify(body).length;
    seen.push(bytes);
    if (bytes > 20000)
      throw new Error('HTTP 413 · Request too large. This endpoint accepts at most 20000 bytes.');
    return inner.request(url, body);
  };
  const args = { chain: 'robinhood', ...sweep(2, 60), request };
  const first = await readTrackedHoldings(args);
  // 拆到装得下为止，没有一个地址是因为请求发不出去而落下的。
  assert.equal(first.failedChunks, 0);
  assert.equal(first.error, null);
  assert.equal(first.tokens['robinhood:token0'].unreached, 0);
  assert.deepEqual(first.tokens['robinhood:token0'].hits, [
    { wallet: A, raw: '1' },
  ]);
  assert.ok(
    seen.some((b) => b > 20000),
    '第一次确实撞上了上限',
  );
  // 记住之后，下一轮一开始就按装得下的大小发，不再白撞一次。
  seen.length = 0;
  bodyLimits.set(rpcFor('robinhood'), bodyLimits.get(rpcFor('robinhood')));
  const second = await readTrackedHoldings(args);
  assert.equal(second.failedChunks, 0);
  assert.equal(
    seen.every((b) => b <= 20000),
    true,
    '上限已经学到了，不该再发一个必然被拒的请求',
  );
  bodyLimits.clear();
});
test('偶发失败会再问一次，而不是当场把这个币判成未核验', async () => {
  bodyLimits.clear();
  const inner = harness({ balances: { [A]: 7n } });
  let flaked = false;
  const request = async (url, body) => {
    if (!Array.isArray(body) && !flaked) {
      // 实测中这个端点大约每五个请求丢一个，掉一批就是一整格空白。
      flaked = true;
      throw new Error('HTTP 503 · 节点暂时不可用');
    }
    return inner.request(url, body);
  };
  const r = await readTrackedHoldings({
    chain: 'robinhood',
    tokens: [{ id: 'robinhood:t', address: TOKEN }],
    wallets: [A, B],
    request,
  });
  assert.equal(r.failedChunks, 0);
  assert.equal(r.error, null);
  assert.equal(r.tokens['robinhood:t'].status, 'partial');
  assert.deepEqual(r.tokens['robinhood:t'].hits, [{ wallet: A, raw: '7' }]);
  // 重试也是一次真实的请求，计数要算上，否则面板上的次数对不上实际发出的量。
  assert.equal(r.requests, 3);
});
test('没送达的地址和合约拒绝的地址分开计数，不共用一句解释', async () => {
  bodyLimits.clear();
  const inner = harness({ balances: { [A]: 1n } });
  // 第一个币整批发不出去，第二个币读到了、但 B 的 balanceOf 被合约拒绝。
  const request = async (url, body) => {
    if (!Array.isArray(body) && body.params[0].data.includes(A.slice(2)))
      throw new Error('HTTP 503 · 节点暂时不可用');
    return inner.request(url, body);
  };
  const r = await readTrackedHoldings({
    chain: 'robinhood',
    tokens: [{ id: 'robinhood:t', address: TOKEN }],
    wallets: [A, B],
    request,
    maxBody: 1200,
  });
  const row = r.tokens['robinhood:t'];
  // A 的那一批一直没送达，B 的送达了但合约没答。两者都不是余额 0，理由却不同。
  assert.equal(row.unknown, 2);
  assert.equal(row.unreached, 1, 'A 从来没有被问过，不能算成这个币不标准');
});
test('整批请求失败时该币标成未核验，而不是 0 命中', async () => {
  const request = async (url, body) => {
    if (Array.isArray(body))
      return [
        { id: 1, result: '0x1237' },
        { id: 2, result: '0x10' },
        { id: 3, result: '0x6080' },
      ];
    throw new Error('节点超时');
  };
  const r = await readTrackedHoldings({
    chain: 'robinhood',
    tokens: [{ id: 'robinhood:t', address: TOKEN }],
    wallets: [A, B],
    request,
  });
  const row = r.tokens['robinhood:t'];
  assert.equal(row.status, 'unchecked');
  assert.equal(row.unknown, 2);
  assert.equal(r.failedChunks, 1);
  assert.match(r.error, /节点超时/);
});
test('decimals 只读一次，之后一直复用', async () => {
  const decimals = new Map();
  const first = harness({ balances: { [A]: 1n }, decimals: 6 });
  const token = [{ id: 'robinhood:t', address: TOKEN }];
  await readTrackedHoldings({
    chain: 'robinhood',
    tokens: token,
    wallets: [A],
    request: first.request,
    decimals,
  });
  assert.equal(decimals.get('robinhood:t'), 6);
  const again = harness({ balances: { [A]: 1n }, decimals: null });
  await readTrackedHoldings({
    chain: 'robinhood',
    tokens: token,
    wallets: [A],
    request: again.request,
    decimals,
  });
  // 第二次的批里只剩一条 balanceOf，没有再问一次 decimals。
  const data = again.calls[1].body.params[0].data.slice(10);
  assert.equal(Number(BigInt(`0x${data.slice(64, 128)}`)), 1);
  assert.equal(decimals.get('robinhood:t'), 6);
});
test('链 ID 对不上就拒绝，不把别的链的余额当成这条链的', async () => {
  const request = async () => [
    { id: 1, result: '0x1' },
    { id: 2, result: '0x10' },
    { id: 3, result: '0x6080' },
  ];
  await assert.rejects(
    readTrackedHoldings({
      chain: 'robinhood',
      tokens: [{ id: 'robinhood:t', address: TOKEN }],
      wallets: [A],
      request,
    }),
    /链 ID 与所选链不一致/,
  );
});
test('没有 Multicall3 的链直接说清楚，而不是解码出一堆空结果', async () => {
  const request = async () => [
    { id: 1, result: '0x1237' },
    { id: 2, result: '0x10' },
    { id: 3, result: '0x' },
  ];
  await assert.rejects(
    readTrackedHoldings({
      chain: 'robinhood',
      tokens: [{ id: 'robinhood:t', address: TOKEN }],
      wallets: [A],
      request,
    }),
    /没有 Multicall3/,
  );
});
test('未配置 RPC 的链和 Solana 都给出可操作的说明', async () => {
  const args = {
    tokens: [{ id: 'eth:t', address: TOKEN }],
    wallets: [A],
    request: async () => {
      throw new Error('不该发出请求');
    },
  };
  delete process.env.ETH_RPC_URL;
  assert.equal(rpcFor('eth'), null);
  await assert.rejects(
    readTrackedHoldings({ chain: 'eth', ...args }),
    /ETH_RPC_URL/,
  );
  await assert.rejects(
    readTrackedHoldings({ chain: 'sol', ...args }),
    /Solana 不走 EVM 调用/,
  );
});
