import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileFindings, formatAge } from '../scanner/profile.mjs';
import { evaluateRisk } from '../scanner/risk.mjs';

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const at = (n) => buildProfileFindings(n.data ?? {}, n.candidate ?? {}, NOW);
const find = (findings, id) => findings.find((f) => f.id === id);

test('a response with none of these fields adds nothing to the unverified count', () => {
  assert.deepEqual(at({}), []);
  assert.deepEqual(at({ data: { info: {}, security: {}, holders: {} } }), []);
  assert.deepEqual(at({ data: { info: { price: 'not-an-object' } } }), []);
});

test('creation time is read from seconds or milliseconds and future stamps are dropped', () => {
  const seconds = find(
    at({ data: { info: { creation_timestamp: NOW / 1000 - 7200 } } }),
    'age',
  );
  assert.equal(seconds.value.createdAt, NOW - 7200000);
  assert.equal(seconds.value.ageMs, 7200000);
  assert.equal(seconds.severity, 'info');
  assert.match(seconds.detail, /合约创建至今 2 小时/);

  // The Robinhood discovery path carries pair_created_at in milliseconds.
  const millis = find(at({ candidate: { createdAt: NOW - 86400000 } }), 'age');
  assert.equal(millis.value.createdAt, NOW - 86400000);
  assert.equal(millis.source, 'GMGN 发现阶段创建时间');

  assert.equal(at({ data: { info: { creation_timestamp: NOW / 1000 + 600 } } }).length, 0);
  assert.equal(at({ data: { info: { creation_timestamp: 0 } } }).length, 0);
});

test('a token under an hour old is graded medium and says why the other samples are thin', () => {
  const young = find(
    at({ data: { info: { creation_timestamp: NOW / 1000 - 900 } } }),
    'age',
  );
  assert.equal(young.severity, 'medium');
  assert.equal(young.group, 'contract');
  assert.match(young.detail, /不足 1 小时/);
  assert.match(young.detail, /年龄本身不是风险判定/);
  assert.equal(formatAge(900000), '15 分钟');
  assert.equal(formatAge(-1), '未知');
});

test('rug scores keep every source field, show the highest and grade on the published bands', () => {
  const both = find(
    at({
      data: { info: { rug_ratio: '0.42' }, security: { rug_ratio: 0.12 } },
    }),
    'rug-ratio',
  );
  assert.equal(both.severity, 'high');
  assert.equal(both.value.ratio, 0.42);
  assert.equal(both.value.observations.length, 2);
  assert.match(both.detail, /字段不一致，显示最高观察值/);
  assert.match(both.detail, /低分同样不能当作安全/);

  assert.equal(find(at({ data: { info: { rug_ratio: 0.2 } } }), 'rug-ratio').severity, 'medium');
  assert.equal(find(at({ data: { info: { rug_ratio: 0.05 } } }), 'rug-ratio').severity, 'info');
  assert.equal(at({ data: { info: { rug_ratio: 1.4 } } }).length, 0);
});

test('the discovery rug_ratio is only repeated below the threshold that already raises rug-label', () => {
  assert.equal(find(at({ candidate: { rugRatio: 0.2 } }), 'rug-ratio').value.ratio, 0.2);
  assert.equal(find(at({ candidate: { rugRatio: 0.44 } }), 'rug-ratio'), undefined);
  // A separately reported field still stands on its own.
  const kept = find(
    at({ data: { info: { rug_ratio: 0.05 } }, candidate: { rugRatio: 0.44 } }),
    'rug-ratio',
  );
  assert.deepEqual(
    kept.value.observations.map((o) => o.field),
    ['info.rug_ratio'],
  );
});

test('the 5 minute window is computed from the reported end points and stays an observation', () => {
  const flow = find(
    at({
      data: {
        info: {
          price: {
            price: '0.0012',
            price_5m: '0.001',
            buys_5m: 34,
            sells_5m: 12,
            buy_volume_5m: '5000',
            sell_volume_5m: '3000',
            volume_5m: '8000',
          },
        },
      },
    }),
    'flow-5m',
  );
  assert.equal(flow.group, 'liquidity');
  assert.equal(flow.severity, 'info');
  assert.ok(Math.abs(flow.value.change - 0.2) < 1e-9);
  assert.equal(flow.value.netUsd, 2000);
  assert.match(flow.detail, /买 34 笔 \/ 卖 12 笔/);
  assert.match(flow.detail, /看不到窗口内的 K 线形态/);
  assert.match(flow.detail, /不参与风险判级/);
});

