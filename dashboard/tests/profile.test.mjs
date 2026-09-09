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

test('the holder count keeps both reported fields and is labelled as addresses, not people', () => {
  const agree = find(
    at({ data: { info: { holder_count: 192, stat: { holder_count: 192 } } } }),
    'holder-count',
  );
  assert.equal(agree.group, 'holders');
  assert.equal(agree.severity, 'info');
  assert.equal(agree.value.holders, 192);
  assert.match(agree.detail, /来源报告 192 个持有地址/);
  assert.match(agree.detail, /这是地址数不是人数/);
  assert.match(agree.detail, /不参与风险判级/);
  assert.doesNotMatch(agree.detail, /不一致/);

  // The two snapshots can differ by a few addresses. Neither is dropped and
  // neither is averaged into a number no source reported.
  const split = find(
    at({ data: { info: { holder_count: 611, stat: { holder_count: 610 } } } }),
    'holder-count',
  );
  assert.equal(split.value.holders, 611);
  assert.deepEqual(
    split.value.observations.map((o) => o.value),
    [611, 610],
  );
  // Both labels must stay distinguishable: trimming each to its last segment
  // would print the same name twice and leave the reader unable to tell which
  // field reported which number.
  assert.match(split.detail, /holder_count 611 \/ stat\.holder_count 610 两个字段不一致，未取平均/);

  // A wider gap pins the headline to the field the source's own page shows.
  // Averaging would report a number neither field returned.
  const wide = find(
    at({ data: { info: { holder_count: 611, stat: { holder_count: 401 } } } }),
    'holder-count',
  );
  assert.equal(wide.value.holders, 611);
  assert.match(wide.detail, /来源报告 611 个持有地址/);

  // A count of zero is a real answer; a missing or malformed one is not.
  assert.equal(find(at({ data: { info: { holder_count: 0 } } }), 'holder-count').value.holders, 0);
  assert.equal(find(at({ data: { info: { holder_count: -3 } } }), 'holder-count'), undefined);
  assert.equal(find(at({ data: { info: { holder_count: null } } }), 'holder-count'), undefined);
});

test('the page-view count stays an observation and says the source published no window', () => {
  const visits = find(at({ data: { info: { visiting_count: '727' } } }), 'visiting-count');
  assert.equal(visits.severity, 'info');
  assert.equal(visits.value.visits, 727);
  assert.equal(visits.value.window, null);
  assert.equal(visits.value.deduplicated, null);
  assert.match(visits.detail, /没有公布统计窗口/);
  assert.match(visits.detail, /不能读成「727 个人在看」/);
  assert.equal(find(at({ data: { info: {} } }), 'visiting-count'), undefined);
});

// Filing it under `social` would let a page-view counter mark the discussion
// category covered, reporting six of six while X was never queried.
test('the page-view count cannot make the social category count as covered', () => {
  const report = evaluateRisk(
    { chain: 'sol', address: 'x' },
    { info: { symbol: 'T', visiting_count: 5000, image_dup_count: 4 } },
  );
  const visits = find(report.findings, 'visiting-count');
  assert.equal(visits.group, 'liquidity');
  assert.equal(
    report.findings.filter((f) => f.group === 'social' && f.severity !== 'unknown').length,
    0,
  );
  assert.ok(report.coverage < 6);
});

test('the duplicate-image count is shown as a number and never graded', () => {
  const dup = find(at({ data: { info: { image_dup_count: 4 } } }), 'image-dup');
  assert.equal(dup.group, 'contract');
  assert.equal(dup.severity, 'info');
  assert.equal(dup.value.imageDup, 4);
  assert.equal(dup.value.includesSelf, null);
  assert.match(dup.detail, /来源报告有 4 个代币在用同一张图片/);
  assert.match(dup.detail, /不据此判级/);
  // A high count is still not a risk grade: the source publishes no method.
  assert.equal(find(at({ data: { info: { image_dup_count: 900 } } }), 'image-dup').severity, 'info');
  assert.equal(find(at({ data: { info: { image_dup_count: 'x' } } }), 'image-dup'), undefined);
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
