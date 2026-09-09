import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../scanner/monitor.mjs';

const candidate = {
  id: 'sol:test',
  chain: 'sol',
  address: 'test',
  symbol: 'TEST',
  marketCap: 100000,
  liquidity: 20000,
};
const discovered = {
  candidates: [candidate],
  sources: [{ name: 'GMGN 热门', status: 'ok' }],
};
const okSource = (key, name) => ({
  key,
  name,
  url: 'https://gmgn.ai',
  status: 'ok',
  fetchedAt: new Date().toISOString(),
  data: { ok: true },
});

function setup({ collect, gmgnCooldown, autoSchedule = false }) {
  const m = new Monitor({
    discover: async () => discovered,
    collect,
    gmgnCooldown,
    autoSchedule,
  });
  m.configure({ chain: 'sol', minCap: 1000, maxCap: 1e9, minLiquidity: 1000 });
  return m;
}
// refresh() launches the scan loop without awaiting it.
const settle = async (m) => {
  await m.refresh();
  await m.scanPromise;
};
// Lets an aged report compete for a rescan the way it would after 180 seconds.
const expire = (m) => {
  m.state.reports[candidate.id].checkedAt = new Date(
    Date.now() - 200000,
  ).toISOString();
  m.scanAttempts.clear();
};

test('a rescan is handed the previous report so slow-lane evidence can be carried', async () => {
  const seen = [];
  const m = setup({
    collect: async (_c, _go, previous) => {
      seen.push(previous);
      return {
        data: { info: { symbol: 'TEST' } },
        sources: [okSource('info', 'GMGN 基本信息')],
        gmgnCalls: 4,
      };
    },
  });
  await settle(m);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], null, '首扫没有可沿用的上一份报告');

  expire(m);
  await m.scan();
  assert.equal(seen.length, 2);
  assert.equal(
    seen[1]?.raw?.info?.symbol,
    'TEST',
    '重扫必须拿到上一份报告才能沿用慢车道证据',
  );
  m.pause();
});

test('the loop adds no pacing of its own to a scan that reached the limiter', async () => {
  const waits = [];
  const originalSetTimeout = globalThis.setTimeout;
  let calls = 4;
  const m = setup({
    collect: async () => ({
      data: {},
      sources: [okSource('info', 'GMGN 基本信息')],
      gmgnCalls: calls,
    }),
    autoSchedule: true,
  });
  // The 60s discovery timer is not a scan gap; only the loop's own pause is.
  globalThis.setTimeout = (fn, ms) => {
    if (ms >= 1000 && ms < 10000) {
      waits.push(ms);
      return originalSetTimeout(fn, 0);
    }
    return originalSetTimeout(fn, ms);
  };
  try {
    await settle(m);
    expire(m);
    calls = 2;
    await m.scan();
    assert.deepEqual(
      waits,
      [],
      '限速由来源限流器按真实调用间隔计量，循环再睡一次只会比设定的速率更慢',
    );

    // A scan that never reached the limiter was never paced by it.
    expire(m);
    calls = 0;
    await m.scan();
    assert.deepEqual(waits, [1000], '没有花掉调用的扫描仍要有下限，避免空转');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    m.pause();
  }
});

test('a rate-limited scan does not overwrite the report it failed to refresh', async () => {
  let limited = false;
  const m = setup({
    collect: async () =>
      limited
        ? {
            data: {},
            sources: [
              {
                key: 'info',
                name: 'GMGN 基本信息',
                url: 'https://gmgn.ai',
                status: 'error',
                fetchedAt: new Date().toISOString(),
                error: 'GMGN 限流，已暂停请求 5 分钟',
                data: null,
              },
            ],
            gmgnCalls: 1,
          }
        : {
            data: { info: { symbol: 'TEST' }, security: { privileges: [] } },
            sources: [
              okSource('info', 'GMGN 基本信息'),
              okSource('security', 'GMGN 合约'),
            ],
            gmgnCalls: 4,
          },
  });
  await settle(m);
  const complete = { ...m.state.reports[candidate.id] };
  assert.ok(complete.raw.security, '首扫应写入完整报告');

  limited = true;
  expire(m);
  const expired = m.state.reports[candidate.id].checkedAt;
  await m.scan();
  const after = m.state.reports[candidate.id];
  assert.equal(
    after.checkedAt,
    expired,
    '限流时不能盖上新的核验时间，否则空报告会伪装成新鲜的',
  );
  assert.ok(after.raw.security, '旧的真实证据必须保留，不能被限流的空壳替换');
  assert.match(m.state.error, /未重查/);
  m.pause();
});

test('scanning waits out a source cooldown instead of burning the queue on it', async () => {
  let scans = 0;
  let until = Date.now() + 300000;
  const originalSetTimeout = globalThis.setTimeout;
  const slept = [];
  const m = setup({
    collect: async () => {
      scans++;
      return {
        data: {},
        sources: [okSource('info', 'GMGN 基本信息')],
        gmgnCalls: 4,
      };
    },
    gmgnCooldown: () => until,
  });
  until = 0;
  await settle(m);
  assert.equal(scans, 1);

  until = Date.now() + 300000;
  expire(m);
  m.autoSchedule = true;
  globalThis.setTimeout = (fn, ms) => {
    if (ms >= 1000) {
      slept.push(ms);
      // The cooldown expires while the loop is asleep on it.
      until = 0;
      return originalSetTimeout(fn, 0);
    }
    return originalSetTimeout(fn, ms);
  };
  try {
    await m.scan();
    assert.ok(slept[0] > 200000, '应睡到冷却结束，而不是逐个候选去撞限流');
    assert.equal(scans, 2, '冷却结束后才继续扫描');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    m.pause();
  }
});

test('a report with a deferred check requeues without waiting out the freshness window', async () => {
  const scans = [];
  let deferred = true;
  const m = setup({
    collect: async (c, _go, previous) => {
      scans.push(previous ? 'rescan' : 'first');
      return {
        data: { info: { symbol: 'TEST' } },
        sources: [
          okSource('info', 'GMGN 基本信息'),
          deferred
            ? {
                key: 'holders',
                name: 'GMGN 持有人',
                url: 'https://gmgn.ai',
                status: 'deferred',
                fetchedAt: new Date().toISOString(),
                error: '首扫优先取得合约权限，本项留到下一轮补齐',
              }
            : okSource('holders', 'GMGN 持有人'),
        ],
        gmgnCalls: 2,
      };
    },
  });
  await settle(m);
  assert.deepEqual(scans, ['first']);

  // Fresh by time, but a category is knowingly missing: it goes back in the queue.
  deferred = false;
  m.scanAttempts.clear();
  await m.scan();
  assert.deepEqual(scans, ['first', 'rescan'], '有延后项的报告应立刻排队补齐');

  // Now complete and fresh: it must wait out the window like any other.
  m.scanAttempts.clear();
  await m.scan();
  assert.equal(scans.length, 2, '补齐后的新鲜报告不应再被重复扫描');
  m.pause();
});
