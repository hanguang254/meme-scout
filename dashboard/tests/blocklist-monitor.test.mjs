import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../scanner/monitor.mjs';
import { normalizeTape } from '../scanner/tape.mjs';

// A blocked coin is not a hidden row. The property every test here holds to is
// that nothing is spent on it any more: no scan, no quote, no balance sweep, no
// LIVE TAPE market-cap lookup — and it takes no seat on the board.
const now0 = 1788658000000;
const coin = (address, over = {}) => ({
  id: `robinhood:${address}`,
  chain: 'robinhood',
  address,
  symbol: address.slice(2, 6).toUpperCase(),
  marketCap: 100000,
  liquidity: 20000,
  ...over,
});
const A = coin(`0x${'a'.repeat(40)}`);
const B = coin(`0x${'b'.repeat(40)}`);
const blocklist = (ids = []) => {
  const set = new Set(ids);
  return {
    has: (id) => set.has(id),
    entries: () => [...set].map((id) => ({ id, symbol: '', at: null })),
    state: { error: null },
    add: (id) => set.add(id),
    delete: (id) => set.delete(id),
  };
};
const discover = async () => ({
  candidates: [A, B],
  sources: [{ name: 'Robinhood Trenches', status: 'ok' }],
});

test('拉黑的币不上榜，也不占名额', async () => {
  const m = new Monitor({
    discover,
    collect: async () => new Promise(() => {}),
    blocklist: blocklist([A.id]),
    autoSchedule: false,
  });
  await m.refresh();
  assert.deepEqual(
    m.state.candidates.map((c) => c.id),
    [B.id],
  );
  m.pause();
});

test('拉黑的币不进风险扫描队列', async () => {
  const scanned = [];
  const m = new Monitor({
    discover,
    collect: async (c) => {
      scanned.push(c.id);
      return { data: {}, sources: [], gmgnCalls: 0 };
    },
    blocklist: blocklist([A.id]),
    autoSchedule: false,
  });
  await m.refresh();
  await m.scan();
  await m.scan();
  assert.deepEqual(scanned, [B.id]);
  m.pause();
});

test('拉黑的币不再请求行情，也不查追踪地址余额', async () => {
  const quoted = [];
  const swept = [];
  const m = new Monitor({
    discover,
    collect: async () => new Promise(() => {}),
    quoteMarket: async (_chain, addresses) => {
      quoted.push(...addresses);
      return { quotes: new Map(), sources: [{ name: 'x', status: 'ok' }] };
    },
    readTracked: async ({ tokens }) => {
      swept.push(...tokens.map((t) => t.id));
      return {
        tokens: {},
        rpc: null,
        block: 1,
        wallets: 1,
        requests: 1,
        observedAt: new Date(now0).toISOString(),
      };
    },
    watchlist: { state: { entries: [{ address: `0x${'9'.repeat(40)}` }] } },
    blocklist: blocklist([A.id]),
    autoSchedule: false,
  });
  await m.refresh();
  await m.tickMarket();
  await m.tickTracked();
  assert.deepEqual(quoted, [B.address]);
  assert.deepEqual(swept, [B.id]);
  m.pause();
});

test('拉黑当场生效：删掉已有报告，下一份快照里就没有它', async () => {
  const list = blocklist();
  const m = new Monitor({
    discover,
    collect: async () => ({ data: {}, sources: [], gmgnCalls: 0 }),
    blocklist: list,
    autoSchedule: false,
  });
  await m.refresh();
  await m.scan();
  assert.ok(m.state.reports[A.id] || m.state.reports[B.id]);
  const had = Object.keys(m.state.reports);
  list.add(had[0]);
  m.applyBlocklist();
  assert.equal(
    m.state.candidates.some((c) => c.id === had[0]),
    false,
  );
  assert.equal(m.state.reports[had[0]], undefined, '报告要删，不是只藏起来');
  const snap = m.summary();
  assert.equal(
    snap.candidates.some((c) => c.id === had[0]),
    false,
  );
  assert.deepEqual(
    snap.blocked.map((e) => e.id),
    [had[0]],
  );
  m.pause();
});

test('解除拉黑后不必等下一轮发现，上次发现到的就能回到榜上', async () => {
  const list = blocklist([A.id]);
  const m = new Monitor({
    discover,
    collect: async () => new Promise(() => {}),
    blocklist: list,
    autoSchedule: false,
  });
  await m.refresh();
  list.delete(A.id);
  m.applyBlocklist();
  assert.deepEqual(
    new Set(m.state.candidates.map((c) => c.id)),
    new Set([A.id, B.id]),
  );
  m.pause();
});

test('拉黑的币在 LIVE TAPE 上不触发市值查询，也不进候选', async () => {
  const token = `0x${'c'.repeat(40)}`;
  const resolved = [];
  const m = new Monitor({
    autoSchedule: false,
    clock: () => now0,
    discover: async () => ({
      candidates: [],
      sources: [{ name: 'Robinhood Trenches', status: 'ok' }],
    }),
    collect: async () => new Promise(() => {}),
    fetchTape: async () => ({
      status: 'ok',
      fetchedAt: new Date(now0).toISOString(),
      data: {
        events: normalizeTape([
          {
            id: 1,
            ts: now0 / 1000 - 10,
            side: 'buy',
            token,
            wallet: `0x${'2'.repeat(40)}`,
            tx: `0x${'e'.repeat(64)}`,
            symbol: 'BLK',
            usd: 100,
            price: 0.0001,
            priced: 'cash_leg',
            flags: [],
            is_stock: 0,
          },
        ]),
        gap: false,
      },
    }),
    resolveTape: async (trades) => {
      resolved.push(...trades.map((t) => t.candidateId));
      return { sources: [], candidates: [] };
    },
    blocklist: blocklist([`robinhood:${token}`]),
  });
  await m.pollTape();
  await m.resolveLive();
  assert.deepEqual(resolved, []);
  assert.equal(m.state.candidates.length, 0);
  assert.equal(m.summary().tape.events[0].reason, '已拉黑');
  m.pause();
});

test('没有接拉黑名单时一切照旧', async () => {
  const m = new Monitor({
    discover,
    collect: async () => new Promise(() => {}),
    autoSchedule: false,
  });
  await m.refresh();
  assert.equal(m.state.candidates.length, 2);
  assert.deepEqual(m.summary().blocked, []);
  m.pause();
});

test('扫描进行中被拉黑，回来的报告不写入', async () => {
  const list = blocklist();
  let finish;
  const m = new Monitor({
    discover: async () => ({
      candidates: [A],
      sources: [{ name: 'Robinhood Trenches', status: 'ok' }],
    }),
    collect: () =>
      new Promise((resolve) => {
        finish = () => resolve({ data: {}, sources: [], gmgnCalls: 0 });
      }),
    blocklist: list,
    autoSchedule: false,
  });
  await m.refresh();
  const running = m.scan();
  list.add(A.id);
  m.applyBlocklist();
  finish();
  await running;
  assert.equal(m.state.reports[A.id], undefined);
  m.pause();
});
