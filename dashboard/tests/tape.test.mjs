import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTape, mergeTape, eligibleBuy } from '../scanner/tape.mjs';
const now = 1788658000000;
const event = {
  id: 53992,
  ts: now / 1000 - 20,
  side: 'buy',
  tx: `0x${'a'.repeat(64)}`,
  token: `0x${'1'.repeat(40)}`,
  wallet: `0x${'2'.repeat(40)}`,
  handle: 'downhorrndously',
  symbol: 'FUGAZI',
  usd: 397,
  amount: 8917204,
  price: 0.0000445,
  priced: 'cash_leg',
  flags: [],
  is_stock: 0,
  new_position: 1,
};
export const fixture = event;
test('tape uses the upstream event ID and keeps profile, wallet and CA distinct', () => {
  const [t] = normalizeTape([event]);
  assert.equal(t.id, 'trenches:robinhood:53992');
  assert.equal(t.address, event.token);
  assert.equal(t.wallet, event.wallet);
  assert.equal(t.profileUrl, 'https://fomo.family/profile/downhorrndously');
  assert.equal(t.tx, event.tx);
  assert.equal(eligibleBuy(t, now), true);
});
test('overlapping polls deduplicate IDs, preserve multiple fills per transaction and accept corrections', () => {
  const first = normalizeTape([event]);
  const second = normalizeTape([
    event,
    { ...event, id: 53993, wallet: `0x${'3'.repeat(40)}` },
  ]);
  const merged = mergeTape(first, second);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].eventId, 53993);
  const corrected = mergeTape(
    merged,
    normalizeTape([{ ...event, flags: ['not a real buy (planted)'] }]),
  );
  assert.equal(corrected.length, 2);
  assert.equal(eligibleBuy(corrected[1], now), false);
});
test('only recent priced non-stock unflagged BUY observations can trigger scans', () => {
  for (const change of [
    { side: 'sell' },
    { priced: 'no_cash_leg' },
    { priced: true },
    { flags: ['not a real buy (planted)'] },
    { flags: undefined },
    { is_stock: 1 },
    { is_stock: undefined },
    { usd: 0 },
    { usd: null },
    { price: null },
    { ts: now / 1000 - 121 },
    { ts: now / 1000 + 61 },
  ]) {
    const [t] = normalizeTape([{ ...event, ...change }]);
    assert.equal(eligibleBuy(t, now), false, JSON.stringify(change));
  }
  assert.equal(
    mergeTape([], normalizeTape([{ ...event, token: 'bad' }])).length,
    0,
  );
  assert.equal(normalizeTape([{ ...event, id: null }]).length, 0);
});
test('an unknown handle does not invent a FOMO profile and history is bounded', () => {
  const [t] = normalizeTape([{ ...event, handle: null }]);
  assert.equal(t.profileUrl, null);
  assert.equal(
    mergeTape(
      [],
      Array.from({ length: 410 }, (_, i) => ({
        ...t,
        id: String(i),
        eventId: i,
      })),
    ).length,
    400,
  );
});

test('a malformed correction with a valid event ID retracts the prior observation', () => {
  for (const change of [{ ts: null }, { token: 'bad' }, { side: 'unknown' }]) {
    const previous = normalizeTape([event]);
    const corrected = mergeTape(
      previous,
      normalizeTape([{ ...event, ...change }]),
    );
    assert.equal(corrected.length, 0);
  }
});
