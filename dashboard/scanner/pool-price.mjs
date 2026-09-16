import { keccakHex } from './keccak.mjs';
import {
  MULTICALL3,
  decodeAggregate3,
  encodeAggregate3,
  decodeUint,
  rpcFor,
  RPC_ENV,
} from './tracked-balances.mjs';
// Why read the pool at all when the quote source already publishes a price:
// DexScreener republishes on a ~32 second server-side cycle, so the market cap
// in the table can be three quarters of a minute behind the chain no matter how
// often it is polled. The chain has no such cycle. Reading the pool the source
// itself named turns that into one market interval of lag.
//
// This does not replace the source. The source still owns which pool is the
// deepest, what supply the market cap is computed from, and what the quote
// token is worth in dollars — none of which a pool read can answer. All this
// lane contributes is a fresher price *in the pool's own quote token*, applied
// as a ratio so every one of those source-owned assumptions cancels out.
const SLOT0 = '3850c7bd'; // slot0() — Uniswap V3
const GET_RESERVES = '0902f1ac'; // getReserves() — Uniswap V2
const EXTSLOAD = '1e2eaeaf'; // extsload(bytes32) — Uniswap V4 singleton
const TOKEN0 = '0dfe1681'; // token0()
const DECIMALS = '313ce567'; // decimals()
const GET_BLOCK = '42cbb15c'; // Multicall3.getBlockNumber()
const WORD = 64;
// Uniswap V4 keeps every pool in one contract, so the read is a storage slot
// rather than a call: `pools` is mapping slot 6 of PoolManager, and a mapping
// entry lives at keccak256(abi.encode(key, slot)). The first word packs
// sqrtPriceX96 into its low 160 bits.
const V4_POOLS_SLOT = 6;
// Verified by reading code at this address on both chains. Deliberately a table
// rather than a constant: V4 is a per-chain deployment, and a chain absent from
// it loses only its V4 pools' freshness — they keep the source's price and say
// so, which is the honest outcome for an address nobody here has checked.
const V4_MANAGER = {
  robinhood: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  arc: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
};
export const v4Manager = (chain) => V4_MANAGER[chain] ?? null;
// A 32-byte pair identifier is a V4 pool id; a 20-byte one is a real contract.
// This is how the sources themselves distinguish the two, and it settles V4
// without consulting a label at all.
//
// For V2 vs V3 the label is the only signal, and the two sources spell it
// differently: DexScreener publishes labels ["v3"], GeckoTerminal publishes a
// dex id "uniswap-v3-arc". Hence a search for the version as its own token
// rather than an equality test — bounded on both sides so a future "v30" or an
// address ending in "v3" cannot match.
export const poolVersion = (pairAddress, labels = []) => {
  const value = String(pairAddress || '');
  if (/^0x[\da-fA-F]{64}$/.test(value)) return 'v4';
  if (!/^0x[\da-fA-F]{40}$/.test(value)) return null;
  const text = labels.map((l) => String(l).toLowerCase()).join(' ');
  const has = (v) => new RegExp(`(^|[^a-z\\d])${v}([^a-z\\d]|$)`).test(text);
  // A label claiming v4 on a 20-byte address contradicts itself — a V4 pool is
  // identified by a 32-byte id, never a contract. Reading it as V4 would hash a
  // short value into a storage slot that happens to exist and return something
  // plausible, so the contradiction is left unresolved instead.
  return has('v2') ? 'v2' : has('v3') ? 'v3' : null;
};
const bare = (hex) => (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
export const v4StateSlot = (poolId) =>
  keccakHex(bare(poolId) + BigInt(V4_POOLS_SLOT).toString(16).padStart(WORD, '0'));
// Uniswap orders every pool's tokens by address on all three versions, so the
// side a token sits on is decidable without a request. V2 and V3 are still
// asked directly — it costs one cached sub-call and removes the assumption
// that the source reported the same address the pool actually holds (a pool
// quoted in "ETH" holds WETH, and the two do not sort the same way).
const lower = (a, b) => bare(a) < bare(b);
const NATIVE = '0x0000000000000000000000000000000000000000';
// sqrtPriceX96 is a Q64.96 square root. Squaring it in floating point costs
// about one part in 1e16, which is ten orders of magnitude below the precision
// the quote source publishes; carrying it in BigInt would buy digits nothing
// downstream can use.
const fromSqrtX96 = (raw, dec0, dec1) => {
  const q = Number(raw) / 2 ** 96;
  const price = q * q * 10 ** (dec0 - dec1);
  return Number.isFinite(price) && price > 0 ? price : null;
};
function decodeReserves(hex) {
  const data = bare(hex);
  if (data.length < WORD * 2) return null;
  const r0 = BigInt(`0x${data.slice(0, WORD)}`);
  const r1 = BigInt(`0x${data.slice(WORD, WORD * 2)}`);
  return r0 > 0n && r1 > 0n ? [r0, r1] : null;
}
// The low 160 bits of V4's packed slot0. The rest is tick, protocol fee and LP
// fee, none of which this lane reads.
const MASK160 = (1n << 160n) - 1n;
// Everything a pool read can say about one candidate, including the reasons it
// could not say anything. A pool this lane cannot read is not an error — it
// keeps the source's number and the row explains which is which.
const SKIP = {
  version: '来源未标明池版本，无法链上读取',
  manager: '该链未登记 Uniswap V4 单例地址，V4 池本轮不做链上读取',
  tokens: '池的两种代币地址不完整',
  decimals: '代币精度未读到',
  state: '池状态本轮未读到',
  price: '池状态解出的价格不可用',
};
// Two different things get told apart here. A chain that is not EVM has no pool
// call to make and never will; a chain that simply has no endpoint is one line
// of configuration away, so the reason names the variable to set. Collapsing
// both into "未配置 RPC" would send someone looking for a Solana setting that
// does not exist.
const noRpcReason = (chain) =>
  chain === 'sol'
    ? 'Solana 不是 EVM 链，这里没有池价可读，市值沿用来源发布值'
    : `该链未配置 RPC（.env.local 里的 ${RPC_ENV[chain] || 'RPC_URL'}），市值沿用来源发布值`;
// How far the chain may disagree with the source before the read is discarded.
// The failure modes this guards against are not subtle: a wrong decimals pair
// is off by a power of ten, a reversed token order is off by the square of the
// price. A real move over the source's ~32 second lag is nothing like either.
// Rejecting means keeping the source's number — exactly what this lane would
// have shown without the pool read — so the guard can never be worse than not
// reading at all, which is why it is set tight rather than generously.
export const PRICE_GUARD = 5;
export function freshen(quote, onchain) {
  const base = Number(quote?.price);
  const native = Number(quote?.priceNative);
  if (!onchain?.price) return null;
  if (!(base > 0) || !(native > 0)) return null;
  const ratio = onchain.price / native;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  if (ratio > PRICE_GUARD || ratio < 1 / PRICE_GUARD)
    return {
      rejected: true,
      ratio,
      reason: `链上价与来源价相差 ${ratio >= 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)} 倍，本次不采用链上价`,
    };
  const scale = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n * ratio : null;
  };
  return {
    rejected: false,
    ratio,
    price: base * ratio,
    marketCap: scale(quote.marketCap),
    fdv: scale(quote.fdv),
    block: onchain.block,
    version: onchain.version,
    pool: onchain.pool,
  };
}
async function callBatch(rpc, calls, request) {
  const raw = await request(rpc, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [
      {
        to: MULTICALL3,
        data: `0x${encodeAggregate3(
          calls.map((c) => ({
            target: c.target,
            allowFailure: true,
            callData: c.callData,
          })),
        )}`,
      },
      'latest',
    ],
  });
  if (raw?.error) throw new Error(raw.error.message || 'RPC 拒绝了批量调用');
  return decodeAggregate3(raw?.result, calls.length);
}
// One sweep. Every pool on the list is read inside a single eth_call, so the
// prices on one screen come from one block rather than from wherever each
// request happened to land — the same property the tracked-address column
// pins its balances with, for the same reason.
//
// `meta` holds what cannot change: a pool's token order and a token's decimals.
// It is supplied by the caller and kept across sweeps, so the steady state is
// one sub-call per pool and nothing else.
export async function readPoolPrices({ chain, pools, request, meta = new Map() }) {
  const skipped = new Map();
  const prices = new Map();
  const drop = (key, reason) => skipped.set(key, reason);
  const rpc = rpcFor(chain);
  // No endpoint is a normal state, not a failure — the source's own price still
  // fills the row. Every pool still gets a reason, because a row that silently
  // lacks an explanation is indistinguishable from one that was read and agreed.
  if (!rpc) {
    const reason = noRpcReason(chain);
    for (const pool of pools) drop(pool.key, reason);
    return { rpc: null, block: null, prices, skipped, supported: false };
  }
  const jobs = [];
  const claimed = new Set();
  for (const pool of pools) {
    const version = pool.version;
    // Results come back keyed, so two jobs sharing a key would silently leave
    // the second one's price filed under the first one's coin — a wrong number
    // that looks entirely reasonable. Refuse instead: the caller owns the keys
    // and a collision there is a bug in the caller, not a condition to absorb.
    if (claimed.has(pool.key))
      throw new Error(`池价读取收到重复的键 ${pool.key}`);
    claimed.add(pool.key);
    if (!version) {
      drop(pool.key, SKIP.version);
      continue;
    }
    if (version === 'v4' && !v4Manager(chain)) {
      drop(pool.key, SKIP.manager);
      continue;
    }
    if (!pool.base || !pool.quote) {
      drop(pool.key, SKIP.tokens);
      continue;
    }
    jobs.push({ ...pool, version });
  }
  if (!jobs.length)
    return { rpc, block: null, prices, skipped, supported: true };
  const calls = [];
  const add = (call) => calls.push(call) - 1;
  const blockAt = add({ target: MULTICALL3, callData: GET_BLOCK });
  const decimalsAt = new Map();
  const needDecimals = (address) => {
    const key = `dec:${bare(address)}`;
    if (meta.has(key) || decimalsAt.has(key)) return;
    // The chain's own unit has no decimals() to call and is 18 everywhere this
    // runs; a call to the zero address would come back empty and cost the pool
    // its read for a value that is not in question.
    if (bare(address) === bare(NATIVE)) return meta.set(key, 18);
    decimalsAt.set(key, add({ target: address, callData: DECIMALS }));
  };
  const orderAt = new Map();
  for (const job of jobs) {
    needDecimals(job.base);
    needDecimals(job.quote);
    if (job.version === 'v4') continue;
    const key = `t0:${bare(job.pool)}`;
    if (meta.has(key) || orderAt.has(key)) continue;
    orderAt.set(key, add({ target: job.pool, callData: TOKEN0 }));
  }
  const stateAt = new Map();
  for (const job of jobs)
    stateAt.set(
      job.key,
      add(
        job.version === 'v4'
          ? {
              target: v4Manager(chain),
              callData: EXTSLOAD + v4StateSlot(job.pool),
            }
          : {
              target: job.pool,
              callData: job.version === 'v2' ? GET_RESERVES : SLOT0,
            },
      ),
    );
  const rows = await callBatch(rpc, calls, request);
  const value = (index) =>
    index === undefined || !rows[index]?.success ? null : rows[index].data;
  const blockRaw = decodeUint(value(blockAt) ?? '');
  const block = blockRaw === null ? null : Number(blockRaw);
  for (const [key, index] of decimalsAt) {
    const d = decodeUint(value(index) ?? '');
    if (d !== null && d <= 36n) meta.set(key, Number(d));
  }
  for (const [key, index] of orderAt) {
    const raw = value(index);
    if (raw && bare(raw).length >= WORD)
      meta.set(key, `0x${bare(raw).slice(WORD - 40, WORD)}`);
  }
  for (const job of jobs) {
    const dec0Key = `dec:${bare(job.base)}`;
    const dec1Key = `dec:${bare(job.quote)}`;
    if (!meta.has(dec0Key) || !meta.has(dec1Key)) {
      drop(job.key, SKIP.decimals);
      continue;
    }
    const token0 = meta.get(`t0:${bare(job.pool)}`);
    // V4 pools live in a singleton with nothing to ask, so their order comes
    // from the address sort the PoolKey is built with. V2 and V3 answered.
    const baseIsToken0 =
      job.version === 'v4'
        ? lower(job.base, job.quote)
        : token0
          ? bare(token0) === bare(job.base)
          : null;
    if (baseIsToken0 === null) {
      drop(job.key, SKIP.tokens);
      continue;
    }
    const baseDec = meta.get(dec0Key);
    const quoteDec = meta.get(dec1Key);
    const [dec0, dec1] = baseIsToken0
      ? [baseDec, quoteDec]
      : [quoteDec, baseDec];
    const raw = value(stateAt.get(job.key));
    if (!raw || bare(raw).length < WORD) {
      drop(job.key, SKIP.state);
      continue;
    }
    let price = null;
    if (job.version === 'v2') {
      const reserves = decodeReserves(raw);
      if (reserves)
        price = (Number(reserves[1]) / Number(reserves[0])) * 10 ** (dec0 - dec1);
    } else {
      const word = BigInt(`0x${bare(raw).slice(0, WORD)}`);
      const sqrt = job.version === 'v4' ? word & MASK160 : word;
      if (sqrt > 0n) price = fromSqrtX96(sqrt, dec0, dec1);
    }
    // token0-in-token1 so far. The candidate is whichever side it is on.
    if (price !== null && !baseIsToken0) price = 1 / price;
    if (price === null || !Number.isFinite(price) || price <= 0) {
      drop(job.key, SKIP.price);
      continue;
    }
    prices.set(job.key, {
      price,
      block,
      version: job.version,
      pool: job.pool,
    });
  }
  return { rpc, block, prices, skipped, supported: true, requests: 1 };
}
