import { CHAINS } from './risk.mjs';
import { ROBINHOOD_RPC, responseFor } from './contract-evidence.mjs';
// Reading the chain directly is the only way to answer "does this wallet hold
// this coin right now" exactly. A top-holders sample answers a different and
// weaker question — it can only ever say "not in the sample", which is not the
// same as "does not hold", and a count built on it would quietly understate.
//
// The same canonical deterministic deployment on every EVM chain here,
// Robinhood included (verified: 7655 bytes of code at this address).
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
// Bare selectors: everything in this file is assembled as unprefixed hex and
// gains its 0x once, where the call is actually made.
const AGGREGATE3 = '82ad56cb';
const BALANCE_OF = '70a08231';
const DECIMALS = '313ce567';
// Sub-calls per eth_call. 400 balanceOf reads cost roughly 1.5M gas against a
// default 50M eth_call cap, and return about 75KB — comfortably inside both the
// node's limits and the 8MB response ceiling in providers.mjs. Those are the
// limits on what the node has to *do*, and they are the ones this number was
// sized against.
export const CHUNK = 400;
// The limit that binds first is none of them: it is the size of the request.
// Each balanceOf sub-call adds 448 bytes of hex to the body, so a 400-call batch
// is a 175KB POST, and an endpoint that caps bodies at 131072 bytes refuses the
// whole thing — every time, not now and then. Nothing here was measuring that,
// so on an endpoint with such a cap this column could never have shown a number,
// and the permanent failure arrived looking like a flaky one.
//
// 120KB stays under the 128KB cap those endpoints conventionally use. An
// endpoint stricter than that is not assumed or guessed at: it is learned from
// its own refusal, below.
export const MAX_BODY = 120 * 1024;
// What an endpoint turned out to accept, kept for the rest of the process.
// Without it every sweep would rediscover the same ceiling by being refused once
// per batch, forever.
export const bodyLimits = new Map();
// Chunks in flight at once. Enough that a 200-address list still sweeps well
// inside its interval, few enough that the node is never hit with a burst.
const LANES = 4;
const WORD = 64;
export const RPC_ENV = {
  eth: 'ETH_RPC_URL',
  bsc: 'BSC_RPC_URL',
  base: 'BASE_RPC_URL',
  arc: 'ARC_RPC_URL',
};
// Arc's own documented endpoints answer 401 without Circle credentials, so the
// default here is a public endpoint measured rather than assumed. It is a
// default, not a recommendation: ARC_RPC_URL overrides it, and a rate limit on
// it shows up as 未核验 in the column rather than as a zero.
//
// The previous default, rpc.arc-scan.org, was measured again after this column
// came back empty on Arc, and it cannot support this read at all: it caps bodies
// at 131072 bytes, and at the sizes it does accept it still returned 503 for
// half of a 4-wide wave and for 24 consecutive single requests spaced a second
// apart. This one answered every size up to 263KB and 30 of 30 requests at the
// rate a real sweep produces.
const ARC_RPC = 'https://arc.drpc.org';
// Robinhood's public endpoint is already known and used elsewhere; the other
// chains need an endpoint supplied, and say so rather than guessing at a public
// one whose rate limit would turn into silent gaps in the counts.
export function rpcFor(chain) {
  if (chain === 'robinhood')
    return process.env.ROBINHOOD_RPC_URL || ROBINHOOD_RPC;
  if (chain === 'arc') return process.env.ARC_RPC_URL || ARC_RPC;
  const url = process.env[RPC_ENV[chain] || ''];
  return typeof url === 'string' && /^https:\/\/\S+$/.test(url.trim())
    ? url.trim()
    : null;
}
const strip = (hex) =>
  typeof hex === 'string' && hex.startsWith('0x') ? hex.slice(2) : hex;
// padStart only pads. A value too wide for a word would otherwise be written
// out at full length and shift every byte after it, corrupting the whole batch
// into a plausible-looking answer rather than an error.
const hexWord = (value) => {
  const hex = BigInt(value).toString(16);
  if (hex.length > WORD) throw new Error('调用参数超出 32 字节');
  return hex.padStart(WORD, '0');
};
export const encodeBalanceOf = (wallet) =>
  BALANCE_OF + hexWord(String(wallet).toLowerCase());
