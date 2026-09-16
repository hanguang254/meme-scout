import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../scanner/monitor.mjs';

// Several chains are watched at once and each has its own discovery sources,
// its own quote source, its own rate limit and its own RPC. The property every
// test here holds to is the same one: a chain's answer, and a chain's failure,
// belong to that chain. A board that blanked every row because one endpoint was
// down would be reporting an outage as a market.
const coin = (chain, address, over = {}) => ({
  id: `${chain}:${address}`,
  chain,
  address,
  symbol: address.toUpperCase(),
  marketCap: 100000,
  liquidity: 20000,
  ...over,
});
const found = (candidates, status = 'ok', name = 'GMGN 热门') => ({
  candidates,
  sources: [{ name, status }],
});
const watch = (m, chains) => {
  m.configure({ chains, minCap: 10000, maxCap: 5e6, minLiquidity: 5000 });
  return m;
};
const idle = { collect: async () => new Promise(() => {}), autoSchedule: false };

test('一条链的发现来源挂了，另一条链照常刷新', async () => {
  let solDown = false;
  const m = new Monitor({
    ...idle,
    discover: async (chain) =>
      chain === 'sol'
        ? solDown
          ? found([], 'error')
          : found([coin('sol', 'a')])
        : found([coin('arc', 'b')], 'ok', 'GeckoTerminal 热门池'),
  });
  watch(m, ['sol', 'arc']);
  await m.refresh();
  assert.deepEqual(m.state.candidates.map((c) => c.id), ['sol:a', 'arc:b']);
  solDown = true;
  await m.refresh();
  // Solana holds what it last had rather than emptying, and Arc is untouched.
  assert.deepEqual(m.state.candidates.map((c) => c.id), ['sol:a', 'arc:b']);
  assert.equal(m.state.discoveryStale, true);
  assert.match(m.state.error, /Solana/);
  assert.equal(/Arc/.test(m.state.error), false, '没出问题的链不该被点名');
  // Which chain a source row belongs to is what makes a mixed list readable.
  assert.deepEqual(
    m.state.sources.map((x) => x.chain),
    ['sol', 'arc'],
  );
  m.pause();
});

test('发现整个抛错的链只赔上自己，不带走别的链', async () => {
  const m = new Monitor({
    ...idle,
    discover: async (chain) => {
      if (chain === 'sol') throw new Error('来源限流');
      return found([coin('arc', 'b')], 'ok', 'GeckoTerminal 热门池');
    },
  });
  watch(m, ['sol', 'arc']);
  await m.refresh();
  assert.deepEqual(m.state.candidates.map((c) => c.id), ['arc:b']);
  assert.match(m.state.error, /Solana/);
  // The refresh still happened for Arc, so the board's time is this refresh's.
  assert.ok(m.state.updatedAt);
  m.pause();
});

test('每条链都没答上来的一轮，不会盖掉旧行的时间', async () => {
  let up = true;
  const m = new Monitor({
    ...idle,
    discover: async () => (up ? found([coin('sol', 'a')]) : found([], 'error')),
  });
  watch(m, ['sol', 'bsc']);
  await m.refresh();
  const observed = m.state.updatedAt;
  up = false;
  await m.refresh();
  assert.equal(m.state.updatedAt, observed, '什么都没学到的一轮不能当成新数据');
  assert.equal(m.state.candidates.length, 1);
  m.pause();
});

test('取消选中的链立刻退出榜单，不靠下一轮发现来清', async () => {
  const m = new Monitor({
    ...idle,
    discover: async (chain) => found([coin(chain, 'a')]),
  });
  watch(m, ['sol', 'bsc']);
  await m.refresh();
  assert.equal(m.state.candidates.length, 2);
  // Re-selecting drops the board and re-discovers, but the chain that left must
  // not come back through the per-chain store that survives a refresh.
  watch(m, ['sol']);
  await m.refresh();
  assert.deepEqual(m.state.candidates.map((c) => c.chain), ['sol']);
  m.pause();
});

