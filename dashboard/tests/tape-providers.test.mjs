import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTape, resolveTape } from '../scanner/providers.mjs';
import { mergeTape } from '../scanner/tape.mjs';
const base = {
  ts: Date.now() / 1000,
  token: `0x${'1'.repeat(40)}`,
  wallet: `0x${'2'.repeat(40)}`,
  tx: `0x${'a'.repeat(64)}`,
  side: 'buy',
  usd: 100,
  price: 0.1,
  priced: 'cash_leg',
  flags: [],
  is_stock: 0,
};
test('full snapshots periodically pick up corrections outside the latest 60 rows', async () => {
  const originalFetch = globalThis.fetch,
    originalNow = Date.now;
  let now = originalNow(),
    corrected = false;
  const limits = [];
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    const limit = Number(new URL(url).searchParams.get('limit'));
    limits.push(limit);
    const rows = Array.from({ length: Math.min(limit, 100) }, (_, i) => ({
      ...base,
      id: 200 - i,
      flags: corrected && i === 90 ? ['not a real buy (planted)'] : [],
    }));
    return new Response(JSON.stringify(rows));
  };
  try {
    let r = await fetchTape();
    let events = mergeTape([], r.data.events);
    corrected = true;
    now += 5000;
    r = await fetchTape(events);
    events = mergeTape(events, r.data.events);
    now += 60000;
    r = await fetchTape(events);
    events = mergeTape(events, r.data.events);
    assert.deepEqual(limits, [400, 60, 400]);
    assert.equal(events.find((t) => t.eventId === 110).flags.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});
test('market-cap resolution uses matching base-token pools and never substitutes FDV', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([
        {
          chainId: 'base',
          baseToken: { address: base.token },
          marketCap: 1,
          liquidity: { usd: 999999 },
        },
        {
          chainId: 'robinhood',
          baseToken: { address: base.wallet },
          quoteToken: { address: base.token },
          marketCap: 2,
          liquidity: { usd: 999999 },
        },
        {
          chainId: 'robinhood',
          baseToken: { address: base.token },
          fdv: 50000,
          liquidity: { usd: 9000 },
        },
      ]),
    );
  try {
    const r = await resolveTape([
      {
        candidateId: `robinhood:${base.token}`,
        address: base.token,
        symbol: 'TEST',
      },
    ]);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].marketCap, null);
    assert.equal(r.candidates[0].liquidity, 9000);
  } finally {
    globalThis.fetch = original;
  }
});
