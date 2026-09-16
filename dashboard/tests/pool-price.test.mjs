import test from 'node:test';
import assert from 'node:assert/strict';
import {
  poolVersion,
  v4Manager,
  v4StateSlot,
  freshen,
  readPoolPrices,
  PRICE_GUARD,
} from '../scanner/pool-price.mjs';
import { MULTICALL3 } from '../scanner/tracked-balances.mjs';
import { keccakHex } from '../scanner/keccak.mjs';

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
const okHex = (hex) => ({ success: true, data: `0x${hex}` });
const failed = { success: false, data: '0x' };
const addr = (n) => `0x${String(n).repeat(40)}`;
const BASE = addr(1); // 0x111… sorts below
const QUOTE = addr(2); // 0x222… sorts above
const POOL = addr(9);
const POOL_ID = `0x${'ab'.repeat(32)}`;
const BLOCK = 1234567;
// sqrtPriceX96 for a price of exactly 1.0 between two 18-decimal tokens.
const SQRT_ONE = 2n ** 96n;
// A fake node. It answers the sub-calls in the order readPoolPrices assembles
// them — block first, then the decimals and token0 reads it still needs, then
// one state read per pool — and decodeAggregate3 rejects a batch whose length
// does not match, so a test that lists the wrong calls fails rather than drifts.
const node = (rows) => async (_rpc, body) => {
  assert.equal(body.method, 'eth_call');
  assert.equal(body.params[0].to, MULTICALL3);
  assert.equal(body.params[1], 'latest');
  return { result: encodeResults(rows) };
};
// A chain that has an endpoint but no V4 deployment registered, which is the
// only way to reach the manager branch. Set per test and restored after, so no
// test depends on what the machine running it happens to have configured.
const withRpc = async (url, body) => {
  const had = Object.hasOwn(process.env, 'BSC_RPC_URL');
  const old = process.env.BSC_RPC_URL;
  if (url) process.env.BSC_RPC_URL = url;
  else delete process.env.BSC_RPC_URL;
  try {
    return await body();
  } finally {
    if (had) process.env.BSC_RPC_URL = old;
    else delete process.env.BSC_RPC_URL;
  }
};

test('版本只从来源真的说了的东西里读出来', () => {
  // A 32-byte id is a V4 pool; a 20-byte value is a contract and needs a label.
  assert.equal(poolVersion(POOL_ID, []), 'v4');
  assert.equal(poolVersion(POOL, ['v3']), 'v3');
  assert.equal(poolVersion(POOL, ['v2']), 'v2');
  // The two sources spell the same fact differently and both must be read.
  assert.equal(poolVersion(POOL, ['uniswap-v3-arc']), 'v3');
  assert.equal(poolVersion(POOL, ['Uniswap V2']), 'v2');
  // No label is no answer. Guessing a version reads the wrong storage layout
  // and returns a number that looks entirely reasonable.
  assert.equal(poolVersion(POOL, []), null);
  assert.equal(poolVersion(POOL, ['uniswap']), null);
  // Bounded on both sides, so neither a longer version nor a word ending in
  // the same two characters can match.
  assert.equal(poolVersion(POOL, ['v30']), null);
  assert.equal(poolVersion(POOL, ['xv2']), null);
  // A v4 label on a contract address contradicts itself and stays unresolved.
  assert.equal(poolVersion(POOL, ['v4']), null);
  assert.equal(poolVersion('not-an-address', ['v3']), null);
  assert.equal(poolVersion(null, ['v3']), null);
});

test('V4 的存储槽是按 mapping 规则算出来的，不是抄来的常量', () => {
  assert.equal(
    v4StateSlot(POOL_ID),
    keccakHex('ab'.repeat(32) + word(6)),
    'pools 是 PoolManager 的第 6 号 mapping',
  );
  // Sources publish ids in mixed case; the slot must not depend on it.
  assert.equal(v4StateSlot(`0x${'AB'.repeat(32)}`), v4StateSlot(POOL_ID));
  // A per-chain deployment, so a chain nobody checked has no address here.
  assert.equal(v4Manager('arc'), v4Manager('robinhood'));
  assert.equal(v4Manager('bsc'), null);
});

test('链上价按比例套到来源的数上，供应量口径不动', () => {
  const quote = { price: 2, priceNative: 0.001, marketCap: 1000, fdv: 4000 };
  const fresh = freshen(quote, { price: 0.0011, block: 9, version: 'v3' });
  assert.equal(fresh.rejected, false);
  assert.ok(Math.abs(fresh.ratio - 1.1) < 1e-12);
  assert.ok(Math.abs(fresh.price - 2.2) < 1e-12);
  assert.ok(Math.abs(fresh.marketCap - 1100) < 1e-9);
  assert.ok(Math.abs(fresh.fdv - 4400) < 1e-9);
  assert.equal(fresh.block, 9);
  assert.equal(fresh.version, 'v3');
});