test('同一个地址在两条链上是两个币，价格不会互相串', async () => {
  // The same 20-byte address is a different contract on every EVM chain. A flat
  // address key would file one chain's price under the other chain's coin as a
  // number that looks entirely reasonable.
  const address = `0x${'1'.repeat(40)}`;
  const m = new Monitor({
    ...idle,
    discover: async (chain) => found([coin(chain, address)]),
    quoteMarket: async (chain) => ({
      quotes: new Map([
        [address.toLowerCase(), { marketCap: chain === 'arc' ? 111 : 222 }],
      ]),
      sources: [{ name: `${chain} 行情`, status: 'ok' }],
    }),
  });
  watch(m, ['arc', 'bsc']);
  await m.refresh();
  await m.tickMarket();
  const capOf = (chain) =>
    m.state.candidates.find((c) => c.chain === chain).marketCap;
  assert.equal(capOf('arc'), 111);
  assert.equal(capOf('bsc'), 222);
  assert.equal(m.state.market.quoted, 2);
  m.pause();
});

test('一条链的行情请求失败，另一条链的价格照样落到榜上', async () => {
  const m = new Monitor({
    ...idle,
    discover: async (chain) => found([coin(chain, 'a')]),
    quoteMarket: async (chain) => {
      if (chain === 'bsc') throw new Error('HTTP 429 · 触发限流');
      return {
        quotes: new Map([['a', { marketCap: 777 }]]),
        sources: [{ name: 'GeckoTerminal 实时行情', status: 'ok' }],
      };
    },
  });
  watch(m, ['arc', 'bsc']);
  await m.refresh();
  await m.tickMarket();
  assert.equal(m.state.candidates.find((c) => c.chain === 'arc').marketCap, 777);
  assert.equal(m.state.market.quoted, 1);
  assert.equal(m.state.market.supported, true);
  // The failure is reported as that chain's, not as a tick that did not happen.
  assert.match(m.state.market.error, /BNB Chain/);
  assert.match(m.state.market.error, /触发限流/);
  assert.ok(m.state.market.observedAt, 'Arc 真的更新了，时间就该往前走');
  m.pause();
});

test('慢来源在它的间隔内复用上一次报价，快来源每轮都问', async () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const calls = [];
  // Lane order is whichever promise settled first, which is not a fact about
  // the code under test — only which chains were asked is.
  const asked = () => [...calls].sort((a, b) => a.localeCompare(b));
  const m = new Monitor({
    ...idle,
    clock: () => now,
    // Arc's source allows about a tenth of DexScreener's requests and was
    // measured lagging by minutes; the live price comes from the pool read.
    anchorTtl: (chain) => (chain === 'arc' ? 30000 : 0),
    discover: async (chain) => found([coin(chain, 'a')]),
    quoteMarket: async (chain) => {
      calls.push(chain);
      return {
        quotes: new Map([['a', { marketCap: 500 }]]),
        sources: [{ name: `${chain} 行情`, status: 'ok', fetchedAt: 'T0' }],
      };
    },
  });
  watch(m, ['arc', 'sol']);
  await m.refresh();
  // Discovery starts the first tick itself; joining it here measures the ticks
  // after it rather than racing the one already in flight.
  await m.tickMarket();
  calls.length = 0;
  now += 6000;
  await m.tickMarket();
  assert.deepEqual(asked(), ['sol'], 'Arc 在 30 秒内不重复问来源');
  // Reused evidence keeps the time it was actually fetched; re-stamping it now
  // would make the age beside the row the age of this tick.
  const arc = m.state.market.sources.find((x) => x.chain === 'arc');
  assert.equal(arc.reused, true);
  assert.equal(arc.fetchedAt, 'T0');
  assert.equal(
    m.state.market.sources.find((x) => x.chain === 'sol').reused,
    undefined,
  );
  calls.length = 0;
  now += 31000;
  await m.tickMarket();
  assert.deepEqual(asked(), ['arc', 'sol']);
  m.pause();
});

