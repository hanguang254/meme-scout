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
const good = {
  candidates: [candidate],
  sources: [{ name: 'GMGN 热门', status: 'ok' }],
};
test('slow risk scan does not block a new discovery refresh', async () => {
  let discoveries = 0;
  const never = new Promise(() => {});
  const m = new Monitor({
    discover: async () => {
      discoveries++;
      return good;
    },
    collect: async () => never,
    autoSchedule: false,
  });
  await m.refresh();
  await m.refresh();
  assert.equal(discoveries, 2);
  assert.equal(m.state.candidates.length, 1);
  m.pause();
});
test('all discovery sources failing retains last successful candidates and evidence', async () => {
  let failed = false;
  const m = new Monitor({
    discover: async () =>
      failed
        ? { candidates: [], sources: [{ name: 'GMGN 热门', status: 'error' }] }
        : good,
    collect: async () => new Promise(() => {}),
    autoSchedule: false,
  });
  await m.refresh();
  const observed = m.state.updatedAt;
  failed = true;
  await m.refresh();
  assert.equal(m.state.candidates.length, 1);
  assert.equal(m.state.updatedAt, observed);
  assert.equal(m.state.discoveryStale, true);
  m.pause();
});
test('invalid monitor settings do not replace current config', () => {
  const m = new Monitor({
    discover: async () => good,
    collect: async () => ({ data: {}, sources: [] }),
    autoSchedule: false,
  });
  assert.throws(() =>
    m.configure({ chain: 'evil', minCap: 1, maxCap: 2, minLiquidity: 0 }),
  );
  assert.equal(m.state.config.chain, 'robinhood');
  m.pause();
});
test('changing the sort re-orders without discarding reports or re-discovering', async () => {
  let discoveries = 0;
  const rows = [
    { ...candidate, id: 'sol:old', address: 'old', createdAt: 1000 },
    { ...candidate, id: 'sol:new', address: 'new', createdAt: 9000 },
  ];
  const m = new Monitor({
    discover: async () => {
      discoveries++;
      return { candidates: rows, sources: [{ name: 'GMGN 热门', status: 'ok' }] };
    },
    collect: async () => ({ data: {}, sources: [] }),
    autoSchedule: false,
  });
  m.configure({
    chain: 'sol',
    minCap: 1000,
    maxCap: 1e9,
    minLiquidity: 1000,
  });
  await m.refresh();
  const reports = { ...m.state.reports };
  assert.deepEqual(
    m.state.candidates.map((c) => c.id),
    ['sol:old', 'sol:new'],
  );
  m.setSort('new');
  assert.deepEqual(
    m.state.candidates.map((c) => c.id),
    ['sol:new', 'sol:old'],
  );
  // Unlike configure(), sorting must not cost a rescan of what is already known.
  assert.equal(discoveries, 1);
  assert.deepEqual(m.state.reports, reports);
  assert.equal(m.state.sort, 'new');
  m.setSort('heat');
  assert.deepEqual(
    m.state.candidates.map((c) => c.id),
    ['sol:old', 'sol:new'],
  );
  assert.throws(() => m.setSort('cheapest'));
  assert.equal(m.state.sort, 'heat');
  // A filter change keeps the chosen order instead of silently resetting it.
  m.setSort('new');
  m.configure({ chain: 'sol', minCap: 2000, maxCap: 1e9, minLiquidity: 1000 });
  assert.equal(m.state.sort, 'new');
  m.pause();
});

// The page keeps a watermark and drops any snapshot whose `rev` does not beat
// it, because the stream and the request replies arrive on separate connections
// and not in the order they were produced. That rule is only safe if a snapshot
// built later always carries a larger `rev` — otherwise a chain switch's reply
// would be discarded instead of the stale frame it has to outrank.
test('a snapshot built later always outranks one built earlier', () => {
  const m = new Monitor({
    discover: async () => good,
    collect: async () => ({ data: {}, sources: [], gmgnCalls: 0 }),
    autoSchedule: false,
  });
  // The frame the stream flushed a moment before the switch.
  const before = m.summary();
  m.configure({
    chain: 'bsc',
    minCap: 10000,
    maxCap: 5000000,
    minLiquidity: 5000,
  });
  // The reply the switch itself returns.
  const after = m.summary();
  assert.equal(before.config.chain, 'robinhood');
  assert.equal(after.config.chain, 'bsc');
  assert.ok(after.rev > before.rev, '切链后的快照必须比切链前的新');
  assert.equal(after.boot, before.boot, '同一进程的 boot 不能变');
  // Two snapshots of an unchanged state still order, so a reply can never tie
  // with the frame it has to beat.
  assert.ok(m.summary().rev > after.rev);
  m.pause();
});

test('a restarted service is not mistaken for a stale frame', () => {
  const old = new Monitor({ autoSchedule: false });
  for (let i = 0; i < 5; i++) old.summary();
  const held = old.summary();
  // A fresh process counts from zero, so `rev` alone would have the page reject
  // everything it sends, forever. `boot` is what tells the page to take it.
  const fresh = new Monitor({ autoSchedule: false }).summary();
  assert.ok(fresh.rev < held.rev);
  assert.notEqual(fresh.boot, held.boot);
  old.pause();
});
