import test from 'node:test';
import assert from 'node:assert/strict';
import { InsightX, parseMetrics, METRICS_TTL } from '../scanner/insightx.mjs';

// The bubble map is opened by hand, so every request here is one the user
// asked for. What these guard is that it stays that way — one click, one
// request at most — and that a zero InsightX does not measure is never shown
// as a zero it did.
const TOKEN = `0x${'a'.repeat(40)}`;
const ID = `robinhood:${TOKEN}`;
const RAW = {
  cluster_pct: 15.5,
  snipers_pct: 0,
  bundlers_pct: 0,
  dev_pct: 0,
  insiders_pct: 0,
  top10_pct: 34.37,
};
const client = (over = {}) => {
  const calls = [];
  let now = 1_000_000;
  const x = new InsightX({
    key: () => 'k-123',
    fetchJson: async (url, headers) => {
      calls.push({ url, headers });
      return RAW;
    },
    clock: () => now,
    ...over,
  });
  return { x, calls, tick: (ms) => (now += ms) };
};

test('EVM 链上的捆绑/狙击/开发者/内部人比例是未测，不是 0', () => {
  const evm = parseMetrics(RAW, 'robinhood');
  assert.equal(evm.top10, 34.37);
  assert.equal(evm.cluster, 15.5);
  for (const k of ['bundlers', 'snipers', 'dev', 'insiders'])
    assert.equal(evm[k], null, k);
  const sol = parseMetrics({ ...RAW, bundlers_pct: 4.2 }, 'sol');
  assert.equal(sol.bundlers, 4.2);
  assert.equal(sol.snipers, 0, 'Solana 上的 0 是测过的 0');
});

test('Top10 为 0 是 InsightX 没算出来，不是没有大户', () => {
  const m = parseMetrics({ ...RAW, top10_pct: 0, cluster_pct: 0 }, 'robinhood');
  assert.equal(m.top10, null);
  assert.equal(m.cluster, 0, '聚类 0 是真实结果');
});

test('越界或非数字的比例当没有', () => {
  const m = parseMetrics({ top10_pct: 140, cluster_pct: 'x' }, 'eth');
  assert.equal(m.top10, null);
  assert.equal(m.cluster, null);
  assert.throws(() => parseMetrics(null, 'eth'));
});

test('key 只放在请求头里，地址按链规范化', async () => {
  const { x, calls } = client();
  const m = await x.metrics(`robinhood:0x${'A'.repeat(40)}`);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.insightx.network/dex-metrics/v1/robinhood/${TOKEN}`,
  );
  assert.equal(calls[0].headers['X-API-Key'], 'k-123');
  assert.equal(m.id, ID);
  assert.ok(!JSON.stringify(m).includes('k-123'), '回给页面的数据里没有 key');
});

test('同一个币连点两次、并发打开，都只花一次请求；过期后才重取', async () => {
  const { x, calls, tick } = client();
  await Promise.all([x.metrics(ID), x.metrics(ID)]);
  await x.metrics(ID);
  assert.equal(calls.length, 1);
  tick(METRICS_TTL + 1);
  await x.metrics(ID);
  assert.equal(calls.length, 2);
});

test('失败不缓存，下一次打开会重试', async () => {
  let fail = true;
  const calls = [];
  const x = new InsightX({
    key: () => 'k',
    fetchJson: async (url) => {
      calls.push(url);
      if (fail) throw new Error('HTTP 429 · 触发限流');
      return RAW;
    },
  });
  await assert.rejects(x.metrics(ID), /InsightX：HTTP 429/);
  fail = false;
  assert.equal((await x.metrics(ID)).top10, 34.37);
  assert.equal(calls.length, 2);
});

test('没有 key、id 无效时不发请求', async () => {
  const { x, calls } = client({ key: () => '' });
  assert.equal(x.configured(), false);
  assert.throws(() => x.metrics(ID), /INSIGHTX_API_KEY/);
  const ok = client();
  assert.throws(() => ok.x.metrics('robinhood:0xnope'), /id 无效/);
  assert.throws(() => ok.x.metrics('nochain:abc'), /id 无效/);
  assert.equal(calls.length + ok.calls.length, 0);
});