test('报价里没有的新币会让那条链重新问一次，而不是等计时器', async () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  let second = false;
  let calls = 0;
  const m = new Monitor({
    ...idle,
    clock: () => now,
    anchorTtl: () => 30000,
    discover: async () =>
      found(second ? [coin('arc', 'a'), coin('arc', 'b')] : [coin('arc', 'a')]),
    quoteMarket: async (_chain, addresses) => {
      calls++;
      return {
        quotes: new Map(addresses.map((a) => [a, { marketCap: 500 }])),
        sources: [{ name: 'GeckoTerminal 实时行情', status: 'ok' }],
      };
    },
  });
  watch(m, ['arc']);
  await m.refresh();
  await m.tickMarket();
  calls = 0;
  now += 1000;
  await m.tickMarket();
  assert.equal(calls, 0, '名单没变就沿用');
  // A coin the anchor has never seen has no pool, no supply and no dollar rate
  // to scale, so it cannot be served from a held quote at any age.
  second = true;
  await m.refresh();
  await m.tickMarket();
  assert.ok(calls >= 1);
  assert.equal(
    m.state.candidates.every((c) => c.marketCap === 500),
    true,
  );
  m.pause();
});

test('追踪地址按链分别扫，每条链的区块和错误都是自己的', async () => {
  const wallet = `0x${'9'.repeat(40)}`;
  const m = new Monitor({
    ...idle,
    watchlist: { state: { entries: [{ address: wallet, note: '甲' }] } },
    discover: async (chain) => found([coin(chain, 'a')]),
    readTracked: async ({ chain, tokens }) => {
      if (chain === 'sol')
        throw new Error('Solana 不是 EVM 链，不支持 Multicall3');
      return {
        rpc: `https://${chain}.example`,
        block: chain === 'arc' ? 100 : 200,
        wallets: 1,
        requests: 1,
        observedAt: chain === 'arc' ? '2026-01-01T00:00:10Z' : '2026-01-01T00:00:20Z',
        failedChunks: 0,
        error: null,
        tokens: Object.fromEntries(
          tokens.map((t) => [t.id, { count: 1, hits: [], status: 'ok' }]),
        ),
      };
    },
  });
  watch(m, ['arc', 'bsc', 'sol']);
  await m.refresh();
  await m.tickTracked();
  const t = m.state.tracked;
  const lane = (chain) => t.chains.find((x) => x.chain === chain);
  assert.equal(lane('arc').block, 100);
  assert.equal(lane('bsc').block, 200);
  assert.equal(lane('arc').error, null);
  // Not a read that failed — a chain that has no such call to make. The page
  // says those differently because one is a thing to fix and one is not.
  assert.equal(lane('sol').supported, false);
  assert.match(lane('sol').error, /不是 EVM/);
  // Token ids carry their chain, so the merged rows cannot collide.
  assert.deepEqual(Object.keys(t.byCandidate).sort(), ['arc:a', 'bsc:a']);
  // The headline is the weakest answer any chain gave, and there is no single
  // block two chains were both read at.
  assert.equal(t.block, null);
  assert.equal(t.rpc, null);
  assert.equal(t.supported, true, '还有能读的链，这一列就没整体失效');
  assert.equal(t.observedAt, '2026-01-01T00:00:10Z', '整列的新鲜度取最旧的那条链');
  assert.match(t.error, /Solana/);
  m.pause();
});

test('只看一条链时，表头还是那条链自己的区块', async () => {
  const wallet = `0x${'9'.repeat(40)}`;
  const m = new Monitor({
    ...idle,
    watchlist: { state: { entries: [{ address: wallet, note: '甲' }] } },
    discover: async (chain) => found([coin(chain, 'a')]),
    readTracked: async ({ chain }) => ({
      rpc: `https://${chain}.example`,
      block: 42,
      wallets: 1,
      requests: 1,
      observedAt: '2026-01-01T00:00:10Z',
      failedChunks: 0,
      error: null,
      tokens: { [`${chain}:a`]: { count: 0, hits: [], status: 'ok' } },
    }),
  });
  watch(m, ['arc']);
  await m.refresh();
  await m.tickTracked();
  assert.equal(m.state.tracked.block, 42);
  assert.equal(m.state.tracked.rpc, 'https://arc.example');
  assert.equal(m.state.tracked.swept, 1);
  m.pause();
});