test('来源没公布的市值不会被放大成一个数', () => {
  // Scaling a missing value would manufacture a market cap out of a price move.
  const fresh = freshen(
    { price: 2, priceNative: 1, marketCap: null, fdv: undefined },
    { price: 2, block: 1, version: 'v2' },
  );
  assert.equal(fresh.rejected, false);
  assert.equal(fresh.marketCap, null);
  assert.equal(fresh.fdv, null);
});

test('链上价和来源价差得离谱就不采用，保留来源的数', () => {
  const quote = { price: 1, priceNative: 1, marketCap: 100 };
  const far = freshen(quote, { price: PRICE_GUARD + 1, block: 1, version: 'v3' });
  assert.equal(far.rejected, true);
  assert.equal(far.marketCap, undefined, '被拒绝时不能给出任何新数字');
  assert.equal(far.price, undefined);
  assert.match(far.reason, /不采用/);
  // The same distance the other way is the same mistake, seen from the far side.
  const tiny = freshen(quote, { price: 1 / (PRICE_GUARD + 1), version: 'v3' });
  assert.equal(tiny.rejected, true);
  // Just inside the guard is applied: a real move over the source's lag looks
  // nothing like a decimals or token-order error, which is what this catches.
  const near = freshen(quote, { price: PRICE_GUARD - 0.01, version: 'v3' });
  assert.equal(near.rejected, false);
});

test('缺一半的报价不参与换算，而不是当成零', () => {
  const on = { price: 1, block: 1, version: 'v3' };
  assert.equal(freshen({ price: 2 }, on), null, '没有 priceNative 就没有比值');
  assert.equal(freshen({ price: 0, priceNative: 1 }, on), null);
  assert.equal(freshen({ price: 2, priceNative: 0 }, on), null);
  assert.equal(freshen({ price: 2, priceNative: 1 }, null), null);
  assert.equal(freshen({ price: 2, priceNative: 1 }, { price: 0 }), null);
});

test('没有 RPC 的链不发请求，每个池都留下可读的原因', async () => {
  let called = false;
  const r = await withRpc(null, () =>
    readPoolPrices({
      chain: 'bsc',
      pools: [{ key: 'a', pool: POOL, version: 'v3', base: BASE, quote: QUOTE }],
      request: async () => {
        called = true;
        return {};
      },
    }),
  );
  assert.equal(called, false, '没有端点时不应该发出请求');
  assert.equal(r.supported, false);
  assert.equal(r.prices.size, 0);
  // Actionable: it names the variable to set rather than just refusing.
  assert.match(r.skipped.get('a'), /BSC_RPC_URL/);
  // Solana can never have one, so it must not be sent looking for a setting
  // that does not exist.
  const sol = await readPoolPrices({
    chain: 'sol',
    pools: [{ key: 'a', pool: POOL, version: 'v3', base: BASE, quote: QUOTE }],
    request: async () => ({}),
  });
  assert.equal(sol.supported, false);
  assert.match(sol.skipped.get('a'), /不是 EVM/);
  assert.equal(/RPC_URL/.test(sol.skipped.get('a')), false);
});

test('读不了的池各自说明原因，读得了的照常读出价格', async () => {
  const r = await withRpc('https://bsc.example.invalid', () =>
    readPoolPrices({
      chain: 'bsc',
      pools: [
        { key: 'nover', pool: POOL, version: null, base: BASE, quote: QUOTE },
        { key: 'v4here', pool: POOL_ID, version: 'v4', base: BASE, quote: QUOTE },
        { key: 'notok', pool: POOL, version: 'v3', base: BASE, quote: null },
        { key: 'good', pool: addr(8), version: 'v3', base: BASE, quote: QUOTE },
      ],
      // Three are dropped before the call, so the batch is only `good`'s:
      // block, two decimals, token0, state.
      request: node([
        ok(BLOCK),
        ok(18),
        ok(18),
        okHex(word(BigInt(BASE))),
        okHex(word(SQRT_ONE)),
      ]),
    }),
  );
  assert.equal(r.skipped.get('nover'), '来源未标明池版本，无法链上读取');
  assert.match(r.skipped.get('v4here'), /未登记 Uniswap V4/);
  assert.equal(r.skipped.get('notok'), '池的两种代币地址不完整');
  assert.ok(Math.abs(r.prices.get('good').price - 1) < 1e-9);
});

test('同一个键出现两次直接报错，而不是把别人的价格记到这个币上', async () => {
  await assert.rejects(
    readPoolPrices({
      chain: 'robinhood',
      pools: [
        { key: 'same', pool: POOL, version: 'v3', base: BASE, quote: QUOTE },
        { key: 'same', pool: addr(8), version: 'v3', base: BASE, quote: QUOTE },
      ],
      request: async () => ({}),
    }),
    /重复的键/,
  );
});