// aggregate3((address target, bool allowFailure, bytes callData)[]) — a dynamic
// array of structs that are themselves dynamic, so the array holds one offset
// per element and each element holds one more for its bytes.
export function encodeAggregate3(calls) {
  const offsets = [];
  const structs = [];
  let offset = calls.length * 32;
  for (const call of calls) {
    const data = strip(call.callData);
    const words = Math.ceil(data.length / WORD);
    offsets.push(hexWord(offset));
    structs.push(
      hexWord(call.target) +
        hexWord(call.allowFailure ? 1 : 0) +
        hexWord(96) +
        hexWord(data.length / 2) +
        data.padEnd(words * WORD, '0'),
    );
    offset += 32 * (4 + words);
  }
  return (
    AGGREGATE3 +
    hexWord(32) +
    hexWord(calls.length) +
    offsets.join('') +
    structs.join('')
  );
}
// Returns (bool success, bytes returnData)[]. With allowFailure set, a token
// that is not a standard ERC-20 comes back as success:false instead of
// reverting the whole batch, so one odd contract costs its own pairs and
// nothing else.
export function decodeAggregate3(result, expected) {
  const data = strip(result);
  if (typeof data !== 'string' || !/^[\da-fA-F]*$/.test(data))
    throw new Error('multicall 响应不是十六进制');
  const at = (byte) => {
    const slice = data.slice(byte * 2, byte * 2 + WORD);
    if (slice.length !== WORD) throw new Error('multicall 响应被截断');
    return slice;
  };
  const size = (hex) => {
    const value = BigInt(`0x${hex}`);
    if (value > 0xffffffffn) throw new Error('multicall 响应偏移越界');
    return Number(value);
  };
  const base = size(at(0));
  const length = size(at(base));
  if (length !== expected)
    throw new Error(`multicall 返回 ${length} 条，本批请求 ${expected} 条`);
  const start = base + 32;
  const rows = [];
  for (let i = 0; i < length; i++) {
    const item = start + size(at(start + i * 32));
    const lengthAt = item + size(at(item + 32));
    const bytes = size(at(lengthAt));
    rows.push({
      success: BigInt(`0x${at(item)}`) === 1n,
      data: `0x${data.slice((lengthAt + 32) * 2, (lengthAt + 32 + bytes) * 2)}`,
    });
  }
  return rows;
}
export function decodeUint(hex) {
  const data = strip(hex);
  return /^[\da-fA-F]{64}$/.test(data) ? BigInt(`0x${data}`) : null;
}
// Hex is one body byte per character, so the encoding is the measurement rather
// than an estimate of it: one offset word in the array's table, four words of
// struct header, and the calldata padded up to whole words.
export const bodyBytes = (call) =>
  WORD * (5 + Math.ceil(strip(call.callData).length / WORD));
