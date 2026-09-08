import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CHAINS, number, validAddress } from './risk.mjs';
import { normalizeTape } from './tape.mjs';
import {
  readRobinhoodContract,
  summarizeExplorer,
  ROBINHOOD_RPC,
  ROBINHOOD_EXPLORER,
} from './contract-evidence.mjs';
const exec = promisify(execFile);
const binary = fileURLToPath(new URL('./gmgn-runner.mjs', import.meta.url));
const headers = {
  'User-Agent': 'MemeScout/1.0 (+local read-only monitor)',
  Accept: 'application/json',
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const cooldowns = new Map();
let gmgnQueue = Promise.resolve();
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
    await pause(350);
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
        cooldowns.set('gmgn', Date.now() + 300000);
        throw new Error('GMGN 限流，已暂停请求 5 分钟');
      }
      return unwrap(raw);
    } catch (e) {
      const msg = String(e.stderr || e.message || '');
      if (/429|RATE_LIMIT/.test(msg))
        cooldowns.set('gmgn', Date.now() + 300000);
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
    createdAt: number(r.creation_timestamp),
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
      const p = rows(s.data)
        .filter(
          (p) =>
            p.chainId === 'robinhood' &&
            p.baseToken?.address?.toLowerCase() === t.address,
        )
        .sort(
          (a, b) =>
            (number(b.liquidity?.usd) || 0) - (number(a.liquidity?.usd) || 0),
        )[0];
      candidates.push({
        id: t.candidateId,
        address: t.address,
        chain: 'robinhood',
        symbol: t.symbol,
        name: t.name,
        marketCap: number(p?.marketCap),
        liquidity: number(p?.liquidity?.usd),
        price: number(p?.priceUsd),
        volume: number(p?.volume?.h1),
        volumeWindow: '1h 主池',
        change: number(p?.priceChange?.h1),
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
        createdAt: number(t.pair_created_at),
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
        createdAt: number(t.pair_created_at),
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
        const pools = rows(d.data)
          .filter(
            (p) =>
              p.chainId === 'robinhood' &&
              p.baseToken?.address?.toLowerCase() === c.address.toLowerCase(),
          )
          .sort(
            (a, b) =>
              (number(b.liquidity?.usd) || 0) - (number(a.liquidity?.usd) || 0),
          );
        const p = pools[0];
        if (p) {
          c.marketCap = number(p.marketCap);
          c.liquidity = number(p.liquidity?.usd);
          c.price = number(p.priceUsd);
          c.volume = number(p.volume?.h1);
          c.volumeWindow = '1h 主池';
          c.change = number(p.priceChange?.h1);
          c.sourceUrl = p.url;
          c.pair = p;
          c.marketCapSource = 'DexScreener 最大流动性匹配池';
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
export async function collect(candidate, shouldContinue = () => true) {
  const { chain, address } = candidate;
  if (!validAddress(chain, address)) throw new Error('无效合约地址');
  const results = [];
  const data = {};
  const get = async (key, name, url, fn) => {
    if (!shouldContinue()) throw new Error('监控暂停或筛选已变化');
    const r = await source(name, url, fn);
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
    results.push(r);
    if (['ok', 'partial'].includes(r.status)) data[key] = r.data;
    return r;
  };
  const gmgnUrl = `https://gmgn.ai/${chain}/token/${address}`;
  await get('info', 'GMGN 基本信息', gmgnUrl, () =>
    gmgn(['token', 'info', '--chain', chain, '--address', address]),
  );
  if (data.info?.symbol) {
    await get('security', 'GMGN 合约', gmgnUrl, () =>
      gmgn(['token', 'security', '--chain', chain, '--address', address]),
    );
    await get('holders', 'GMGN 持有人', gmgnUrl, () =>
      gmgn([
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
    const creator = data.info?.dev?.creator_address;
    if (validAddress(chain, creator))
      await get(
        'dev',
        'GMGN 开发者',
        `https://gmgn.ai/${chain}/address/${creator}`,
        () =>
          gmgn([
            'portfolio',
            'created-tokens',
            '--chain',
            chain,
            '--wallet',
            creator,
          ]),
      );
  }
  const gpUrl =
    chain === 'sol'
      ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`
      : `https://api.gopluslabs.io/api/v1/token_security/${CHAINS[chain].id}?contract_addresses=${address}`;
  await get('goplus', 'GoPlus', gpUrl, async () => {
    const raw = await json(gpUrl);
    if (raw.code !== 1) throw new Error(`GoPlus 暂无数据（${raw.code}）`);
    const d = raw.result?.[chain === 'sol' ? address : address.toLowerCase()];
    if (!d || !Object.keys(d).length) throw new Error('GoPlus 未收录此代币');
    return d;
  });
  if (chain === 'robinhood') {
    const u = `${ROBINHOOD_EXPLORER}/api/v2/smart-contracts/${address}`;
    await get('explorer', 'Blockscout 合约结构', u, async () =>
      summarizeExplorer(await json(u), address),
    );
    await get('contract', 'Robinhood RPC 只读状态', ROBINHOOD_RPC, () =>
      readRobinhoodContract(address, (url, body) => json(url, {}, body)),
    );
  }
  if (chain === 'sol') {
    const u = `https://api.rugcheck.xyz/v1/tokens/${address}/report`;
    await get('rugcheck', 'RugCheck', u, () => json(u));
  }
  if (['eth', 'bsc', 'base'].includes(chain)) {
    const u = `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${CHAINS[chain].id}`;
    await get('honeypot', 'Honeypot.is', u, () => json(u));
  }
  if (chain === 'robinhood' && candidate.trench) data.trench = candidate.trench;
  if (!shouldContinue()) throw new Error('监控暂停或筛选已变化');
  const x = await fetchSocial(candidate);
  results.push(x);
  if (x.status === 'ok') data.social = x.data;
  return { data, sources: results };
}