test('a half filled 5 minute window reports what came back instead of inventing zeros', () => {
  const partial = find(
    at({ data: { info: { price: { buys_5m: 3, sells_5m: 0 } } } }),
    'flow-5m',
  );
  assert.equal(partial.value.change, null);
  assert.equal(partial.value.netUsd, null);
  assert.match(partial.detail, /价格 未知/);
  assert.match(partial.detail, /净值 未知/);
  // A zero divisor must not become an infinite move.
  const zeroOpen = find(
    at({ data: { info: { price: { price: '1', price_5m: '0', buys_5m: 1 } } } }),
    'flow-5m',
  );
  assert.equal(zeroOpen.value.change, null);
});

test('wallet classes report source counts and the local sample separately', () => {
  const tags = find(
    at({
      data: {
        info: { wallet_tags_stat: { sniper_wallets: 7, bundler_wallets: 0 } },
        holders: {
          list: [
            { tags: ['sniper', 'sniper'], maker_token_tags: ['sniper'] },
            { tags: ['bundler'], maker_token_tags: null },
            { tags: null },
          ],
        },
      },
    }),
    'wallet-tags',
  );
  assert.equal(tags.group, 'holders');
  assert.equal(tags.severity, 'medium');
  assert.deepEqual(tags.value.counts, { sniper_wallets: 7, bundler_wallets: 0 });
  // One wallet tagged twice with the same string is still one wallet.
  assert.deepEqual(tags.value.sample, { size: 3, tags: { sniper: 1, bundler: 1 } });
  assert.match(tags.detail, /狙击 7、捆绑 0/);
  assert.match(tags.detail, /来源没有公布这些计数的分母/);
  assert.match(tags.detail, /分母是这 3 个样本，不是全链持有人/);
  assert.match(tags.detail, /触发复核阈值：狙击钱包 7 个/);
  assert.match(tags.detail, /不是对钱包身份或作恶的认定/);
});

test('wallet classes below the review threshold stay an observation', () => {
  const low = find(
    at({ data: { info: { wallet_tags_stat: { sniper_wallets: 4 } } } }),
    'wallet-tags',
  );
  assert.equal(low.severity, 'info');
  assert.doesNotMatch(low.detail, /触发复核阈值/);
  // Tags present only in the local sample still produce evidence.
  const sampleOnly = find(
    at({ data: { holders: { list: [{ tags: ['smart_money'] }] } } }),
    'wallet-tags',
  );
  assert.match(sampleOnly.detail, /来源未返回钱包分类统计/);
  assert.equal(sampleOnly.severity, 'info');
});

test('the new evidence joins the existing six groups without moving the coverage denominator', () => {
  const report = evaluateRisk(
    { chain: 'sol', address: 'x', rugRatio: 0.2 },
    {
      info: {
        symbol: 'T',
        creation_timestamp: Date.now() / 1000 - 600,
        rug_ratio: 0.2,
        price: { price: '2', price_5m: '1', buys_5m: 5, sells_5m: 1 },
        wallet_tags_stat: { sniper_wallets: 9 },
      },
    },
  );
  const added = ['age', 'rug-ratio', 'flow-5m', 'wallet-tags'].map((id) =>
    find(report.findings, id),
  );
  assert.ok(added.every(Boolean));
  assert.deepEqual(
    added.map((f) => f.group),
    ['contract', 'honeypot', 'liquidity', 'holders'],
  );
  assert.ok(report.coverage <= 6);
  assert.equal(
    report.evidenceSummary.checked + report.evidenceSummary.unknown,
    report.findings.length,
  );
  assert.equal(new Set(report.findings.map((f) => f.id)).size, report.findings.length);
});
