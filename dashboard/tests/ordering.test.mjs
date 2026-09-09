import test from 'node:test';
import assert from 'node:assert/strict';
import { orderCandidates, SORTS } from '../scanner/risk.mjs';
import { millis } from '../scanner/values.mjs';

const MIN = 60000;
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
// Ages in minutes, in the order discovery produced them. `null` = no timestamp.
const list = (...ages) =>
  ages.map((age, i) => ({
    id: `t${i}`,
    createdAt: age === null ? null : NOW - age * MIN,
  }));
const ids = (rows) => rows.map((c) => c.id);
const ages = (rows) =>
  rows.map((c) => (c.createdAt === null ? null : (NOW - c.createdAt) / MIN));

test('heat is the discovery order, untouched and not copied into a new shape', () => {
  const rows = list(40, 3, null, 2);
  assert.equal(orderCandidates(rows, 'heat'), rows);
  assert.equal(orderCandidates(rows, undefined), rows);
  assert.deepEqual(SORTS, ['heat', 'new']);
});

test('new puts the youngest first while undated rows keep their heat position', () => {
  // Heat order: 40分, 未知, 3分, 未知, 2天. Positions 1 and 3 are pinned.
  const rows = list(40, null, 3, null, 2880);
  assert.deepEqual(ages(orderCandidates(rows, 'new')), [3, null, 40, null, 2880]);
});

test('an all-undated or empty list is returned as it came in', () => {
  const undated = list(null, null, null);
  assert.equal(orderCandidates(undated, 'new'), undated);
  assert.deepEqual(orderCandidates([], 'new'), []);
});

test('every input row survives re-ordering exactly once', () => {
  const rows = list(40, null, 3, null, 2880, 7, null);
  const out = orderCandidates(rows, 'new');
  assert.equal(out.length, rows.length);
  assert.deepEqual(new Set(ids(out)), new Set(ids(rows)));
});

test('rows created in the same second keep their relative heat order', () => {
  const rows = [
    { id: 'low-heat', createdAt: NOW - MIN },
    { id: 'unrelated', createdAt: NOW - 5 * MIN },
    { id: 'high-heat', createdAt: NOW - MIN },
  ];
  // Ties must not reshuffle between polls, so the earlier index wins.
  assert.deepEqual(ids(orderCandidates(rows, 'new')), [
    'low-heat',
    'high-heat',
    'unrelated',
  ]);
  assert.deepEqual(ids(orderCandidates(orderCandidates(rows, 'new'), 'new')), [
    'low-heat',
    'high-heat',
    'unrelated',
  ]);
});

test('a malformed timestamp is treated as absent, never as brand new', () => {
  const rows = [
    { id: 'text', createdAt: 'soon' },
    { id: 'old', createdAt: NOW - 90 * MIN },
    { id: 'missing' },
    { id: 'young', createdAt: NOW - MIN },
  ];
  assert.deepEqual(ids(orderCandidates(rows, 'new')), [
    'text',
    'young',
    'missing',
    'old',
  ]);
});

test('seconds and milliseconds from different sources compare on one scale', () => {
  // GMGN reports seconds, DexScreener pairCreatedAt reports milliseconds.
  const gmgn = millis(NOW / 1000 - 600);
  const dexscreener = millis(NOW - 30 * MIN);
  assert.equal(gmgn, NOW - 600000);
  assert.equal(dexscreener, NOW - 30 * MIN);
  assert.equal(millis(dexscreener), dexscreener);
  assert.equal(millis(0), null);
  assert.equal(millis('x'), null);
  assert.deepEqual(
    ids(
      orderCandidates(
        [
          { id: 'dexscreener', createdAt: dexscreener },
          { id: 'gmgn', createdAt: gmgn },
        ],
        'new',
      ),
    ),
    ['gmgn', 'dexscreener'],
  );
});
