import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteMarket,
  geckoChain,
  dexChain,
  anchorTtl,
  marketFields,
} from '../scanner/providers.mjs';

const TOKEN = `0x${'1'.repeat(40)}`;
const QUOTE = `0x${'2'.repeat(40)}`;
const POOL = `0x${'3'.repeat(40)}`;
// The shape GeckoTerminal answers /tokens/multi/…?include=top_pools with: the
// tokens in `data`, and their pools alongside in `included`, joined by id.
const reply = (token = {}, pool = {}) => ({
  data: [
    {
      attributes: { address: TOKEN, ...token },
      relationships: { top_pools: { data: [{ id: 'arc_pool_1' }] } },
    },
  ],
  included: [
    {
      type: 'pool',
      id: 'arc_pool_1',
      attributes: { address: POOL, ...pool },
      relationships: {
        dex: { data: { id: 'uniswap-v3-arc' } },
        quote_token: { data: { id: `arc_${QUOTE}` } },
      },
    },
  ],
});
const quoteArc = async (token, pool) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(reply(token, pool)));
  try {
    const r = await quoteMarket('arc', [TOKEN]);
    return { quote: r.quotes.get(TOKEN), sources: r.sources };
  } finally {
    globalThis.fetch = original;
  }
};

test('DexScreener 不收录的链走 GeckoTerminal，收录的链不改道', () => {
  assert.equal(geckoChain('arc'), 'arc');
  assert.equal(dexChain('arc'), null, 'Arc 若同时走两边会重复计费');
  // Every other chain the panel offers is quoted by DexScreener, and must not
  // be routed to a source with a tenth of the rate limit.
  for (const chain of ['robinhood', 'sol', 'bsc', 'base', 'eth'])
    assert.equal(geckoChain(chain), null, chain);
});

test('重新问来源的间隔按各自的速率定，链上池价不受影响', () => {
  // DexScreener is re-asked every tick; GeckoTerminal allows about a tenth of
  // that and was measured lagging by minutes, so it is held for 30s. The price
  // on screen rides on the pool read either way, which runs every tick.
  assert.equal(anchorTtl('robinhood'), 0);
  assert.equal(anchorTtl('sol'), 0);
  assert.equal(anchorTtl('arc'), 30000);
});

test('来源只发布 FDV 时如实标出，而不是把摊薄估值当成流通市值', async () => {
  const { quote } = await quoteArc({ market_cap_usd: null, fdv_usd: '4200' });
  assert.equal(quote.marketCap, 4200, '没有流通市值时用 FDV 顶上，否则整条链都没有行');
  assert.equal(quote.fdv, 4200);
  assert.equal(quote.capIsFdv, true, '顶替这件事必须记下来，列里要说明');
  assert.equal(quote.marketCapSource, 'GeckoTerminal 首位池');
});

test('"0.0" 是没有，不是零美元', async () => {
  // Parsed naively it is a market cap of zero dollars: it passes every "is this
  // a number" check and then fails the minimum-cap filter, so the coin vanishes
  // as though it had been measured and found worthless.
  const { quote } = await quoteArc({ market_cap_usd: '0.0', fdv_usd: '4200' });
  assert.equal(quote.marketCap, 4200);
  assert.equal(quote.capIsFdv, true);
  // With neither published there is nothing to stand in: the row is dropped as
  // unknown-cap rather than shown at zero.
  const none = await quoteArc({ market_cap_usd: '0.0', fdv_usd: '0.0' });
  assert.equal(none.quote.marketCap, null);
  assert.equal(none.quote.fdv, null);
  assert.equal(none.quote.capIsFdv, false, '没顶替就不能说顶替了');
});

test('来源发布了流通市值就用它，两个数都留着', async () => {
  const { quote } = await quoteArc({ market_cap_usd: '900', fdv_usd: '4200' });
  assert.equal(quote.marketCap, 900);
  assert.equal(quote.fdv, 4200);
  assert.equal(quote.capIsFdv, false);
  // A quote is merged over a candidate, so DexScreener must state this too —
  // an absent key would leave a flag set by another source on a row whose cap
  // this source published for real.
  assert.equal(marketFields({ marketCap: 900 }).capIsFdv, false);
  assert.equal('capIsFdv' in marketFields({}), true);
});

test('池坐标带全了，链上那一轮才找得回这个池', async () => {
  const { quote } = await quoteArc(
    { market_cap_usd: '900' },
    {
      base_token_price_usd: '2',
      quote_token_price_usd: '4',
      base_token_price_quote_token: '0.5',
      reserve_in_usd: '12345',
      volume_usd: { h1: '7', m5: '3' },
      price_change_percentage: { h1: '2', m5: '-1' },
      transactions: { m5: { buys: 4, sells: 6 } },
    },
  );
  assert.equal(quote.pool, POOL);
  // The dex id is how this source spells the version; DexScreener spells the
  // same fact as labels ["v3"], and both have to arrive as the same value.
  assert.equal(quote.poolVersion, 'v3');
  assert.equal(quote.quoteToken, QUOTE, '报价币地址要从关系里的复合 id 里取出来');
  // Published directly. Deriving it from the two dollar prices would fold two
  // separate staleness windows into the number the on-chain guard compares.
  assert.equal(quote.priceNative, 0.5);
  assert.equal(quote.price, 2);
  assert.equal(quote.liquidity, 12345);
  assert.deepEqual([quote.volume, quote.volume5m], [7, 3]);
  assert.deepEqual([quote.change, quote.change5m], [2, -1]);
  assert.deepEqual([quote.buys5m, quote.sells5m], [4, 6]);
});

test('来源没发布报价币价格时，宁可没有这个数也不编一个', async () => {
  // Without base-in-quote and without both dollar prices there is no ratio to
  // derive. A missing priceNative means the pool read is skipped for this row,
  // which is the honest outcome — it is the denominator of the whole rescale.
  const { quote } = await quoteArc(
    { market_cap_usd: '900' },
    { base_token_price_usd: '2' },
  );
  assert.equal(quote.priceNative, null);
  // Both dollar prices present and no direct quote: the ratio is derivable.
  const derived = await quoteArc(
    { market_cap_usd: '900' },
    { base_token_price_usd: '2', quote_token_price_usd: '4' },
  );
  assert.equal(derived.quote.priceNative, 0.5);
});

test('来源答错或答不上来时留下的是一条来源记录，不是一行假价格', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 503 });
  try {
    const r = await quoteMarket('arc', [TOKEN]);
    assert.equal(r.quotes.size, 0);
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].status, 'error');
    assert.match(r.sources[0].name, /GeckoTerminal/);
  } finally {
    globalThis.fetch = original;
  }
});
