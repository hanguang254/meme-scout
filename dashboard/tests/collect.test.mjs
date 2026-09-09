import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collect,
  carriedSource,
  noteBreaker,
  breakerOpenUntil,
  resetBreakers,
  gmgnGate,
  gmgnPace,
  noteGmgnLimit,
  resetGmgnPace,
  cooldownUntil,
} from '../scanner/providers.mjs';
import { evaluateRisk } from '../scanner/risk.mjs';

const address = `0x${'1'.repeat(40)}`;
const candidate = { id: `robinhood:${address}`, chain: 'robinhood', address };

const priorSource = (key, name, over = {}) => ({
  key,
  name,
  url: 'https://gmgn.ai',
  status: 'ok',
  fetchedAt: '2026-09-08T12:00:00.000Z',
  latency: 900,
  ...over,
});

test('slow-lane evidence is carried with the timestamp of the fetch that produced it', () => {
  const previous = {
    raw: { security: { privileges: ['mint'] } },
    sources: [priorSource('security', 'GMGN 合约')],
  };
  const kept = carriedSource(previous, 'security');
  assert.deepEqual(kept.data, { privileges: ['mint'] });
  assert.equal(kept.reused, true);
  assert.equal(
    kept.fetchedAt,
    '2026-09-08T12:00:00.000Z',
    '沿用的证据必须保留原始取得时间，不能盖成本次时间',
  );
});

test('a source that failed last time is fetched again, not inherited as a result', () => {
  for (const status of ['error', 'unconfigured']) {
    const previous = {
      raw: { security: undefined },
      sources: [priorSource('security', 'GMGN 合约', { status })],
    };
    assert.equal(carriedSource(previous, 'security'), null);
  }
  // Data present but the entry recorded a failure: still not carried.
  assert.equal(
    carriedSource(
      {
        raw: { security: { privileges: [] } },
        sources: [priorSource('security', 'GMGN 合约', { status: 'error' })],
      },
      'security',
    ),
    null,
    '上次失败的项不应被当作已核验结果沿用',
  );
});

test('only the slow lane is carried, and only when the entry can be identified', () => {
  const previous = {
    raw: { holders: [{ a: 1 }], info: { symbol: 'X' }, security: { p: 1 } },
    sources: [
      priorSource('holders', 'GMGN 持有人'),
      priorSource('info', 'GMGN 基本信息'),
      priorSource('security', 'GMGN 合约'),
    ],
  };
  assert.equal(carriedSource(previous, 'holders'), null, '持有人分布必须重取');
  assert.equal(carriedSource(previous, 'info'), null, '盘面数据必须重取');
  assert.ok(carriedSource(previous, 'security'));

  // Reports written before source entries carried a key cannot be matched up.
  assert.equal(
    carriedSource(
      { raw: { security: { p: 1 } }, sources: [{ name: 'GMGN 合约', status: 'ok' }] },
      'security',
    ),
    null,
    '无法定位来源条目时应重取而不是猜测',
  );
  assert.equal(carriedSource(null, 'security'), null);
});

test('a failing source is dropped after repeated failures and reported as unavailable', async () => {
  resetBreakers();
  const originalFetch = globalThis.fetch;
  let explorerCalls = 0;
  globalThis.fetch = async (u) => {
    if (u.includes('blockscout')) {
      explorerCalls++;
      return new Response('forbidden', { status: 403 });
    }
    return new Response('{}', { status: 500 });
  };
  try {
    for (let i = 0; i < 3; i++) await collect(candidate);
    assert.equal(explorerCalls, 3, '熔断前应如实重试');
    assert.ok(breakerOpenUntil('blockscout') > Date.now(), '连续失败后应熔断');

    const r = await collect(candidate);
    assert.equal(explorerCalls, 3, '熔断后不应继续请求');
    const explorer = r.sources.find((s) => s.key === 'explorer');
    assert.equal(explorer.status, 'error');
    assert.match(
      explorer.error,
      /暂停请求至/,
      '熔断必须说明原因，不能显示成已核验',
    );
    assert.equal(explorer.data, null, '熔断的来源不得提供数据');
  } finally {
    globalThis.fetch = originalFetch;
    resetBreakers();
  }
});

test('a single success clears the failure run', () => {
  resetBreakers();
  noteBreaker('x', false);
  noteBreaker('x', false);
  noteBreaker('x', true);
  noteBreaker('x', false);
  noteBreaker('x', false);
  assert.equal(breakerOpenUntil('x'), 0, '成功后不应保留之前的失败计数');
  noteBreaker('x', false);
  assert.ok(breakerOpenUntil('x') > Date.now());
  resetBreakers();
});

