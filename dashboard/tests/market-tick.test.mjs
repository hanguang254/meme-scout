import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../scanner/monitor.mjs';
import { marketFields, dexChain, quoteMarket } from '../scanner/providers.mjs';

const candidate = (over = {}) => ({
  id: 'sol:a',
  chain: 'sol',
  address: 'AaBb',
  symbol: 'TEST',
  marketCap: 100000,
  liquidity: 20000,
  ...over,
});
const discovery = (candidates) => ({
  candidates,
  sources: [{ name: 'GMGN 热门', status: 'ok' }],
});
const quotes = (entries) => ({
  quotes: new Map(entries),
  sources: [{ name: 'DexScreener 实时行情', status: 'ok', data: null }],
});

test('a missing window is reported as unknown rather than as a flat market', () => {
  // DexScreener omits priceChange.m5 and volume.m5 when it has nothing to
  // compare. Reading an absent key as 0 would draw a still market from no data.
  const sparse = marketFields({ marketCap: 5, priceChange: { h24: -0.01 } });
  assert.equal(sparse.marketCap, 5);
  assert.equal(sparse.change5m, null);
  assert.equal(sparse.volume5m, null);
  assert.equal(sparse.buys5m, null);
  assert.equal(sparse.sells5m, null);
  assert.equal(marketFields(undefined).marketCap, null);

  // Both valuations are kept; neither substitutes for the other.
  const full = marketFields({
    marketCap: 900,
    fdv: 4200,
    liquidity: { usd: 12 },
    volume: { h1: 7, m5: 3 },
    priceChange: { h1: 2, m5: -1 },
    txns: { m5: { buys: 4, sells: 6 } },
  });
  assert.equal(full.marketCap, 900);
  assert.equal(full.fdv, 4200);
  assert.equal(full.change5m, -1);
  assert.deepEqual([full.buys5m, full.sells5m], [4, 6]);
});

test('every chain the panel offers maps to a quotable slug', () => {
  assert.deepEqual(
    ['robinhood', 'sol', 'bsc', 'base', 'eth'].map(dexChain),
    ['robinhood', 'solana', 'bsc', 'base', 'ethereum'],
  );
  assert.equal(dexChain('dogecoin'), null);
});

test('an unquotable chain issues no request instead of guessing an endpoint', async () => {
  const r = await quoteMarket('dogecoin', ['0x1']);
  assert.equal(r.sources.length, 0);
  assert.equal(r.quotes.size, 0);
});

// The report keeps a reference to the candidate it was built from. If the quote
// wrote through that object, the market cap the verdict was actually reached at
// would be overwritten with the current one and every report would claim it was
// written at today's price.
test('a live quote never rewrites the market cap a stored report was built at', async () => {
  const m = new Monitor({
    discover: async () => discovery([candidate()]),
    collect: async () => ({ data: {}, sources: [], gmgnCalls: 0 }),
    quoteMarket: async () => quotes([['aabb', { marketCap: 250000 }]]),
    autoSchedule: false,
  });
  await m.refresh();
  await m.scan();
  const report = m.state.reports['sol:a'];
  assert.equal(report.candidate.marketCap, 100000);

  await m.tickMarket();
  assert.equal(m.state.candidates[0].marketCap, 250000);
  assert.equal(
    report.candidate.marketCap,
    100000,
    '报告里的市值必须停在核验那一刻',
  );
  m.pause();
});

test('the quote refreshes prices without changing which candidates are listed', async () => {
  // A cap that drifts outside the configured range must not drop the coin
  // mid-scan: membership belongs to discovery, and dropping it here would throw
  // away a report the scanner already spent its rate limit producing.
  const m = new Monitor({
    discover: async () => discovery([candidate(), candidate({ id: 'sol:b', address: 'Cc' })]),
    collect: async () => ({ data: {}, sources: [], gmgnCalls: 0 }),
    quoteMarket: async () => quotes([['aabb', { marketCap: 9e9, liquidity: 1 }]]),
    autoSchedule: false,
  });
  await m.refresh();
  assert.equal(m.state.candidates.length, 2);
  await m.tickMarket();
  assert.equal(m.state.candidates.length, 2);
  assert.equal(m.state.candidates.find((c) => c.id === 'sol:a').marketCap, 9e9);
  // Untouched candidates keep the numbers discovery gave them.
  assert.equal(m.state.candidates.find((c) => c.id === 'sol:b').marketCap, 100000);
  assert.equal(m.state.market.quoted, 1);
  m.pause();
});

test('a tick that updated nothing does not stamp a fresh observation time', async () => {
  // The timestamp says how old the prices are, not how recently a request was
  // sent. A failed or empty batch must leave it where it was.
  const m = new Monitor({
    discover: async () => discovery([candidate()]),
    collect: async () => new Promise(() => {}),
    quoteMarket: async () => ({
      quotes: new Map(),
      sources: [
        { name: 'DexScreener 实时行情', status: 'error', error: 'HTTP 429 · 触发限流' },
      ],
    }),
    autoSchedule: false,
  });
  await m.refresh();
  await m.tickMarket();
  assert.equal(m.state.market.observedAt, null);
  assert.equal(m.state.market.quoted, 0);
  assert.match(m.state.market.error, /1\/1 批未取得/);
  assert.match(m.state.market.error, /触发限流/);
  m.pause();
});

test('a chain with no quote endpoint is reported as unsupported, not as an error', async () => {
  const m = new Monitor({
    discover: async () => discovery([candidate()]),
    collect: async () => new Promise(() => {}),
    quoteMarket: async () => ({ quotes: new Map(), sources: [] }),
    autoSchedule: false,
  });
  await m.refresh();
  await m.tickMarket();
  assert.equal(m.state.market.supported, false);
  assert.equal(m.state.market.error, null);
  m.pause();
});

test('a paused monitor issues no quotes', async () => {
  let calls = 0;
  const m = new Monitor({
    discover: async () => discovery([candidate()]),
    collect: async () => new Promise(() => {}),
    quoteMarket: async () => {
      calls++;
      return quotes([]);
    },
    autoSchedule: false,
  });
  await m.refresh();
  // Discovery kicks off the first quote itself, so the count is measured from
  // after the pause rather than from zero.
  const before = calls;
  m.pause();
  await m.tickMarket();
  assert.equal(calls, before);
  assert.equal(m.state.market.nextTick, null);
});

test('discovery starts the first quote without waiting a full interval', async () => {
  let calls = 0;
  const m = new Monitor({
    discover: async () => discovery([candidate()]),
    collect: async () => new Promise(() => {}),
    quoteMarket: async () => {
      calls++;
      return quotes([['aabb', { marketCap: 7 }]]);
    },
    autoSchedule: false,
  });
  await m.refresh();
  assert.equal(calls, 1);
  assert.equal(m.state.candidates[0].marketCap, 7);
  m.pause();
});
