import { json } from './providers.mjs';
import { number } from './values.mjs';
import { blockId } from './blocklist.mjs';
// InsightX holder metrics, fetched only when someone opens a coin's bubble map.
// The map itself is InsightX's own embed and loads straight into the page; the
// scanner never asks for either on its own. This module exists for the header
// numbers, which need the API key — kept on this side so it never reaches a
// browser — and for the cache that keeps a free-tier key (5 a minute, 1000 a
// month) from being spent on the same coin opened twice.
export const INSIGHTX_API = 'https://api.insightx.network';
export const METRICS_TTL = 5 * 60 * 1000;
const MAX_CACHED = 200;
// InsightX publishes bundler, sniper, dev and insider shares for Solana only;
// on every EVM chain it returns 0 for them. Those zeros are "not measured",
// and are reported as null so the page cannot print them as "none found".
const SOLANA_ONLY = ['bundlers', 'snipers', 'dev', 'insiders'];
export function parseMetrics(raw, chain) {
  if (!raw || typeof raw !== 'object')
    throw new Error('InsightX 返回格式无法识别');
  const pct = (k) => {
    const v = number(raw[`${k}_pct`]);
    return v === null || v < 0 || v > 100 ? null : v;
  };
  // Any token with holders has a non-zero top-10 share, so a 0 there is a
  // figure InsightX did not compute — seen on young Robinhood coins, sometimes
  // beside a non-zero cluster share. Cluster 0 is a real answer: no clusters.
  const top10 = pct('top10');
  const out = { top10: top10 === 0 ? null : top10, cluster: pct('cluster') };
  for (const k of SOLANA_ONLY) out[k] = chain === 'sol' ? pct(k) : null;
  return out;
}
export class InsightX {
  constructor({
    key = () => process.env.INSIGHTX_API_KEY,
    fetchJson = json,
    clock = Date.now,
  } = {}) {
    this.key = key;
    this.fetchJson = fetchJson;
    this.clock = clock;
    this.cache = new Map();
  }
  configured() {
    return Boolean(this.key());
  }
  // One entry per coin, holding the promise while it is in flight so two clicks
  // on the same row cost one request. A failure is not cached: the next open
  // tries again, subject to the host cooldown json() keeps after a 429.
  metrics(rawId) {
    const id = blockId(rawId);
    if (!id) throw new Error('代币 id 无效');
    const key = this.key();
    if (!key) throw new Error('未配置 INSIGHTX_API_KEY，只显示气泡图');
    const now = this.clock();
    const hit = this.cache.get(id);
    if (hit && (hit.pending || now - hit.at < METRICS_TTL))
      return hit.pending || Promise.resolve(hit.value);
    const [chain, address] = [
      id.slice(0, id.indexOf(':')),
      id.slice(id.indexOf(':') + 1),
    ];
    const url = `${INSIGHTX_API}/dex-metrics/v1/${chain}/${encodeURIComponent(address)}`;
    const pending = this.fetchJson(url, { 'X-API-Key': key })
      .then((raw) => {
        const value = {
          id,
          ...parseMetrics(raw, chain),
          fetchedAt: new Date(this.clock()).toISOString(),
        };
        this.cache.delete(id);
        this.cache.set(id, { at: this.clock(), value });
        while (this.cache.size > MAX_CACHED)
          this.cache.delete(this.cache.keys().next().value);
        return value;
      })
      .catch((e) => {
        this.cache.delete(id);
        throw new Error(`InsightX：${String(e.message).slice(0, 160)}`);
      });
    this.cache.set(id, { pending });
    return pending;
  }
}
