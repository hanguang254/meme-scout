import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flag,
  fraction,
  validAddress,
  evaluateRisk,
  analyzeSocial,
  selectCandidates,
  capByChain,
  BOARD_LIMIT,
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

// The board's row cap is shared across the selected chains rather than granted
// per chain, because the cap is really the scan queue's length. Sharing it is
// what makes a floor necessary: one busy chain would otherwise take every slot
// and a chain the user explicitly selected would show nothing at all.
const row = (chain, i) => ({ id: `${chain}:${i}`, chain });
const rowsOf = (chain, n) => Array.from({ length: n }, (_, i) => row(chain, i));
test('一条链时名额就是整块，没有保底这回事', () => {
  const rows = rowsOf('sol', 50);
  assert.equal(capByChain(rows, ['sol'], 40).length, 40);
  // Also the shape a page that has not reloaded sends, and a monitor that has
  // not been configured yet: neither may turn into an empty board.
  assert.equal(capByChain(rows, [], 40).length, 40);
  assert.equal(capByChain(rows, undefined, 40).length, 40);
  // A repeated chain is one chain, not two — otherwise the floor would halve
  // on a duplicate the page never meant to send.
  assert.equal(capByChain(rows, ['sol', 'sol'], 40).length, 40);
});
test('每条链都拿得到保底名额，剩下的仍按热度争', () => {
  // Heat order with one chain ahead everywhere: 45 Solana rows before a single
  // Arc row. Pure merit would end the board before Arc was ever reached.
  const rows = [...rowsOf('sol', 45), ...rowsOf('arc', 5)];
  const kept = capByChain(rows, ['sol', 'arc'], 40);
  assert.equal(kept.length, 40);
  const arc = kept.filter((r) => r.chain === 'arc');
  assert.equal(arc.length, 5, 'Arc 的保底名额是 20，有几个给几个');
  assert.equal(kept.filter((r) => r.chain === 'sol').length, 35);
  // A seat is a seat on the board, not a place above the rows that outranked
  // it: the kept rows stay in the order they arrived in.
  assert.deepEqual(kept, rows.filter((r) => kept.includes(r)));
  assert.equal(kept[0].id, 'sol:0');
  assert.equal(kept.at(-1).chain, 'arc');
});
test('用不完保底名额的链把剩下的让出来，不占着空位', () => {
  // 13 apiece with three chains, and eth brings two rows. The eleven it does
  // not use go back to the queue rather than shortening the board.
  const rows = [...rowsOf('sol', 60), ...rowsOf('arc', 60), ...rowsOf('eth', 2)];
  const kept = capByChain(rows, ['sol', 'arc', 'eth'], 40);
  assert.equal(kept.length, 40);
  assert.equal(kept.filter((r) => r.chain === 'eth').length, 2);
  assert.ok(kept.filter((r) => r.chain === 'arc').length >= 13);
  assert.equal(kept.filter((r) => r.chain === 'sol').length, 40 - 2 - 13);
});
test('保底名额不会把没选的链带上榜，也不会多于总数', () => {
  // A row whose chain is not selected has no floor and competes on merit alone.
  const rows = [...rowsOf('doge', 40), ...rowsOf('sol', 10), ...rowsOf('arc', 10)];
  const kept = capByChain(rows, ['sol', 'arc'], 40);
  assert.equal(kept.length, 40);
  assert.equal(kept.filter((r) => r.chain === 'sol').length, 10);
  assert.equal(kept.filter((r) => r.chain === 'arc').length, 10);
  // Fewer rows than the cap is not an error and must not be padded.
  assert.equal(capByChain(rowsOf('sol', 3), ['sol', 'arc'], 40).length, 3);
  assert.equal(capByChain([], ['sol', 'arc'], 40).length, 0);
  assert.equal(BOARD_LIMIT, 40);
});
