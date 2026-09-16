import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CHAINS, number, validAddress } from './risk.mjs';
import { arr, millis } from './values.mjs';
import { normalizeTape } from './tape.mjs';
import {
  readContractState,
  summarizeExplorer,
  ROBINHOOD_EXPLORER,
} from './contract-evidence.mjs';
import { readTrackedHoldings, rpcFor } from './tracked-balances.mjs';
import { readPoolPrices, freshen, poolVersion } from './pool-price.mjs';
const exec = promisify(execFile);
const binary = fileURLToPath(new URL('./gmgn-runner.mjs', import.meta.url));
const headers = {
  'User-Agent': 'MemeScout/1.0 (+local read-only monitor)',
  Accept: 'application/json',
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const cooldowns = new Map();
let gmgnQueue = Promise.resolve();
// The scan loop paces itself against the GMGN limiter, so it has to be able to
// read the cooldown instead of discovering it one failed token at a time.
export const cooldownUntil = (key) => cooldowns.get(key) || 0;
// A source that answers every request with the same refusal is not evidence and
// is not worth a request per scan. After a run of failures it is left alone for
// a while and reported as unavailable, so it can recover on its own.
const BREAKER_TRIPS = 3;
const BREAKER_PAUSE = 30 * 60000;
const breakers = new Map();
export function noteBreaker(key, ok, now = Date.now()) {
  const b = breakers.get(key) || { failures: 0, until: 0 };
  if (ok) breakers.set(key, { failures: 0, until: 0 });
  else {
    const failures = b.failures + 1;
    breakers.set(key, {
      failures,
      until: failures >= BREAKER_TRIPS ? now + BREAKER_PAUSE : 0,
    });
  }
  return breakers.get(key);
}
export const breakerOpenUntil = (key, now = Date.now()) => {
  const until = breakers.get(key)?.until || 0;
  return until > now ? until : 0;
};
export const resetBreakers = () => breakers.clear();
// GMGN publishes no rate limit, so the pace is measured rather than guessed: a
// minimum interval between call starts holds a real requests-per-minute figure
// whatever the latency does, where a fixed sleep after each call would drift
// with it. The first 429 is treated as the answer we could not look up and the
// pace drops for the rest of the session — a limiter that keeps probing upward
// would buy back a few seconds at the price of a five-minute blackout.
const GMGN_RATE = 45;
const GMGN_RATE_AFTER_LIMIT = 25;
let gmgnRate = GMGN_RATE;
let gmgnReducedAt = null;
let lastGmgnCall = 0;
export const gmgnPace = () => ({
  target: GMGN_RATE,
  current: gmgnRate,
  reducedAt: gmgnReducedAt,
});
export function resetGmgnPace() {
  gmgnRate = GMGN_RATE;
  gmgnReducedAt = null;
  lastGmgnCall = 0;
  cooldowns.delete('gmgn');
}
// The pause and the slowdown come from the same event and are set together: a
// limit that only paused would walk us straight back into it five minutes later.
export function noteGmgnLimit(now = Date.now()) {
  cooldowns.set('gmgn', now + 300000);
  if (gmgnRate === GMGN_RATE_AFTER_LIMIT) return;
  gmgnRate = GMGN_RATE_AFTER_LIMIT;
  gmgnReducedAt = new Date(now).toISOString();
}
// Returns how long this call must wait, and books the slot it will take. Timed
// from when the previous call started, so an answer that took longer than the
// interval has already paid it rather than being charged twice.
export function gmgnGate(now = Date.now()) {
  const wait = Math.max(0, lastGmgnCall + 60000 / gmgnRate - now);
  lastGmgnCall = now + wait;
  return wait;
}
export function unwrap(raw) {
  if (raw?.code !== undefined) {
    if (![0, 1, '0', '1'].includes(raw.code))
      throw new Error(`数据源业务错误 ${raw.code}`);
    return raw.data ?? raw.result ?? raw;
  }
  return raw;
}
export async function gmgn(args) {
  const run = gmgnQueue.then(async () => {
    const until = cooldowns.get('gmgn') || 0;
    if (Date.now() < until)
      throw new Error(`GMGN 限流，${new Date(until).toISOString()} 后再试`);
    const wait = gmgnGate();
    if (wait > 0) await pause(wait);
    try {
      const { stdout } = await exec(
        process.execPath,
        [binary, ...args, '--raw'],
        {
          timeout: 18000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            MEME_GMGN_API_KEY: process.env.GMGN_API_KEY || '',
          },
        },
      );
      const raw = JSON.parse(stdout.trim());
      if (
        raw.code === 429 ||
        /RATE_LIMIT/.test(raw.reason || raw.message || '')
      ) {
        noteGmgnLimit();
        throw new Error('GMGN 限流，已暂停请求 5 分钟');
      }
      return unwrap(raw);
    } catch (e) {
      const msg = String(e.stderr || e.message || '');
      if (/429|RATE_LIMIT/.test(msg)) noteGmgnLimit();
      // Never expose CLI diagnostics that may contain authentication material.
      throw new Error(
        /429|RATE_LIMIT/.test(msg)
          ? 'GMGN 限流，已暂停请求 5 分钟'
          : /401|403/.test(msg)
            ? 'GMGN 认证或网络访问被拒绝'
            : e.killed
              ? 'GMGN 请求超时'
              : 'GMGN 请求失败或尚未配置 API key',
      );
    }
  });
  gmgnQueue = run.catch(() => {});
  return run;
}
export async function json(url, extra = {}, body) {
  const host = new URL(url).host;
  const until = cooldowns.get(host) || 0;
  if (Date.now() < until)
    throw new Error(`来源限流，${new Date(until).toISOString()} 后重试`);
  const response = await fetch(url, {
    headers: {
      ...headers,
      ...extra,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 429) {
    const retry = response.headers.get('retry-after');
    const delay = Number(retry);
    const when =
      Number.isFinite(delay) && delay > 0
        ? Date.now() + delay * 1000
        : Date.parse(retry || '');
    cooldowns.set(
      host,
      Number.isFinite(when)
        ? Math.min(when, Date.now() + 3600000)
        : Date.now() + 60000,
    );
  }
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status}${response.status === 429 ? ' · 触发限流' : response.status === 401 || response.status === 403 ? ' · 来源访问被拒绝' : ''}`,
    );
  const text = await response.text();
  if (text.length > 8e6) throw new Error('来源响应超出大小限制');
  return JSON.parse(text);
}
export async function source(name, url, fn) {
  const start = Date.now();
  try {
    const data = await fn();
    return {
      name,
      url,
      status: 'ok',
      fetchedAt: new Date().toISOString(),
      latency: Date.now() - start,
      data,
    };
  } catch (e) {
    return {
      name,
      url,
      status: 'error',
      fetchedAt: new Date().toISOString(),
      latency: Date.now() - start,
      error: String(e.message).slice(0, 220),
      data: null,
    };
  }
}
function rows(raw) {
  return Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.rows)
      ? raw.rows
      : Array.isArray(raw?.tokens)
        ? raw.tokens
        : [];
}
function id(chain, address) {
  return `${chain}:${chain === 'sol' ? address : address.toLowerCase()}`;
}
function gmgnCandidate(r, chain) {
  return {
    id: id(chain, r.address),
    chain,
    address: r.address,
    symbol: r.symbol || '?',
    name: r.name || '',
    marketCap: number(r.market_cap),
    liquidity: number(r.liquidity),
    price: number(r.price),
    volume: number(r.volume),
    change: number(r.price_change_percent1h),
    volumeWindow: '1h',
    buyers: number(r.buys),
    sellers: number(r.sells),
    source: 'GMGN 1h 热门',
    sourceUrl: `https://gmgn.ai/${chain}/token/${r.address}`,
    createdAt: millis(r.creation_timestamp),
    trackedBuyers: null,
    trackedHolders: null,
    netFlow: null,
    rugRatio: number(r.rug_ratio),
    raw: r,
  };
}
let tapeFullFetchedAt = 0;
export async function fetchTape(previous = []) {
  const limit =
    !previous.length || Date.now() - tapeFullFetchedAt >= 60000 ? 400 : 60;
  const url = `https://robinhoodtrenches.com/api/tape?limit=${limit}&stocks=false`;
  return source('Trenches LIVE TAPE', url, async () => {
    let raw = await json(url);
    let events = normalizeTape(raw);
    let fullSnapshot = limit === 400;
    const lastId = previous[0]?.eventId;
    // Snapshot overlap catches recent pricing/flag corrections, which since_id
    // alone would miss. After an interruption expand to the site's 400-row window.
    if (
      limit !== 400 &&
      lastId &&
      raw.length >= limit &&
      events.length &&
      events.every((t) => t.eventId > lastId)
    ) {
      raw = await json(
        'https://robinhoodtrenches.com/api/tape?limit=400&stocks=false',
      );
      events = normalizeTape(raw);
      fullSnapshot = true;
    }
    if (fullSnapshot) tapeFullFetchedAt = Date.now();
    return {
      events,
      fullSnapshot,
      gap: Boolean(
        lastId &&
        raw.length >= 400 &&
        events.length &&
        events.every((t) => t.eventId > lastId),
      ),
    };
  });
}

