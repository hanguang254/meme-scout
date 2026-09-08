import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../scanner/monitor.mjs';
import { normalizeTape } from '../scanner/tape.mjs';
const initialNow = 1788658000000;
const row = {
  id: 100,
  ts: initialNow / 1000 - 10,
  side: 'buy',
  token: `0x${'1'.repeat(40)}`,
  wallet: `0x${'2'.repeat(40)}`,
  tx: `0x${'a'.repeat(64)}`,
  symbol: 'LIVE',
  usd: 100,
  price: 0.0001,
  priced: 'cash_leg',
  flags: [],
  is_stock: 0,
};
const normal = {
  id: `robinhood:0x${'3'.repeat(40)}`,
  chain: 'robinhood',
  address: `0x${'3'.repeat(40)}`,
  symbol: 'NORMAL',
  marketCap: 100000,
  liquidity: 20000,
};
function setup(overrides = {}) {
  let now = initialNow,
    events = [row],
    failed = false;
  const m = new Monitor({
    autoSchedule: false,
    clock: () => now,
    discover: async () => ({
      candidates: [normal],
      sources: [{ name: 'GMGN 热门', status: 'ok' }],
    }),
    collect: async () => new Promise(() => {}),
    fetchTape: async () =>
      failed
        ? { status: 'error', error: 'HTTP 429' }
        : {
            status: 'ok',
            fetchedAt: new Date(now).toISOString(),
            data: { events: normalizeTape(events), gap: false },
          },
    resolveTape: async (trades) => ({
      sources: [],
      candidates: trades.map((t) => ({
        id: t.candidateId,
        address: t.address,
        chain: 'robinhood',
        symbol: t.symbol,
        marketCap: 100000,
        liquidity: 20000,
        source: 'Trenches LIVE TAPE',
      })),
    }),
    ...overrides,
  });
  return {
    m,
    setEvents: (v) => {
      events = v;
    },
    advance: (ms) => {
      now += ms;
    },
    fail: () => {
      failed = true;
    },
  };
}
async function tape(m) {
  await m.pollTape();
  await m.resolvePromise;
}
test('a LIVE BUY joins without waiting for the next discovery; repeated polls do not resolve again', async () => {
  const { m } = setup();
  await tape(m);
  assert.equal(m.state.candidates[0].symbol, 'LIVE');
  assert.equal(m.state.candidates[0].lastTrade.usd, 100);
  const quote = m.quoteCache.get(m.state.candidates[0].id);
  await tape(m);
  assert.equal(m.quoteCache.get(m.state.candidates[0].id), quote);
  await m.refresh();
  assert.deepEqual(
    m.state.candidates.map((c) => c.symbol),
    ['LIVE', 'NORMAL'],
  );
  m.pause();
});
test('unknown market caps and out-of-range tokens remain observations, not low-cap candidates', async () => {
  const { m } = setup({
    resolveTape: async (trades) => ({
      sources: [],
      candidates: trades.map((t) => ({
        id: t.candidateId,
        marketCap: null,
        liquidity: 10000,
      })),
    }),
  });
  await tape(m);
  assert.equal(m.state.tape.events.length, 1);
  assert.equal(m.state.candidates.length, 0);
  assert.match(m.summary().tape.events[0].reason, /市值未知/);
  m.pause();
});
test('same-ID anomaly corrections retract live admission; age does not reset on fetch', async () => {
  const { m, setEvents, advance, fail } = setup();
  await tape(m);
  setEvents([{ ...row, flags: ['not a real buy (planted)'] }]);
  await tape(m);
  assert.equal(m.state.candidates.length, 0);
  setEvents([row]);
  await tape(m);
  assert.equal(m.state.candidates.length, 1);
  advance(16 * 60000);
  fail();
  await tape(m);
  assert.equal(m.state.candidates.length, 0);
  assert.equal(m.state.tape.events.length, 1);
  assert.equal(m.state.tape.stale, true);
  m.pause();
});
test('a quote response after changing chain cannot write old live candidates', async () => {
  let release;
  const { m } = setup({
    resolveTape: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  await m.pollTape();
  m.configure({
    chain: 'sol',
    minCap: 10000,
    maxCap: 5000000,
    minLiquidity: 5000,
  });
  release({
    candidates: [{ ...normal, id: `robinhood:${row.token}` }],
    sources: [],
  });
  await m.resolvePromise;
  assert.equal(m.state.candidates.length, 0);
  assert.equal(m.state.tape.events.length, 0);
  m.pause();
});
test('pause rejects an in-flight tape fetch', async () => {
  let release;
  const { m } = setup({
    fetchTape: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  const pending = m.pollTape();
  m.pause();
  release({ status: 'ok', data: { events: normalizeTape([row]) } });
  await pending;
  assert.equal(m.state.tape.events.length, 0);
});
test('risk queue grants an ordinary oldest candidate a turn after two live candidates', async () => {
  const collected = [];
  const { m } = setup({
    collect: async (c) => {
      collected.push(c.symbol);
      return { data: {}, sources: [] };
    },
  });
  m.state.candidates = [1, 2, 3].map((i) => ({
    ...normal,
    id: `live-${i}`,
    symbol: `LIVE${i}`,
    lastTrade: { ts: initialNow / 1000 },
  }));
  m.state.candidates.push(normal);
  await m.scan();
  await m.scan();
  await m.scan();
  assert.deepEqual(collected, ['LIVE1', 'LIVE2', 'NORMAL']);
  m.pause();
});

test('a flag arriving during quote resolution prevents admission', async () => {
  let release;
  const { m, setEvents } = setup({
    resolveTape: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  await m.pollTape();
  setEvents([{ ...row, flags: ['not a real buy (transferred)'] }]);
  await m.pollTape();
  release({
    candidates: [{ ...normal, id: `robinhood:${row.token}` }],
    sources: [],
  });
  await m.resolvePromise;
  assert.equal(m.state.candidates.length, 0);
  m.pause();
});
test('twenty fills from one wallet are one observed wallet and retain no summed correction', async () => {
  const { m, setEvents } = setup();
  setEvents(Array.from({ length: 20 }, (_, i) => ({ ...row, id: 100 + i })));
  await tape(m);
  assert.equal(m.summary().tape.recentBuys, 20);
  assert.equal(m.summary().tape.recentWallets, 1);
  setEvents([{ ...row, usd: 150 }]);
  await tape(m);
  assert.equal(m.summary().tape.events.find((e) => e.eventId === 100).usd, 150);
  assert.equal(m.summary().tape.recentBuys, 20);
  m.pause();
});
test('live reserved positions never exceed ten and the total list remains bounded', async () => {
  const { m, setEvents } = setup();
  m.baseCandidates = Array.from({ length: 45 }, (_, i) => ({
    ...normal,
    id: `normal-${i}`,
  }));
  setEvents(
    Array.from({ length: 20 }, (_, i) => ({
      ...row,
      id: 100 + i,
      token: `0x${(i + 20).toString(16).padStart(40, '0')}`,
    })),
  );
  await tape(m);
  assert.equal(m.state.candidates.length, 40);
  assert.equal(m.state.candidates.filter((c) => c.lastTrade).length, 10);
  m.pause();
});
test('transient list churn does not discard fresh risk evidence', async () => {
  const { m } = setup();
  m.state.reports[normal.id] = {
    candidate: normal,
    checkedAt: new Date(initialNow).toISOString(),
    raw: {},
    sources: [],
  };
  m.reconcile();
  assert.ok(m.state.reports[normal.id]);
  assert.equal(Object.keys(m.summary().reports).length, 0);
  await m.refresh();
  assert.equal(Object.keys(m.summary().reports).length, 1);
  m.pause();
});
test('a failing risk check backs off and lets another token proceed', async () => {
  const collected = [];
  const { m } = setup({
    collect: async (c) => {
      collected.push(c.id);
      throw new Error('temporary');
    },
  });
  m.state.candidates = [normal, { ...normal, id: 'second' }];
  await m.scan();
  await m.scan();
  assert.deepEqual(collected, [normal.id, 'second']);
  m.pause();
});

test('an older admitted observation loses its priority slot after two minutes', async () => {
  const { m, advance } = setup();
  await tape(m);
  assert.equal(m.state.candidates[0].symbol, 'LIVE');
  advance(121000);
  m.baseCandidates = Array.from({ length: 40 }, (_, i) => ({
    ...normal,
    id: `base-${i}`,
  }));
  await tape(m);
  assert.equal(m.summary().tape.recentBuys, 0);
  assert.equal(m.state.candidates.length, 40);
  assert.equal(
    m.state.candidates.some((c) => c.lastTrade),
    false,
  );
  m.pause();
});
