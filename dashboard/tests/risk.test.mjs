import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flag,
  fraction,
  validAddress,
  evaluateRisk,
  analyzeSocial,
  selectCandidates,
} from '../scanner/risk.mjs';

test('API strings and missing fields retain three states', () => {
  assert.equal(flag('0'), false);
  assert.equal(flag('1'), true);
  assert.equal(flag(''), null);
  assert.equal(flag(null), null);
  assert.equal(fraction('0.17'), 0.17);
  assert.equal(fraction('17'), null);
  assert.equal(fraction(''), null);
});
test('chain/address validation prevents argument injection', () => {
  assert.equal(validAddress('eth', '0x' + 'a'.repeat(40)), true);
  assert.equal(validAddress('eth', ';curl evil'), false);
  assert.equal(
    validAddress('sol', 'So11111111111111111111111111111111111111112'),
    true,
  );
  assert.equal(validAddress('bad', '0x' + 'a'.repeat(40)), false);
});
test('missing sources and failed simulation never pass', () => {
  const r = evaluateRisk(
    { chain: 'eth' },
    {
      honeypot: {
        simulationSuccess: false,
        honeypotResult: { isHoneypot: false },
      },
    },
  );
  assert.equal(r.findings.find((x) => x.id === 'sell').severity, 'unknown');
  assert.equal(r.verdict, '证据不足');
  assert.equal(r.coverage, 0);
});
test('confirmed honeypot dominates and source supply-lock does not become LP-lock', () => {
  const r = evaluateRisk(
    { chain: 'eth' },
    { info: { locked_ratio: 1 }, security: { is_honeypot: true } },
  );
  assert.equal(r.verdict, '严重风险');
  assert.equal(r.findings.find((x) => x.id === 'lp').severity, 'unknown');
});
test('ownership renounced never cancels mint or blacklist privileges', () => {
  const r = evaluateRisk(
    { chain: 'eth' },
    {
      goplus: {
        owner_address: '0x0000000000000000000000000000000000000000',
        is_mintable: '1',
        is_blacklisted: '1',
      },
    },
  );
  assert.ok(r.findings.some((x) => x.id === 'mint' && x.severity === 'high'));
});
test('pool addresses excluded from concentration; shared funder not proof of same owner', () => {
  const r = evaluateRisk(
    { chain: 'sol' },
    {
      holders: {
        list: [
          { address: 'pool', addr_type: 2, amount_percentage: 0.8 },
          {
            address: 'a',
            amount_percentage: 0.15,
            native_transfer: { address: 'f' },
          },
          {
            address: 'b',
            amount_percentage: 0.05,
            native_transfer: { address: 'f' },
          },
        ],
      },
    },
  );
  assert.ok(Math.abs(r.walletSummary.top10 - 0.2) < 0.00001);
  assert.equal(r.walletSummary.excluded, 1);
  assert.equal(r.walletSummary.clusters[0].wallets.length, 2);
});
test('X duplicate tweets do not become independent human voices', () => {
  const r = analyzeSocial({
    data: [
      { id: '1', author_id: 'a', text: 'moon moon' },
      { id: '1', author_id: 'a', text: 'moon moon' },
      { id: '2', author_id: 'b', text: 'moon moon' },
    ],
    includes: { users: [] },
  });
  assert.equal(r.posts, 2);
  assert.equal(r.authors, 2);
  assert.equal(r.duplicateRatio, 0.5);
  assert.equal(r.verdict, '样本不足');
  assert.equal(r.humanProbability, undefined);
});
test('low-cap discovery excludes unknown market cap and keeps liquidity filter', () => {
  const x = selectCandidates(
    [
      { marketCap: null, liquidity: 10000 },
      { marketCap: 100000, liquidity: 20000 },
      { marketCap: 2e7, liquidity: 50000 },
    ],
    { minCap: 10000, maxCap: 5e6, minLiquidity: 5000 },
  );
  assert.equal(x.selected.length, 1);
  assert.equal(x.unknownCap, 1);
});
test('Solana GoPlus restrictions are not discarded when RugCheck is missing', () => {
  const r = evaluateRisk(
    { chain: 'sol' },
    {
      goplus: {
        mintable: { status: '1' },
        freezable: { status: '1' },
        non_transferable: '1',
        transfer_fee_upgradable: { status: '1' },
      },
    },
  );
  assert.ok(r.findings.some((f) => f.id === 'mint' && f.severity === 'high'));
  assert.ok(
    r.findings.some(
      (f) => f.id === 'non-transferable' && f.severity === 'high',
    ),
  );
});
test('dangerous EVM privileges and partial sell restrictions remain visible', () => {
  const r = evaluateRisk(
    { chain: 'eth' },
    {
      goplus: {
        hidden_owner: '1',
        owner_change_balance: '1',
        cannot_sell_all: '1',
      },
    },
  );
  assert.ok(
    r.findings.some((f) => f.id === 'hidden-owner' && f.severity === 'high'),
  );
  assert.ok(
    r.findings.some((f) => f.id === 'sell-all' && f.severity === 'high'),
  );
});
test('contradictory taxes retain higher observation and explicit conflict', () => {
  const r = evaluateRisk(
    { chain: 'eth' },
    {
      goplus: { sell_tax: '1' },
      honeypot: { simulationSuccess: true, simulationResult: { sellTax: 0 } },
    },
  );
  assert.equal(r.findings.find((f) => f.id === 'tax').value.sellTax, 1);
  assert.ok(r.findings.some((f) => f.id === 'tax-conflict'));
});
test('a locker wallet share is not the amount still locked', () => {
  const r = evaluateRisk(
    { chain: 'eth' },
    {
      goplus: {
        lp_holders: [
          {
            address: 'locker',
            percent: '0.8',
            is_locked: '1',
            locked_detail: [
              { amount: '799', end_time: '1000' },
              { amount: '1', end_time: String(Date.now() / 1000 + 3600) },
            ],
          },
        ],
      },
    },
  );
  const lock = r.findings.find((f) => f.id === 'lp').value.locks[0];
  assert.equal(lock.activeLockedShare, null);
  assert.equal(lock.holderShare, 0.8);
  assert.equal(lock.share, undefined);
});
test('known GoPlus pool excluded from fallback wallet concentration', () => {
  const r = evaluateRisk(
    { chain: 'eth' },
    {
      goplus: {
        dex: [{ pair: 'pool' }],
        holders: [
          { address: 'pool', percent: '0.9' },
          { address: 'wallet', percent: '0.1' },
        ],
      },
    },
  );
  assert.equal(r.walletSummary.top10, 0.1);
  assert.equal(r.walletSummary.excluded, 1);
});
test('URL-only posts do not become duplicate-text evidence', () => {
  const raw = {
    data: Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      author_id: String(i),
      text: `https://example.com/${i}`,
    })),
  };
  const social = analyzeSocial(raw);
  assert.equal(social.duplicateRatio, null);
  const report = evaluateRisk({ chain: 'sol' }, { social: raw });
  assert.equal(
    report.findings.find((f) => f.id === 'social').severity,
    'unknown',
  );
});
test('missing account and post times are explicitly incomplete social checks', () => {
  const raw = {
    data: Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      author_id: String(i),
      text: `unique opinion ${i}`,
    })),
  };
  const social = analyzeSocial(raw);
  assert.equal(social.verdict, '字段不足');
  assert.ok(social.missingChecks.includes('账号年龄'));
  const report = evaluateRisk({ chain: 'sol' }, { social: raw });
  assert.equal(
    report.findings.find((f) => f.id === 'social').severity,
    'unknown',
  );
});