// The JSON-RPC envelope, the block parameter, the `0x` and aggregate3's two
// header words. Deliberately generous: overshooting here costs a fraction of one
// extra request, undershooting costs the entire batch.
const ENVELOPE = 512;
// Fill each request up to the ceiling instead of counting sub-calls into it. The
// size of the body is something we compute before sending, so there is no reason
// to send one that is knowably too large and then read the refusal as an outage.
export function packChunks(calls, maxBody = MAX_BODY, limit = CHUNK) {
  const chunks = [];
  let batch = [];
  let bytes = ENVELOPE;
  for (const call of calls) {
    const size = bodyBytes(call);
    if (batch.length && (batch.length >= limit || bytes + size > maxBody)) {
      chunks.push(batch);
      batch = [];
      bytes = ENVELOPE;
    }
    batch.push(call);
    bytes += size;
  }
  // A lone call wider than the ceiling still goes out: letting the node say what
  // it thinks beats dropping the pair here in silence.
  if (batch.length) chunks.push(batch);
  return chunks;
}
// A refusal that names the size will name it again for the same bytes — there is
// nothing to wait out, so the batch is halved and asked again and the endpoint's
// ceiling is remembered, which is what keeps the constant above from being the
// thing this feature depends on. Anything else may be the node having a moment,
// and endpoints measurably do; one lost batch empties a whole coin's column, so
// it is worth asking again before calling it a gap.
const TOO_LARGE = /too large|413|payload|request entity|body size/i;
const RETRIES = 2;
const BACKOFF = 400;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function readBatch(rpc, block, calls, request, attempt = 0) {
  try {
    return await callChunk(rpc, block, calls, request);
  } catch (e) {
    if (TOO_LARGE.test(String(e.message)) && calls.length > 1) {
      const bytes = calls.reduce((n, c) => n + bodyBytes(c), ENVELOPE);
      // Floored, so the remembered ceiling converges downward instead of
      // creeping back up to the size that was just refused.
      bodyLimits.set(
        rpc,
        Math.min(bodyLimits.get(rpc) ?? Infinity, Math.floor(bytes / 2)),
      );
      const half = Math.ceil(calls.length / 2);
      return [
        ...(await readBatch(rpc, block, calls.slice(0, half), request)),
        ...(await readBatch(rpc, block, calls.slice(half), request)),
      ];
    }
    if (attempt >= RETRIES) throw e;
    await sleep(BACKOFF * (attempt + 1));
    return readBatch(rpc, block, calls, request, attempt + 1);
  }
}
async function callChunk(rpc, block, calls, request) {
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
      block,
    ],
  });
  if (raw?.error) throw new Error(raw.error.message || 'RPC 拒绝了批量调用');
  return decodeAggregate3(raw?.result, calls.length);
}
// One sweep: every listed wallet against every listed token, all of it read at a
// single pinned block so the numbers on one screen describe one moment rather
// than a smear across however long the sweep took.
export async function readTrackedHoldings({
  chain,
  tokens,
  wallets,
  request: send,
  decimals = new Map(),
  chunkSize = CHUNK,
  maxBody = MAX_BODY,
}) {
  if (chain === 'sol')
    throw new Error('Solana 不走 EVM 调用，这条链暂不支持链上余额核验');
  const rpc = rpcFor(chain);
  if (!rpc)
    throw new Error(
      `${CHAINS[chain]?.label || chain} 未配置 RPC（.env.local 里的 ${RPC_ENV[chain] || 'RPC_URL'}），无法核验链上余额`,
    );
  // Counted here rather than derived from the chunk count, because a split or a
  // retry makes those two different numbers and the panel shows this one.
  let sent = 0;
  const request = (...args) => {
    sent++;
    return send(...args);
  };
  const head = await request(rpc, [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'eth_getCode',
      params: [MULTICALL3, 'latest'],
    },
  ]);
  const id = CHAINS[chain]?.id;
  if (id && BigInt(responseFor(head, 1)) !== BigInt(id))
    throw new Error('RPC 返回的链 ID 与所选链不一致');
  const block = responseFor(head, 2);
  if (!/^0x[\da-f]+$/i.test(block)) throw new Error('RPC 区块编号无效');
  if (responseFor(head, 3) === '0x')
    throw new Error('该 RPC 上没有 Multicall3，无法批量核验余额');
  const calls = [];
  for (const token of tokens)
    if (!decimals.has(token.id))
      // Immutable once read, so this costs one sub-call per token ever.
      calls.push({
        kind: 'decimals',
        token,
        target: token.address,
        callData: DECIMALS,
      });
  for (const token of tokens)
    for (const wallet of wallets)
      calls.push({
        kind: 'balance',
        token,
        wallet,
        target: token.address,
        callData: encodeBalanceOf(wallet),
      });
  const found = new Map(
    tokens.map((t) => [t.id, { hits: [], ok: 0, unknown: 0, unreached: 0 }]),
  );
  const chunks = packChunks(
    calls,
    Math.min(maxBody, bodyLimits.get(rpc) ?? Infinity),
    chunkSize,
  );
  let failed = 0;
  let error = null;
  for (let i = 0; i < chunks.length; i += LANES) {
    await Promise.all(
      chunks.slice(i, i + LANES).map(async (batch) => {
        let rows;
        try {
          rows = await readBatch(rpc, block, batch, request);
        } catch (e) {
          // A chunk that never came back leaves its pairs unknown, not zero.
          // Everything the other chunks did learn still counts. These are
          // counted apart from the ones the chain answered badly, because
          // nothing was asked about the token here and saying otherwise blames
          // the coin for the transport.
          failed++;
          error ??= String(e.message).slice(0, 140);
          for (const call of batch)
            if (call.kind === 'balance') {
              const slot = found.get(call.token.id);
              slot.unknown++;
              slot.unreached++;
            }
          return;
        }
        for (const [j, call] of batch.entries()) {
          const value = rows[j]?.success ? decodeUint(rows[j].data) : null;
          if (call.kind === 'decimals') {
            if (value !== null && value <= 36n)
              decimals.set(call.token.id, Number(value));
            continue;
          }
          const slot = found.get(call.token.id);
          if (value === null) slot.unknown++;
          else {
            slot.ok++;
            // Balances are kept as decimal strings: a BigInt does not survive
            // JSON, and the raw integer is what the chain actually said.
            if (value > 0n)
              slot.hits.push({ wallet: call.wallet, raw: value.toString() });
          }
        }
      }),
    );
  }
  return {
    rpc,
    block: Number(BigInt(block)),
    observedAt: new Date().toISOString(),
    wallets: wallets.length,
    requests: sent,
    failedChunks: failed,
    error,
    decimals,
    tokens: Object.fromEntries(
      [...found].map(([id, slot]) => [
        id,
        {
          hits: slot.hits,
          unknown: slot.unknown,
          unreached: slot.unreached,
          // Three states, never collapsed into a number: fully read, read with
          // gaps, or not read at all. Only the first two may be shown as a
          // count — an unchecked coin is not a coin with zero holders.
          status: slot.ok ? (slot.unknown ? 'partial' : 'ok') : 'unchecked',
        },
      ]),
    ),
  };
}
