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
