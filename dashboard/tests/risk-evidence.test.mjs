import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRisk } from '../scanner/risk.mjs';
const candidate = {
  chain: 'robinhood',
  address: `0x${'a'.repeat(40)}`,
  liquidity: 50000,
};
const find = (r, id) => r.findings.find((f) => f.id === id);

test('GMGN positive privileges are retained even when GoPlus is absent or contradicts them', () => {
  const r = evaluateRisk(candidate, {
    security: {
      privileges: [
        'hidden_owner',
        'pausable',
        'take_back_ownership',
        'max_tx_amount',
        'multi_address',
      ],
    },
    goplus: { hidden_owner: '0' },
  });
  for (const id of ['hidden-owner', 'pause-transfer', 'restore-owner']) {
    assert.equal(find(r, id).severity, 'high');
    assert.match(find(r, id).source, /GMGN/);
  }
  assert.ok(
    r.findings.some(
      (f) => f.id === 'gmgn-privileges' && f.value.includes('multi_address'),
    ),
  );
});
test('an empty GMGN privilege list never proves omitted permissions safe', () => {
  const r = evaluateRisk(candidate, {
    security: {
      privileges: [],
      renounced_mint: false,
      renounced_freeze_account: false,
    },
  });
  assert.equal(find(r, 'mint').severity, 'unknown');
  assert.equal(find(r, 'hidden-owner').severity, 'unknown');
});
test('missing checks explain closed-source and unrecognized-DEX response boundaries', () => {
  const r = evaluateRisk(candidate, {
    goplus: { is_open_source: '0', is_in_dex: '0', token_name: 'PEZZED' },
    security: { is_honeypot: null },
  });
  assert.match(find(r, 'mint').detail, /GoPlus.*源码/);
  assert.match(find(r, 'sell').detail, /GoPlus.*交易池/);
  assert.match(find(r, 'sell-all').detail, /GoPlus.*交易池/);
  assert.equal(find(r, 'sell').severity, 'unknown');
});
test('GMGN lock summary is shown as a reported aggregate, never a verified position lock', () => {
  const r = evaluateRisk(candidate, {
    info: {
      pool: { exchange: 'uniswap_v4', pool_address: '0x' + 'b'.repeat(64) },
    },
    security: {
      burn_ratio: '0',
      lock_summary: {
        is_locked: false,
        lock_percent: '0',
        left_lock_percent: '1',
        lock_detail: [{ pool: 'burnt', percent: '0', is_blackhole: true }],
      },
    },
  });
  assert.ok(find(r, 'lp-summary'));
  assert.match(find(r, 'lp-summary').detail, /未锁定/);
  assert.match(find(r, 'lp').detail, /V4/);
  assert.equal(find(r, 'lp').severity, 'unknown');
  assert.equal(find(r, 'lp-summary').value.lockPercent, 0);
});
test('unknown lock ratio stays unknown; malformed zero defaults do not become a lock', () => {
  const r = evaluateRisk(candidate, {
    security: { lock_summary: { is_locked: null, lock_percent: '' } },
  });
  assert.equal(find(r, 'lp').severity, 'unknown');
  assert.equal(find(r, 'lp-summary'), undefined);
});
test('numeric source/owner states are parsed and conflicting source results are retained', () => {
  const r = evaluateRisk(candidate, {
    security: { open_source: 1, renounced: 1 },
    goplus: { is_open_source: '0' },
  });
  assert.ok(find(r, 'source-conflict'));
  assert.equal(find(r, 'owner').severity, 'info');
  const unknown = evaluateRisk(candidate, {
    security: {
      open_source: -1,
      renounced: -1,
      is_honeypot: null,
      honeypot: -1,
    },
  });
  assert.equal(find(unknown, 'owner').severity, 'unknown');
  assert.equal(find(unknown, 'sell').severity, 'unknown');
});
test('report completeness counts field results, not one whole class as complete', () => {
  const r = evaluateRisk(candidate, {
    security: { buy_tax: '0', sell_tax: '0' },
  });
  assert.ok(r.evidenceSummary.unknown > 0);
  assert.equal(r.evidenceSummary.total, r.findings.length);
  assert.equal(
    r.evidenceSummary.checked + r.evidenceSummary.unknown,
    r.evidenceSummary.total,
  );
});

test('RPC evidence applies only to the original token CA and does not declare all ownership renounced', () => {
  const zero = '0x' + '0'.repeat(40);
  const other = '0x' + 'b'.repeat(40);
  const r = evaluateRisk(candidate, {
    contract: {
      address: candidate.address,
      codePresent: true,
      owner: zero,
      block: 20,
    },
  });
  assert.equal(find(r, 'owner').severity, 'info');
  assert.match(find(r, 'owner').detail, /不能据此推断/);
  const wrong = evaluateRisk(candidate, {
    contract: { address: other, codePresent: true, owner: zero, block: 20 },
  });
  assert.equal(find(wrong, 'owner').severity, 'unknown');
});
test('integer honeypot and sell-restriction positives are never erased by zero counters', () => {
  for (const security of [
    { honeypot: 1, can_sell: 0, can_not_sell: 0 },
    { can_not_sell: 1 },
  ]) {
    assert.equal(
      find(evaluateRisk(candidate, { security }), 'sell').severity,
      'critical',
    );
  }
  assert.equal(
    find(
      evaluateRisk(candidate, {
        security: { honeypot: -1, can_sell: 0, can_not_sell: 0 },
      }),
      'sell',
    ).severity,
    'unknown',
  );
});

// The panel drops a candidate from 热门候选 when this flag is set, so what it
// must never do is fire on a coin nobody managed to test.
test('an unsellable coin is flagged only when a source actually reported it', () => {
  const sold = (data) => evaluateRisk(candidate, data).unsellable;

  // Nothing obtained: the common case, and every Robinhood coin, since no
  // independent sell simulation is wired up for that chain.
  assert.equal(sold({}), false, '未取得卖出检测不能当成卖不出去');
  assert.equal(sold({ goplus: { is_honeypot: '0' } }), false);
  assert.equal(
    sold({ honeypot: { simulationSuccess: false } }),
    false,
    '模拟失败只是没结论，不是已检出',
  );

  // A capability the owner holds is not a sale that fails today.
  assert.equal(
    sold({ security: { privileges: ['pausable'] }, goplus: { slippage_modifiable: '1' } }),
    false,
    '可暂停转账、可修改税率是能力，不是当前不可卖',
  );

  // Each source that can report it, on its own.
  assert.equal(sold({ goplus: { is_honeypot: '1' } }), true);
  assert.equal(sold({ security: { can_not_sell: 1 } }), true);
  assert.equal(
    sold({ honeypot: { simulationSuccess: true, honeypotResult: { isHoneypot: true } } }),
    true,
  );
  assert.equal(sold({ goplus: { cannot_sell_all: '1' } }), true);

  // A conflict is not a clearance: one source reporting it is enough to hide,
  // and the row keeps both sides of the conflict in its evidence.
  const conflict = evaluateRisk(candidate, {
    goplus: { is_honeypot: '1' },
    honeypot: { simulationSuccess: true, honeypotResult: { isHoneypot: false } },
  });
  assert.equal(conflict.unsellable, true, '冲突时不能按未检出那一方放行');
  assert.ok(find(conflict, 'sell-conflict'), '隐藏之后证据里仍要留着冲突');
});