test('sources are reported in a fixed order regardless of which lane finishes first', async () => {
  resetBreakers();
  const originalFetch = globalThis.fetch;
  // The RPC answers slowly and GoPlus instantly, so completion order and
  // display order disagree unless the report imposes its own order.
  globalThis.fetch = async (u) => {
    if (u.includes('rpc.mainnet'))
      await new Promise((r) => setTimeout(r, 60));
    return new Response('{}', { status: 500 });
  };
  try {
    const r = await collect(candidate);
    const keys = r.sources.map((s) => s.key);
    assert.deepEqual(
      keys,
      ['info', 'goplus', 'explorer', 'contract', 'social'],
      '来源顺序不应随并行完成顺序变化',
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetBreakers();
  }
});

test('collect reports how many rate-limited calls it actually spent', async () => {
  resetBreakers();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    const r = await collect(candidate);
    // info is attempted and fails without a key, so the chain stops there.
    assert.equal(r.gmgnCalls, 1, '花掉的调用数必须如实上报给调度');
  } finally {
    globalThis.fetch = originalFetch;
    resetBreakers();
  }
});

test('the rate limiter spaces calls by their start times, not by a flat sleep', () => {
  resetGmgnPace();
  const t = 1_000_000;
  const target = gmgnPace().target;
  const interval = 60000 / target;
  assert.equal(gmgnGate(t), 0, '第一次调用不应等待');
  assert.equal(
    Math.round(gmgnGate(t)),
    Math.round(interval),
    '紧接着的第二次调用要等满一个间隔',
  );
  // A call that took longer than the interval has already paid for it.
  assert.equal(
    gmgnGate(t + 3 * interval),
    0,
    '来源答得慢时不应在已经过去的时间上再睡一次',
  );
  resetGmgnPace();
});

test('a rate limit lowers the pace for the rest of the session and says when', () => {
  resetGmgnPace();
  const before = gmgnPace();
  assert.equal(before.current, before.target);
  assert.equal(before.reducedAt, null);

  const t = 1_700_000_000_000;
  noteGmgnLimit(t);
  const after = gmgnPace();
  assert.ok(after.current < after.target, '撞到限流后速率必须降下来');
  assert.equal(after.reducedAt, new Date(t).toISOString());
  assert.equal(cooldownUntil('gmgn'), t + 300000, '限流同时要进入冷却');
  const later = t + 1e9;
  gmgnGate(later);
  assert.equal(
    Math.round(gmgnGate(later)),
    Math.round(60000 / after.current),
    '降速后的间隔要按新速率算',
  );

  // Recovering on its own would walk straight back into the same limit.
  noteGmgnLimit(t + 600000);
  assert.equal(
    gmgnPace().reducedAt,
    new Date(t).toISOString(),
    '再次限流不应覆盖首次降速时间，也不应逐次加码',
  );
  assert.equal(cooldownUntil('gmgn'), t + 900000, '每次限流都要重新计冷却');
  resetGmgnPace();
  assert.equal(gmgnPace().current, gmgnPace().target);
  assert.equal(cooldownUntil('gmgn'), 0);
});

test('a deferred check is reported as unchecked with its reason, never as a pass', () => {
  const candidate = { id: 'sol:x', chain: 'sol', address: 'x', symbol: 'X' };
  const sources = [
    { key: 'info', name: 'GMGN 基本信息', status: 'ok', fetchedAt: '' },
    {
      key: 'holders',
      name: 'GMGN 持有人',
      status: 'deferred',
      fetchedAt: '',
      error: '首扫优先取得合约权限，本项留到下一轮补齐',
    },
    {
      key: 'dev',
      name: 'GMGN 开发者',
      status: 'deferred',
      fetchedAt: '',
      error: '首扫优先取得合约权限，本项留到下一轮补齐',
    },
  ];
  const r = evaluateRisk(candidate, { info: { symbol: 'X' } }, sources);
  for (const id of ['holders', 'dev']) {
    const f = r.findings.find((x) => x.id === id);
    assert.equal(f.severity, 'unknown', `${id} 未取得时不能判成已通过`);
    assert.match(
      f.detail,
      /下一轮补齐/,
      `${id} 必须说明是本机延后取的，而不是来源没返回`,
    );
  }
  assert.ok(
    !['holders', 'dev'].some((g) =>
      r.findings.some((f) => f.group === g && f.severity !== 'unknown'),
    ),
    '延后的类目不得计入已有证据的覆盖数',
  );
});
