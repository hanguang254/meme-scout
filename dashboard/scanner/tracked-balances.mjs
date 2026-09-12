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
// node's limits and the 8MB response ceiling in providers.mjs.
export const CHUNK = 400;
// Chunks in flight at once. Enough that a 200-address list still sweeps well
// inside its interval, few enough that the node is never hit with a burst.
const LANES = 4;
const WORD = 64;
export const RPC_ENV = {
  eth: 'ETH_RPC_URL',
  bsc: 'BSC_RPC_URL',
  base: 'BASE_RPC_URL',
};
// Robinhood's public endpoint is already known and used elsewhere; the other
// chains need an endpoint supplied, and say so rather than guessing at a public
// one whose rate limit would turn into silent gaps in the counts.
export function rpcFor(chain) {
  if (chain === 'robinhood')
    return process.env.ROBINHOOD_RPC_URL || ROBINHOOD_RPC;
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
  request,
  decimals = new Map(),
  chunkSize = CHUNK,
}) {
  if (chain === 'sol')
    throw new Error('Solana 不走 EVM 调用，这条链暂不支持链上余额核验');
  const rpc = rpcFor(chain);
  if (!rpc)
    throw new Error(
      `${CHAINS[chain]?.label || chain} 未配置 RPC（.env.local 里的 ${RPC_ENV[chain] || 'RPC_URL'}），无法核验链上余额`,
    );
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
    tokens.map((t) => [t.id, { hits: [], ok: 0, unknown: 0 }]),
  );
  const chunks = [];
  for (let i = 0; i < calls.length; i += chunkSize)
    chunks.push(calls.slice(i, i + chunkSize));
  let failed = 0;
  let error = null;
  for (let i = 0; i < chunks.length; i += LANES) {
    await Promise.all(
      chunks.slice(i, i + LANES).map(async (batch) => {
        let rows;
        try {
          rows = await callChunk(rpc, block, batch, request);
        } catch (e) {
          // A chunk that never came back leaves its pairs unknown, not zero.
          // Everything the other chunks did learn still counts.
          failed++;
          error ??= String(e.message).slice(0, 140);
          for (const call of batch)
            if (call.kind === 'balance') found.get(call.token.id).unknown++;
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
    requests: 1 + chunks.length,
    failedChunks: failed,
    error,
    decimals,
    tokens: Object.fromEntries(
      [...found].map(([id, slot]) => [
        id,
        {
          hits: slot.hits,
          unknown: slot.unknown,
          // Three states, never collapsed into a number: fully read, read with
          // gaps, or not read at all. Only the first two may be shown as a
          // count — an unchecked coin is not a coin with zero holders.
          status: slot.ok ? (slot.unknown ? 'partial' : 'ok') : 'unchecked',
        },
      ]),
    ),
  };
}