// DexScreener needs no key and prices every chain this monitor watches, so the
// live market numbers can be re-read far more often than discovery runs without
// spending any of the GMGN budget. Its chain slugs are its own and do not match
// the ids used everywhere else here, so the mapping is explicit.
const DEX_CHAIN = {
  robinhood: 'robinhood',
  sol: 'solana',
  bsc: 'bsc',
  base: 'base',
  eth: 'ethereum',
};
export const dexChain = (chain) => DEX_CHAIN[chain] ?? null;

// One token trades in many pools. The deepest pool is the one a sale actually
// meets, so that is the one quoted; the rest are dropped rather than summed,
// because a total across pools is not a price anyone can trade at.
function deepestPool(data, address, slug) {
  const wanted = String(address).toLowerCase();
  return rows(data)
    .filter(
      (p) =>
        p.chainId === slug && p.baseToken?.address?.toLowerCase() === wanted,
    )
    .sort(
      (a, b) =>
        (number(b.liquidity?.usd) || 0) - (number(a.liquidity?.usd) || 0),
    )[0];
}

// Windows the source did not report stay null. DexScreener omits priceChange.m5
// and volume.m5 entirely when it has no trades to compare, and reading a missing
// key as 0 would invent a flat market out of an absence of data.
// marketCap and fdv are both kept: they are separate numbers whose difference is
// non-circulating supply, and the source publishes neither the supply it used
// nor why they differ, so neither one can stand in for the other.
export function marketFields(p) {
  return {
    marketCap: number(p?.marketCap),
    fdv: number(p?.fdv),
    // Stated rather than left off: a quote is merged over a candidate, so an
    // absent key would let a substitution flag set by another source stay on a
    // row whose cap this source published for real.
    capIsFdv: false,
    liquidity: number(p?.liquidity?.usd),
    price: number(p?.priceUsd),
    volume: number(p?.volume?.h1),
    volumeWindow: '1h 主池',
    volume5m: number(p?.volume?.m5),
    change: number(p?.priceChange?.h1),
    change5m: number(p?.priceChange?.m5),
    buys5m: number(p?.txns?.m5?.buys),
    sells5m: number(p?.txns?.m5?.sells),
    // Kept so the pool the source picked can be re-read on chain. priceNative is
    // the same price denominated in the pool's quote token, which is exactly the
    // quantity a pool read produces — comparing the two needs no supply figure
    // and no dollar rate, so every assumption behind them cancels.
    ...poolRef(p?.pairAddress, p?.labels, p?.quoteToken?.address, p?.priceNative),
  };
}
// The pool coordinates a quote carries so the on-chain lane can find it again.
// Grouped in one helper because both quote sources must produce the same shape
// or the freshening step would silently work on one chain and not the other.
function poolRef(pool, labels, quote, priceNative) {
  return {
    priceNative: number(priceNative),
    pool: typeof pool === 'string' ? pool : null,
    poolVersion: poolVersion(pool, labels || []),
    quoteToken: typeof quote === 'string' ? quote : null,
  };
}

