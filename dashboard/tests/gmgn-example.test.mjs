import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRisk } from '../scanner/risk.mjs';

// Public GMGN response for the user's example, observed 2026-09-06 02:05 UTC.
const candidate = {
  chain: 'robinhood',
  address: '0x385f4f8ae47651ce5f58f5265395a669f8281e18',
  liquidity: 2160189,
};
const example = {
  info: {
    symbol: 'MEME',
    trade_fee: '305.76407621084905',
    total_fee: '579.0967022413008',
    pool: { exchange: 'uniswap_v4' },
    stat: {
      top_10_holder_rate: '0.1085',
      creator_hold_rate: '0',
      dev_team_hold_rate: '0',
      top_rat_trader_percentage: '0',
      top_bundler_trader_percentage: '0.0002',
      top_entrapment_trader_percentage: '0.6717',
      bot_degen_rate: '0.6575',
      fresh_wallet_rate: '0.1228',
    },
    dev: { creator_token_status: 'creator_close' },
    wallet_tags_stat: { bundler_wallets: 1000 },
  },
  security: {
    is_open_source: true,
    is_blacklist: false,
    is_honeypot: false,
    is_renounced: true,
    buy_tax: '0',
    sell_tax: '0',
    burn_ratio: '0',
    privileges: null,
    lock_summary: {
      is_locked: true,
      lock_percent: '0',
      left_lock_percent: '0',
      lock_detail: [
        {
          percent: '0.95',
          pool: '0x0000000000000000000000000000000000000000',
          is_blackhole: true,
        },
      ],
    },
  },
};
const finding = (r, id) => r.findings.find((f) => f.id === id);

test('blank and non-scalar ratios never turn into reported zero holdings or LP percentages', () => {
  for (const invalid of [' ', '\t', [], ['0'], {}]) {
    const r = evaluateRisk(candidate, {
      info: {
        stat: {
          creator_hold_rate: invalid,
          top_10_holder_rate: invalid,
          top_entrapment_trader_percentage: invalid,
          bot_degen_rate: invalid,
        },
      },
      security: { lock_summary: { lock_detail: [{ percent: invalid }] } },
    });
    for (const id of [
      'dev-current',
      'holders-reported',
      'trader-profile',
      'wallet-profile',
    ])
      assert.equal(finding(r, id), undefined);
    assert.equal(
      finding(r, 'lp-summary').value.detailObservations[0].share,
      null,
    );
    assert.equal(finding(r, 'lp-summary').severity, 'unknown');
  }
});

test('MEME blackhole detail 95% is visible despite zero aggregate fields, without verifying a V4 lock', () => {
  const r = evaluateRisk(candidate, example);
  const lp = finding(r, 'lp-summary');
  assert.match(lp.detail, /黑洞.*95(?:\.0+)?%/);
  assert.match(lp.detail, /口径/);
  assert.equal(lp.value.detailObservations[0].share, 0.95);
  assert.equal(lp.value.lockPercent, 0);
  assert.equal(lp.value.burnRatio, 0);
  assert.equal(finding(r, 'lp').severity, 'unknown');
  assert.equal(finding(r, 'mint').severity, 'unknown');
});

test('LP rows preserve independent scopes, never add overlapping percentages into a full-pool claim', () => {
  const data = structuredClone(example);
  const rows = data.security.lock_summary.lock_detail;
  rows.push(
    { ...rows[0] },
    { percent: '0.95', pool: 'burnt', is_blackhole: true },
  );
  const lp = finding(evaluateRisk(candidate, data), 'lp-summary');
  assert.equal(lp.value.detailObservations.length, 2);
  assert.doesNotMatch(lp.detail, /190|285/);
  assert.match(lp.detail, /不相加/);
});

test('detail-only LP response remains visible and invalid percentages do not become zero or safe', () => {
  const r = evaluateRisk(candidate, {
    security: {
      lock_summary: {
        lock_detail: [
          { percent: '0.95', pool: 'burnt', is_blackhole: true },
          { percent: '', pool: 'other', is_blackhole: null },
          { percent: '95', pool: 'third', is_blackhole: true },
        ],
      },
    },
  });
  const lp = finding(r, 'lp-summary');
  assert.equal(lp.value.detailObservations[1].share, null);
  assert.equal(lp.value.detailObservations[2].share, null);
  assert.match(lp.detail, /未知/);
  assert.equal(finding(r, 'lp').severity, 'unknown');
});

test('GMGN Top10 and zero dev holdings survive without substituting for the local holder sample', () => {
  const r = evaluateRisk(candidate, example);
  assert.equal(finding(r, 'holders-reported').value.top10, 0.1085);
  assert.equal(r.walletSummary.top10, null);
  const dev = finding(r, 'dev-current');
  assert.equal(dev.value.creatorShare, 0);
  assert.equal(dev.value.teamShare, 0);
  assert.match(dev.detail, /已清仓/);
  assert.equal(finding(evaluateRisk(candidate, {}), 'dev-current'), undefined);
});

test('wallet tag volume ratios retain their units and entrapment 67.17% triggers a named heuristic', () => {
  const r = evaluateRisk(candidate, example);
  const traders = finding(r, 'trader-profile');
  assert.equal(traders.severity, 'medium');
  assert.match(traders.detail, /成交量/);
  assert.match(traders.detail, /67\.17%/);
  assert.match(traders.detail, /0\.02%/);
  assert.match(traders.detail, /30%/);
  assert.equal(traders.value.entrapmentVolume, 0.6717);
  assert.equal(traders.value.bundlerVolume, 0.0002);
  const wallets = finding(r, 'wallet-profile');
  assert.equal(wallets.value.freshWalletRate, 0.1228);
  assert.equal(wallets.value.botWalletRate, 0.6575);
  assert.equal(
    finding(evaluateRisk(candidate, {}), 'trader-profile'),
    undefined,
  );
});

test('zero token tax remains known while aggregate fees never become the page total trading tax', () => {
  const tax = finding(evaluateRisk(candidate, example), 'tax');
  assert.equal(tax.value.buyTax, 0);
  assert.equal(tax.value.sellTax, 0);
  assert.match(tax.detail, /总税率.*未取得/);
  assert.doesNotMatch(tax.detail, /579|305/);
});
