import test from 'node:test';
import assert from 'node:assert/strict';
import { imageUrl, marketFields, quoteMarket } from '../scanner/providers.mjs';
import { Monitor } from '../scanner/monitor.mjs';

// The coin's picture is decoration, never evidence, so the only rules are
// about not letting a source string become something the page should not load
// and not letting a source that has no picture erase one another source had.
test('只接受 https 图片地址，其它一律当没有', () => {
  assert.equal(
    imageUrl('https://gmgn.ai/external-res/abc_v2.webp'),
    'https://gmgn.ai/external-res/abc_v2.webp',
  );
  for (const bad of [
    'http://example.com/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//cdn.example.com/a.png',
    '',
    '   ',
    null,
    42,
    'not a url',
  ])
    assert.equal(imageUrl(bad), null, String(bad));
  assert.equal(
    imageUrl(`https://a.example/${'x'.repeat(2100)}`),
    null,
    '过长的不要',
  );
});

test('DexScreener 的图片在 info.imageUrl', () => {
  assert.equal(
    marketFields({
      info: {
        imageUrl: 'https://dd.dexscreener.com/ds-data/tokens/solana/x.png',
      },
    }).image,
    'https://dd.dexscreener.com/ds-data/tokens/solana/x.png',
  );
});

test('DexScreener 没有图片时不带 image 键，合并时不会冲掉别的来源给的图', () => {
  const q = marketFields({ info: {} });
  assert.equal('image' in q, false);
  assert.equal('image' in marketFields({}), false);
});

test('GeckoTerminal 的图片在代币的 image_url，"missing.png" 当没有', async () => {
  const TOKEN = `0x${'1'.repeat(40)}`;
  const reply = (image_url) => ({
    data: [
      {
        attributes: { address: TOKEN, image_url },
        relationships: { top_pools: { data: [] } },
      },
    ],
    included: [],
  });
  const quote = async (image) => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(reply(image)));
    try {
      return (await quoteMarket('arc', [TOKEN])).quotes.get(TOKEN);
    } finally {
      globalThis.fetch = original;
    }
  };
  assert.equal(
    (await quote('https://assets.geckoterminal.com/x/small/a.png')).image,
    'https://assets.geckoterminal.com/x/small/a.png',
  );
  // GeckoTerminal answers a token it has no picture for with a placeholder URL.
  assert.equal('image' in (await quote('missing.png')), false);
});

test('行情刷新带来的没有图片的报价不会把已有的图片清掉', async () => {
  const address = `0x${'a'.repeat(40)}`;
  const m = new Monitor({
    discover: async () => ({
      candidates: [
        {
          id: `bsc:${address}`,
          chain: 'bsc',
          address,
          symbol: 'IMG',
          marketCap: 100000,
          liquidity: 20000,
          image: 'https://gmgn.ai/external-res/logo.webp',
        },
      ],
      sources: [{ name: 'GMGN 热门', status: 'ok' }],
    }),
    collect: async () => new Promise(() => {}),
    quoteMarket: async () => ({
      quotes: new Map([
        [
          address,
          marketFields({ marketCap: 200000, liquidity: { usd: 30000 } }),
        ],
      ]),
      sources: [{ name: 'DexScreener 实时行情', status: 'ok' }],
    }),
    autoSchedule: false,
  });
  m.configure({
    chains: ['bsc'],
    minCap: 10000,
    maxCap: 5e6,
    minLiquidity: 5000,
  });
  await m.refresh();
  await m.tickMarket();
  const c = m.state.candidates[0];
  assert.equal(c.marketCap, 200000, '行情确实合并进去了');
  assert.equal(c.image, 'https://gmgn.ai/external-res/logo.webp');
  m.pause();
});