// GeckoTerminal covers the chains DexScreener does not index at all. It is not
// a drop-in replacement: its numbers were measured lagging the chain by far more
// than DexScreener's, and it publishes no circulating market cap on Arc at all.
// Both of those are handled explicitly below rather than papered over.
const GECKO_CHAIN = { arc: 'arc' };
export const geckoChain = (chain) => GECKO_CHAIN[chain] ?? null;
const GECKO = 'https://api.geckoterminal.com/api/v2';
// GeckoTerminal reports a market cap it does not have as the string "0.0" as
// often as it reports null. Parsed naively that is a market cap of zero dollars,
// which passes every "is this a number" check and then fails the minimum-cap
// filter — the coin would vanish from the list as though it had been measured
// and found worthless. Zero is treated as the absence it is.
const positive = (v) => {
  const n = number(v);
  return n === null || n <= 0 ? null : n;
};
// One token, its top pool, and the honest note that the cap is an FDV. On Arc
// every single token comes back with market_cap_usd null or "0.0" and fdv_usd
// populated, so falling back silently would relabel diluted supply as
// circulating supply across the whole chain.
function geckoQuote(token, pool) {
  const a = pool?.attributes || {};
  const t = token?.attributes || {};
  const cap = positive(t.market_cap_usd) ?? positive(a.market_cap_usd);
  const fdv = positive(t.fdv_usd) ?? positive(a.fdv_usd);
  const base = positive(a.base_token_price_usd) ?? positive(t.price_usd);
  const quote = positive(a.quote_token_price_usd);
  return {
    // With no circulating figure published, the row would otherwise be dropped
    // as "unknown cap" and the whole chain would show nothing. The FDV stands in
    // and the substitution is recorded so the column can say so — the number is
    // then filtered, sorted and freshened like any other, because for a coin
    // whose supply is fully in circulation the two are the same figure anyway.
    marketCap: cap ?? fdv,
    fdv,
    capIsFdv: cap === null && fdv !== null,
    liquidity: positive(a.reserve_in_usd),
    price: base,
    volume: number(a.volume_usd?.h1),
    volumeWindow: '1h 主池',
    volume5m: number(a.volume_usd?.m5),
    change: number(a.price_change_percentage?.h1),
    change5m: number(a.price_change_percentage?.m5),
    buys5m: number(a.transactions?.m5?.buys),
    sells5m: number(a.transactions?.m5?.sells),
    ...poolRef(
      a.address,
      [pool?.relationships?.dex?.data?.id || ''],
      String(pool?.relationships?.quote_token?.data?.id || '').split('_').pop(),
      // The source publishes base-in-quote directly; deriving it from the two
      // dollar prices instead would fold two separate staleness windows into
      // the one number the on-chain guard is about to be compared against.
      positive(a.base_token_price_quote_token) ??
        (base && quote ? base / quote : null),
    ),
  };
}
async function quoteGecko(chain, slug, unique) {
  const sources = [];
  const quotes = new Map();
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    const url = `${GECKO}/networks/${slug}/tokens/multi/${batch.join(',')}?include=top_pools`;
    const s = await source('GeckoTerminal 实时行情', url, () => json(url));
    sources.push(s);
    if (s.status !== 'ok') continue;
    const pools = new Map(
      (s.data?.included || [])
        .filter((x) => x?.type === 'pool')
        .map((x) => [x.id, x]),
    );
    for (const token of arr(s.data?.data)) {
      const address = String(token?.attributes?.address || '').toLowerCase();
      if (!batch.includes(address)) continue;
      const top = token?.relationships?.top_pools?.data?.[0]?.id;
      quotes.set(address, {
        ...geckoQuote(token, pools.get(top)),
        marketCapSource: 'GeckoTerminal 首位池',
        marketObservedAt: s.fetchedAt,
      });
    }
  }
  return { quotes, sources };
}
async function quoteDex(slug, unique) {
  const sources = [];
  const quotes = new Map();
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    const url = `https://api.dexscreener.com/tokens/v1/${slug}/${batch.join(',')}`;
    const s = await source('DexScreener 实时行情', url, () => json(url));
    sources.push(s);
    if (s.status !== 'ok') continue;
    for (const address of batch) {
      const p = deepestPool(s.data, address, slug);
      if (p)
        quotes.set(address, {
          ...marketFields(p),
          marketCapSource: 'DexScreener 最大流动性匹配池',
          marketObservedAt: s.fetchedAt,
        });
    }
  }
  return { quotes, sources };
}
// How long a chain's source quote may be reused before it is asked again.
// DexScreener republishes on a ~32 second cycle and allows roughly 300 requests
// a minute, so it is re-asked every tick and the volume and transaction columns
// stay as live as the source makes them. GeckoTerminal allows about a tenth of
// that, and 40 candidates would spend two thirds of its budget on a poll that
// mostly returns bytes it just sent; its numbers were also measured lagging the
// chain by minutes, so there is nothing to gain by asking faster. What the
// price on screen actually rides on either way is the pool read, which runs
// every tick on both.
const ANCHOR_TTL = 30000;
export const anchorTtl = (chain) => (dexChain(chain) ? 0 : ANCHOR_TTL);
// A price-only read for candidates already on the list. It never adds, removes
// or reorders anything — discovery still owns membership; this only keeps the
// numbers on screen from ageing between discovery runs.
export async function quoteMarket(chain, addresses) {
  const unique = [
    ...new Set(addresses.filter(Boolean).map((a) => String(a).toLowerCase())),
  ];
  const slug = dexChain(chain);
  if (slug) return quoteDex(slug, unique);
  const gecko = geckoChain(chain);
  if (gecko) return quoteGecko(chain, gecko, unique);
  return { quotes: new Map(), sources: [] };
}
// The second half of a market tick: the quote above says which pool the price
// came from, and this re-reads that pool on chain. What comes back replaces only
// the price and the two figures derived from it, as a ratio — the source keeps
// ownership of the supply the cap is built on and of what the quote token is
// worth in dollars, because a pool read cannot answer either.
export async function freshenMarket({ chain, quotes, meta }) {
  const pools = [];
  for (const [address, q] of quotes)
    pools.push({
      key: address,
      pool: q.pool,
      version: q.poolVersion,
      base: address,
      quote: q.quoteToken,
    });
  if (!pools.length) return { quotes, source: null, block: null };
  const started = new Date().toISOString();
  let read;
  try {
    read = await readPoolPrices({
      chain,
      pools,
      meta,
      request: (url, body) => json(url, {}, body),
    });
  } catch (e) {
    return {
      quotes,
      block: null,
      source: {
        name: '链上池价',
        url: rpcFor(chain) || '',
        status: 'error',
        fetchedAt: started,
        error: String(e.message).slice(0, 180),
      },
    };
  }
  const merged = new Map(quotes);
  let applied = 0,
    rejected = 0;
  for (const [address, q] of quotes) {
    const fresh = freshen(q, read.prices.get(address));
    if (!fresh) {
      merged.set(address, {
        ...q,
        onchain: null,
        onchainNote: read.skipped.get(address) || '本轮未读到该池',
      });
      continue;
    }
    if (fresh.rejected) {
      rejected++;
      merged.set(address, { ...q, onchain: null, onchainNote: fresh.reason });
      continue;
    }
    applied++;
    merged.set(address, {
      ...q,
      price: fresh.price,
      // A cap the source never published stays unpublished. Scaling a null into
      // a number here would manufacture a market cap out of a price move.
      marketCap: fresh.marketCap ?? q.marketCap,
      fdv: fresh.fdv ?? q.fdv,
      onchain: { block: fresh.block, version: fresh.version, ratio: fresh.ratio },
      onchainNote: null,
      marketObservedAt: started,
    });
  }
  return {
    quotes: merged,
    block: read.block,
    applied,
    source: {
      name: '链上池价',
      url: read.rpc || '',
      status: read.supported ? 'ok' : 'unsupported',
      fetchedAt: started,
      error: null,
      note: read.supported
        ? `区块 ${read.block ?? '未知'}：${applied} 个用链上价${rejected ? `，${rejected} 个因偏差过大改用来源价` : ''}`
        : '该链未配置 RPC，全部沿用来源发布的市值',
    },
  };
}