test('V3 池解出的价格分清了代币在哪一侧', async () => {
  const read = (base, quote) =>
    readPoolPrices({
      chain: 'robinhood',
      pools: [{ key: 'k', pool: POOL, version: 'v3', base, quote }],
      meta: new Map(),
      request: node([
        ok(BLOCK),
        ok(18),
        ok(18),
        // token0 is BASE in both readings — the pool is the same pool.
        okHex(word(BigInt(BASE))),
        // sqrtPriceX96 for a token0-in-token1 price of 4.
        okHex(word(SQRT_ONE * 2n)),
      ]),
    });
  const asToken0 = await read(BASE, QUOTE);
  assert.equal(asToken0.supported, true);
  assert.equal(asToken0.block, BLOCK);
  assert.equal(asToken0.requests, 1, '一轮只发一次请求');
  assert.equal(asToken0.prices.get('k').version, 'v3');
  assert.equal(asToken0.prices.get('k').pool, POOL);
  assert.ok(Math.abs(asToken0.prices.get('k').price - 4) < 1e-9);
  // Same pool, same numbers, candidate on the other side: the price inverts.
  // Getting this backwards is off by the square of the price, which is exactly
  // the size of error the guard in freshen() exists to reject.
  const asToken1 = await read(QUOTE, BASE);
  assert.ok(Math.abs(asToken1.prices.get('k').price - 0.25) < 1e-9);
});

test('V2 池按储备比算，并按两种代币的精度校正', async () => {
  const r = await readPoolPrices({
    chain: 'robinhood',
    // A 6-decimal quote token against an 18-decimal base.
    pools: [{ key: 'k', pool: POOL, version: 'v2', base: BASE, quote: QUOTE }],
    request: node([
      ok(BLOCK),
      ok(18),
      ok(6),
      okHex(word(BigInt(BASE))),
      okHex(word(2n * 10n ** 18n) + word(6n * 10n ** 6n)),
    ]),
  });
  // 6 quote units per 2 base units is 3, once the decimals cancel. Ignoring
  // them would report 3e-12 and lose the coin's market cap by twelve orders.
  assert.ok(Math.abs(r.prices.get('k').price - 3) < 1e-9);
  assert.equal(r.prices.get('k').version, 'v2');
});

test('V4 池从单例的存储字里取低 160 位', async () => {
  // The packed word carries the tick and the fees above sqrtPriceX96; reading
  // the whole word would square an enormous number into a plausible price.
  const packed = (12345n << 160n) | SQRT_ONE;
  const r = await readPoolPrices({
    chain: 'arc',
    pools: [{ key: 'k', pool: POOL_ID, version: 'v4', base: BASE, quote: QUOTE }],
    // No token0() in this batch: a V4 pool's order comes from the address sort.
    request: node([ok(BLOCK), ok(18), ok(18), okHex(word(packed))]),
  });
  assert.ok(Math.abs(r.prices.get('k').price - 1) < 1e-9);
  assert.equal(r.prices.get('k').version, 'v4');
});

test('精度或状态没读到就留原因，不拿默认值顶上', async () => {
  const rows = [ok(BLOCK), ok(18), ok(18), okHex(word(BigInt(BASE)))];
  const read = (request) =>
    readPoolPrices({
      chain: 'robinhood',
      pools: [{ key: 'k', pool: POOL, version: 'v3', base: BASE, quote: QUOTE }],
      meta: new Map(),
      request,
    });
  // Assuming 18 here is how a 6-decimal token gets priced a million times off.
  const noDecimals = await read(
    node([ok(BLOCK), failed, ...rows.slice(2), okHex(word(SQRT_ONE))]),
  );
  assert.equal(noDecimals.prices.size, 0);
  assert.equal(noDecimals.skipped.get('k'), '代币精度未读到');
  const noState = await read(node([...rows, failed]));
  assert.equal(noState.skipped.get('k'), '池状态本轮未读到');
  // A pool that has never traded reports a zero sqrt price, which is not a
  // price of zero — it is no price at all.
  const empty = await read(node([...rows, ok(0)]));
  assert.equal(empty.skipped.get('k'), '池状态解出的价格不可用');
});

test('不变的东西只读一次，之后一直复用', async () => {
  const meta = new Map();
  const pools = [{ key: 'k', pool: POOL, version: 'v3', base: BASE, quote: QUOTE }];
  let sent = '';
  const spy = (rows) => async (rpc, body) => {
    sent = body.params[0].data;
    return node(rows)(rpc, body);
  };
  await readPoolPrices({
    chain: 'robinhood',
    pools,
    meta,
    request: spy([
      ok(BLOCK),
      ok(18),
      ok(18),
      okHex(word(BigInt(BASE))),
      okHex(word(SQRT_ONE)),
    ]),
  });
  const first = sent.length;
  assert.equal(meta.get(`dec:${BASE.slice(2)}`), 18);
  assert.equal(meta.get(`t0:${POOL.slice(2)}`), BASE);
  // Second sweep: decimals and token order cannot have changed, so the batch
  // is the block and one state read. Listing only two results proves it —
  // decodeAggregate3 throws when the count disagrees with the batch.
  const r = await readPoolPrices({
    chain: 'robinhood',
    pools,
    meta,
    request: spy([ok(BLOCK + 1), okHex(word(SQRT_ONE))]),
  });
  assert.ok(sent.length < first, '第二轮的 calldata 必须更短');
  assert.equal(r.block, BLOCK + 1);
  assert.ok(Math.abs(r.prices.get('k').price - 1) < 1e-9);
});