// The tracked-address lane's only door to the network. It spends no GMGN budget
// at all — this is a plain RPC read, so it can run on its own short cycle
// without competing with the scan loop for the rate limit that matters.
export function readTracked({ chain, tokens, wallets, decimals }) {
  return readTrackedHoldings({
    chain,
    tokens,
    wallets,
    decimals,
    request: (url, body) => json(url, {}, body),
  });
}

export async function resolveTape(trades) {
  const candidates = [],
    sources = [];
  const unique = [...new Map(trades.map((t) => [t.candidateId, t])).values()];
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    const url = `https://api.dexscreener.com/tokens/v1/robinhood/${batch.map((t) => t.address).join(',')}`;
    const s = await source('LIVE TAPE · DexScreener 市值', url, () =>
      json(url),
    );
    sources.push(s);
    if (s.status !== 'ok') continue;
    for (const t of batch) {
      const p = deepestPool(s.data, t.address, 'robinhood');
      candidates.push({
        id: t.candidateId,
        address: t.address,
        chain: 'robinhood',
        symbol: t.symbol,
        name: t.name,
        ...marketFields(p),
        createdAt: millis(p?.pairCreatedAt),
        buyers: null,
        sellers: null,
        trackedBuyers: null,
        trackedHolders: null,
        netFlow: null,
        source: 'Trenches LIVE TAPE · 追踪钱包买入',
        sourceUrl: `https://dexscreener.com/robinhood/${t.address}`,
        marketCapSource: 'DexScreener 最大流动性匹配池',
        marketObservedAt: s.fetchedAt,
      });
    }
  }
  return { candidates, sources };
}
export async function discover(chain) {
  const sources = [];
  let candidates = [];
  if (chain === 'robinhood') {
    const url =
      'https://robinhoodtrenches.com/api/tokens?window=1h&stocks=false&limit=60';
    const r = await source('Robinhood Trenches', url, () => json(url));
    sources.push(r);
    candidates = rows(r.data)
      .filter((t) => !t.is_stock && validAddress(chain, t.token))
      .map((t) => ({
        id: id(chain, t.token),
        chain,
        address: t.token,
        symbol: t.symbol || '?',
        name: '',
        marketCap: null,
        liquidity: number(t.liquidity),
        price: number(t.mark),
        volume: number(t.volume24),
        volumeWindow: '24h',
        change: number(t.change24),
        buyers: null,
        sellers: null,
        source: 'Robinhood Trenches · 1h 追踪钱包',
        sourceUrl: 'https://robinhoodtrenches.com',
        createdAt: millis(t.pair_created_at),
        trackedBuyers: number(t.buyers),
        trackedHolders: number(t.holders),
        netFlow: number(t.net_usd),
        raw: t,
      }));
    const radarUrl =
      'https://robinhoodtrenches.com/api/radar?minutes=120&limit=40';
    const radar = await source('Trenches Radar', radarUrl, () =>
      json(radarUrl),
    );
    sources.push(radar);
    const flowUrl =
      'https://robinhoodtrenches.com/api/flow?window=1h&stocks=false&limit=60';
    const flow = await source('Trenches 资金流', flowUrl, () => json(flowUrl));
    sources.push(flow);
    for (const t of rows(radar.data)) {
      if (
        t.is_stock ||
        !validAddress(chain, t.token) ||
        candidates.some((c) => c.id === id(chain, t.token))
      )
        continue;
      candidates.push({
        id: id(chain, t.token),
        chain,
        address: t.token,
        symbol: t.symbol || '?',
        name: '',
        marketCap: null,
        liquidity: number(t.liquidity),
        price: number(t.mark),
        volume: null,
        volumeWindow: '未知',
        change: null,
        buyers: null,
        sellers: null,
        source: 'Robinhood Trenches Radar · 120min',
        sourceUrl: 'https://robinhoodtrenches.com',
        createdAt: millis(t.pair_created_at),
        trackedBuyers: null,
        trackedHolders: null,
        netFlow: null,
        raw: t,
      });
    }
    for (let i = 0; i < candidates.length; i += 30) {
      const batch = candidates.slice(i, i + 30);
      const dexUrl = `https://api.dexscreener.com/tokens/v1/robinhood/${batch.map((t) => t.address).join(',')}`;
      const d = await source('DexScreener 市值', dexUrl, () => json(dexUrl));
      sources.push(d);
      for (const c of batch) {
        const p = deepestPool(d.data, c.address, 'robinhood');
        if (p) {
          Object.assign(c, marketFields(p));
          // Radar rows often omit pair_created_at; only fill the gap so the
          // discovery source stays the one that reported the age.
          c.createdAt ??= millis(p.pairCreatedAt);
          c.sourceUrl = p.url;
          // The raw pool object used to be kept here and was never read. Now
          // that the quote refreshes these fields on their own timer, keeping it
          // would ship a second, older copy of every number to the page.
          c.marketCapSource = 'DexScreener 最大流动性匹配池';
          c.marketObservedAt = d.fetchedAt;
        }
      }
    }
    // GMGN cross-checks discovery and fills candidates absent from tracked wallets.
    const g = await source('GMGN 热门', 'https://gmgn.ai', () =>
      gmgn([
        'market',
        'trending',
        '--chain',
        chain,
        '--interval',
        '1h',
        '--limit',
        '30',
      ]),
    );
    sources.push(g);
    const ranked = Array.isArray(g.data?.rank) ? g.data.rank : [];
    for (const r of ranked) {
      if (!validAddress(chain, r.address)) continue;
      const found = candidates.find((c) => c.id === id(chain, r.address));
      if (found) {
        if (found.marketCap === null) {
          found.marketCap = number(r.market_cap);
          found.marketCapSource = 'GMGN';
        }
        found.rugRatio = number(r.rug_ratio);
      } else candidates.push(gmgnCandidate(r, chain));
    }
    for (const c of candidates) {
      const early = rows(radar.data).find(
        (t) => String(t.token).toLowerCase() === c.address.toLowerCase(),
      );
      const movement = rows(flow.data).find(
        (t) => String(t.token).toLowerCase() === c.address.toLowerCase(),
      );
      c.trench = {
        firstBuyer:
          c.raw?.first_buyer?.handle || early?.first_buyer?.handle || null,
        firstBuyAt: number(c.raw?.first_buyer?.ts ?? early?.first_buyer?.ts),
        radarBuyers: number(early?.buyers),
        lead: movement?.lead?.handle || null,
        followers: number(movement?.follower_count),
        totalUsd: number(movement?.total_usd),
        observedAt: r.fetchedAt,
      };
    }
  } else if (geckoChain(chain)) {
    // The chains DexScreener does not index discover through GeckoTerminal,
    // which is pool-shaped rather than token-shaped: two listings are read and
    // the base token of each pool becomes the candidate. Trending goes first
    // because discovery order *is* the heat order everywhere else here.
    const slug = geckoChain(chain);
    const seen = new Set();
    for (const [name, path, label] of [
      [
        'GeckoTerminal 热门池',
        `trending_pools?include=base_token,quote_token,dex&duration=1h`,
        'GeckoTerminal · 1h 热门池',
      ],
      [
        'GeckoTerminal 成交榜',
        `pools?include=base_token,quote_token,dex&page=1`,
        'GeckoTerminal · 成交额排序',
      ],
    ]) {
      const url = `${GECKO}/networks/${slug}/${path}`;
      const r = await source(name, url, () => json(url));
      sources.push(r);
      if (r.status !== 'ok') continue;
      const inc = new Map(arr(r.data?.included).map((x) => [x.id, x]));
      for (const p of arr(r.data?.data)) {
        const token = inc.get(p?.relationships?.base_token?.data?.id);
        const address = token?.attributes?.address;
        if (!validAddress(chain, address) || seen.has(id(chain, address)))
          continue;
        seen.add(id(chain, address));
        candidates.push({
          id: id(chain, address),
          chain,
          address,
          symbol: token.attributes.symbol || '?',
          name: token.attributes.name || '',
          ...geckoQuote(token, p),
          source: label,
          sourceUrl: `https://www.geckoterminal.com/${slug}/pools/${p.attributes?.address}`,
          createdAt: millis(p.attributes?.pool_created_at),
          marketCapSource: 'GeckoTerminal 首位池',
          marketObservedAt: r.fetchedAt,
          buyers: null,
          sellers: null,
          trackedBuyers: null,
          trackedHolders: null,
          netFlow: null,
        });
      }
    }
  } else {
    const g = await source('GMGN 热门', 'https://gmgn.ai', () =>
      gmgn([
        'market',
        'trending',
        '--chain',
        chain,
        '--interval',
        '1h',
        '--limit',
        '50',
      ]),
    );
    sources.push(g);
    candidates = (Array.isArray(g.data?.rank) ? g.data.rank : [])
      .filter((t) => validAddress(chain, t.address))
      .map((t) => gmgnCandidate(t, chain));
  }
  const unique = new Map(candidates.map((c) => [c.id, c]));
  candidates = [...unique.values()].sort(
    (a, b) =>
      (b.trackedBuyers ?? 0) - (a.trackedBuyers ?? 0) ||
      (b.volume ?? 0) - (a.volume ?? 0),
  );
  return { candidates, sources };
}
export async function fetchSocial(candidate) {
  if (!process.env.X_BEARER_TOKEN)
    return {
      name: 'X',
      status: 'unconfigured',
      url: 'https://docs.x.com/x-api/posts/search-recent-posts',
      fetchedAt: new Date().toISOString(),
      error: '尚未连接 X 数据源；需要具有读取权限的 Bearer Token',
      data: null,
    };
  const args = new URLSearchParams({
    query: `${candidate.address} -is:retweet`,
    max_results: '100',
    sort_order: 'recency',
    expansions: 'author_id',
    'tweet.fields': 'created_at,public_metrics,author_id',
    'user.fields': 'created_at,public_metrics,username',
  });
  const url = `https://api.x.com/2/tweets/search/recent?${args}`;
  return source('X', url, async () => {
    const r = await json(url, {
      Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
    });
    if (r.errors && !r.data)
      throw new Error('X 未返回可用样本，检查权限和额度');
    return r;
  });
}
// Which chains each evidence source actually covers. These are facts about the
// sources, not settings: GoPlus publishes its supported chain ids and 5042 is
// not among them, so an Arc token gets no permission evidence from it no matter
// how the request is shaped. Writing the coverage down lets a gap be reported as
// a gap instead of arriving as a failed request that reads like the token's
// fault. Honeypot.is's list is the same kind of fact and already lived inline.
const GOPLUS_CHAINS = new Set(['sol', 'eth', 'bsc', 'base', 'robinhood']);
export const goplusSupported = (chain) => GOPLUS_CHAINS.has(chain);
const HONEYPOT_CHAINS = new Set(['eth', 'bsc', 'base']);
// The chains whose contract evidence comes from a direct RPC read. Exactly the
// two GoPlus does not cover — elsewhere it would duplicate what GoPlus already
// answers, and here it is the only answer there is.
const RPC_CONTRACT = new Set(['robinhood', 'arc']);
// Display order for the source list. Collection runs two groups concurrently,
// so completion order is not an order anyone should read a report in.
const SOURCE_ORDER = [
  'info',
  'security',
  'holders',
  'dev',
  'goplus',
  'explorer',
  'contract',
  'rugcheck',
  'honeypot',
  'social',
];
// Permission flags and a creator's launch history do not move on the timescale a
// rescan runs at; price, market cap and holder concentration do. A rescan spends
// its GMGN budget on the second group and carries the first one forward.
export const SLOW_LANE = ['security', 'dev'];
// Returns the earlier source entry to carry forward, or null to fetch again.
// An entry that failed last time is not evidence and is never carried: the gap
// has to stay visible rather than be inherited as a settled result.
export function carriedSource(previous, key) {
  if (!SLOW_LANE.includes(key)) return null;
  if (previous?.raw?.[key] === undefined) return null;
  const meta = previous.sources?.find((s) => s.key === key);
  if (!meta || !['ok', 'partial'].includes(meta.status)) return null;
  return { ...meta, data: previous.raw[key], reused: true };
}
export async function collect(
  candidate,
  shouldContinue = () => true,
  previous = null,
) {
  const { chain, address } = candidate;
  if (!validAddress(chain, address)) throw new Error('无效合约地址');
  const slots = new Map();
  const data = {};
  let gmgnCalls = 0;
  const gmgnCall = (args) => {
    gmgnCalls++;
    return gmgn(args);
  };
  // Carried evidence keeps the fetchedAt of the request that actually produced
  // it. The page prints that timestamp, so a reused finding never claims to
  // have been checked now.
  const carry = (key) => {
    const kept = carriedSource(previous, key);
    if (!kept) return false;
    data[key] = kept.data;
    slots.set(key, kept);
    return true;
  };
  const get = async (key, name, url, fn) => {
    if (!shouldContinue()) throw new Error('监控暂停或筛选已变化');
    const r = { key, ...(await source(name, url, fn)) };
    if (key === 'goplus' && r.status === 'ok' && chain !== 'sol') {
      const important = [
        'is_mintable',
        'is_proxy',
        'hidden_owner',
        'is_blacklisted',
        'is_honeypot',
      ];
      const present = important.filter(
        (k) =>
          r.data[k] !== undefined && r.data[k] !== null && r.data[k] !== '',
      );
      if (present.length < important.length) {
        r.status = 'partial';
        r.warning = `接口已返回，但 ${important.length - present.length}/${important.length} 个关键风险字段缺失${r.data.is_open_source === '0' ? '；GoPlus 未取得源码' : ''}${r.data.is_in_dex === '0' ? '；未识别可检测交易池' : ''}`;
      }
    }
    slots.set(key, r);
    if (['ok', 'partial'].includes(r.status)) data[key] = r.data;
    return r;
  };
  const defer = (key, name, url) =>
    slots.set(key, {
      key,
      name,
      url,
      status: 'deferred',
      fetchedAt: new Date().toISOString(),
      error: '首扫优先取得合约权限，本项留到下一轮补齐',
      data: null,
    });
  // Distinct from deferred (we chose to wait) and from error (we asked and it
  // went wrong): nobody publishes this for this chain, so no amount of waiting
  // or retrying produces it.
  const unsupported = (key, name, url, why) =>
    slots.set(key, {
      key,
      name,
      url,
      status: 'unsupported',
      fetchedAt: new Date().toISOString(),
      error: why,
      data: null,
    });
  const gmgnUrl = `https://gmgn.ai/${chain}/token/${address}`;
  // A coin nobody has looked at yet gets the two calls that answer what people
  // open this for — what the deployer can still do, and whether the position can
  // be sold. Holder concentration and deployer history arrive on the next pass.
  // Spending four calls on the first coin in the queue is why the last coin in
  // the queue used to wait six minutes for anything at all; the two deferred
  // rows read 未核验, which is what they are.
  const first = !previous;
  // The only genuinely serial chain: security and holders need info's symbol,
  // dev needs the creator address info reports.
  const gmgnLane = async () => {
    await get('info', 'GMGN 基本信息', gmgnUrl, () =>
      gmgnCall(['token', 'info', '--chain', chain, '--address', address]),
    );
    if (!data.info?.symbol) return;
    if (!carry('security'))
      await get('security', 'GMGN 合约', gmgnUrl, () =>
        gmgnCall(['token', 'security', '--chain', chain, '--address', address]),
      );
    const creator = data.info?.dev?.creator_address;
    if (first) {
      // Deferred, not failed, and not silently absent. Without an entry the
      // report would fall back to "来源未返回该字段", blaming GMGN for a request
      // we chose not to make yet.
      defer('holders', 'GMGN 持有人', gmgnUrl);
      if (validAddress(chain, creator))
        defer('dev', 'GMGN 开发者', `https://gmgn.ai/${chain}/address/${creator}`);
      return;
    }
    await get('holders', 'GMGN 持有人', gmgnUrl, () =>
      gmgnCall([
        'token',
        'holders',
        '--chain',
        chain,
        '--address',
        address,
        '--limit',
        '30',
      ]),
    );
    if (!validAddress(chain, creator)) return;
    // A deployer cannot change, but carrying history collected for a different
    // address would be a silent mismatch rather than a visible gap.
    if (previous?.raw?.info?.dev?.creator_address === creator && carry('dev'))
      return;
    await get(
      'dev',
      'GMGN 开发者',
      `https://gmgn.ai/${chain}/address/${creator}`,
      () =>
        gmgnCall([
          'portfolio',
          'created-tokens',
          '--chain',
          chain,
          '--wallet',
          creator,
        ]),
    );
  };
  // None of these depend on GMGN, so they run alongside it instead of queueing
  // behind it. They stay serial among themselves: one request per host at a time.
  const otherLane = async () => {
    const gpUrl =
      chain === 'sol'
        ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`
        : `https://api.gopluslabs.io/api/v1/token_security/${CHAINS[chain].id}?contract_addresses=${address}`;
    // A chain the source does not cover is not a coin the source cleared, and it
    // is not a request that failed either. Asking anyway would spend the call to
    // get back a generic "no data" that reads as though this particular token
    // were the problem; naming the chain says whose gap it is.
    if (!goplusSupported(chain))
      unsupported(
        'goplus',
        'GoPlus',
        gpUrl,
        `GoPlus 未覆盖 ${CHAINS[chain]?.label || chain} 链，合约权限本项无来源可核验`,
      );
    else
      await get('goplus', 'GoPlus', gpUrl, async () => {
        const raw = await json(gpUrl);
        if (raw.code !== 1) throw new Error(`GoPlus 暂无数据（${raw.code}）`);
        const d =
          raw.result?.[chain === 'sol' ? address : address.toLowerCase()];
        if (!d || !Object.keys(d).length) throw new Error('GoPlus 未收录此代币');
        return d;
      });
    if (chain === 'robinhood') {
      const u = `${ROBINHOOD_EXPLORER}/api/v2/smart-contracts/${address}`;
      const open = breakerOpenUntil('blockscout');
      if (open)
        slots.set('explorer', {
          key: 'explorer',
          name: 'Blockscout 合约结构',
          url: u,
          status: 'error',
          fetchedAt: new Date().toISOString(),
          error: `来源连续失败，暂停请求至 ${new Date(open).toISOString()}；代理与源码资料本次未取得`,
          data: null,
        });
      else {
        const r = await get('explorer', 'Blockscout 合约结构', u, async () =>
          summarizeExplorer(await json(u), address),
        );
        noteBreaker('blockscout', r.status === 'ok');
      }
    }
    // The read that answers "is there code at this address, is it a known
    // minimal clone, does owner() still respond". It runs on exactly the chains
    // where it is the only contract evidence available — GoPlus covers the
    // others, and a public endpoint this repo has actually measured is what
    // makes it runnable here at all.
    if (RPC_CONTRACT.has(chain)) {
      const rpc = rpcFor(chain);
      await get('contract', `${CHAINS[chain].label} RPC 只读状态`, rpc, () =>
        readContractState(chain, address, (url, body) => json(url, {}, body), rpc),
      );
    }
    if (chain === 'sol') {
      const u = `https://api.rugcheck.xyz/v1/tokens/${address}/report`;
      await get('rugcheck', 'RugCheck', u, () => json(u));
    }
    // "Can this be sold" is the question people open this for, and on the chains
    // below nobody simulates it. Leaving the row out entirely made that read as
    // though the question had been answered; it is the one gap most worth being
    // loud about, so it gets a row that says who is missing rather than silence.
    if (HONEYPOT_CHAINS.has(chain)) {
      const u = `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${CHAINS[chain].id}`;
      await get('honeypot', 'Honeypot.is', u, () => json(u));
    } else
      unsupported(
        'honeypot',
        'Honeypot.is',
        'https://honeypot.is/',
        `Honeypot.is 不支持 ${CHAINS[chain]?.label || chain} 链，本币没有卖出模拟来源，能否卖出未核验`,
      );
    if (!shouldContinue()) throw new Error('监控暂停或筛选已变化');
    const x = await fetchSocial(candidate);
    slots.set('social', { key: 'social', ...x });
    if (x.status === 'ok') data.social = x.data;
  };
  // Settled, not raced: aborting on the first rejection would leave the other
  // lane running with nobody holding its result or its failure.
  const lanes = await Promise.allSettled([gmgnLane(), otherLane()]);
  const failed = lanes.find((l) => l.status === 'rejected');
  if (failed) throw failed.reason;
  if (chain === 'robinhood' && candidate.trench) data.trench = candidate.trench;
  return {
    data,
    sources: SOURCE_ORDER.flatMap((k) => (slots.has(k) ? [slots.get(k)] : [])),
    gmgnCalls,
  };
}
