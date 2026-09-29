import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHAINS, validAddress } from './risk.mjs';
// Coins the user has told the scanner to stop spending anything on. Unlike the
// unsellable filter on the page, this is not a listing decision: a blocked coin
// is dropped before the board is built, so no scan, quote, pool read or balance
// sweep is ever issued for it again. That is the only reason the list lives on
// this side — a list kept in the browser could hide rows but not stop requests.
export const BLOCKLIST_FILE = fileURLToPath(
  new URL('../blocklist.json', import.meta.url),
);
// Every entry is checked against every discovered row each cycle; the bound
// keeps a runaway client from growing the file without limit.
export const MAX_BLOCKED = 1000;
const SYMBOL_LIMIT = 50;
// Candidate ids are `chain:address`, with EVM addresses lowercased where they
// are built (see id() in providers.mjs). Solana is base58 and case-sensitive,
// so it is the one chain whose address is left exactly as given.
export function blockId(raw) {
  if (typeof raw !== 'string') return null;
  const at = raw.indexOf(':');
  const chain = raw.slice(0, at);
  const address = raw.slice(at + 1).trim();
  if (at < 1 || !CHAINS[chain] || !validAddress(chain, address)) return null;
  return `${chain}:${chain === 'sol' ? address : address.toLowerCase()}`;
}
const text = (v, limit) =>
  typeof v === 'string' ? v.trim().slice(0, limit) : '';
// A bad row is counted and skipped, not fatal: one hand-edited typo must not
// un-block everything else in the file.
export function parseBlocklist(input) {
  let raw;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error('拉黑名单不是合法 JSON');
  }
  if (!Array.isArray(raw)) throw new Error('拉黑名单需要是数组');
  const entries = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of raw) {
    const id = blockId(row?.id);
    if (!id || seen.has(id) || entries.length >= MAX_BLOCKED) {
      skipped++;
      continue;
    }
    seen.add(id);
    const at = Date.parse(row.at);
    entries.push({
      id,
      symbol: text(row.symbol, SYMBOL_LIMIT),
      at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    });
  }
  return { entries, skipped };
}
export class Blocklist {
  constructor({ file = BLOCKLIST_FILE, clock = Date.now } = {}) {
    this.file = file;
    this.clock = clock;
    this.byId = new Map();
    this.state = { error: null, skipped: 0 };
  }
  load() {
    let input;
    try {
      input = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      // No file just means nothing has been blocked yet.
      this.byId = new Map();
      this.state = {
        error:
          e.code === 'ENOENT'
            ? null
            : `拉黑名单读取失败：${String(e.message).slice(0, 120)}`,
        skipped: 0,
      };
      return this.state;
    }
    try {
      const { entries, skipped } = parseBlocklist(input);
      this.byId = new Map(entries.map((e) => [e.id, e]));
      this.state = { error: null, skipped };
    } catch (e) {
      // Kept empty rather than guessed at, and the error stays set until the
      // file is fixed: set() refuses to write over it, because saving the one
      // entry just added would silently replace everything the file still held.
      this.byId = new Map();
      this.state = {
        error: `拉黑名单解析失败，暂未生效：${String(e.message).slice(0, 120)}`,
        skipped: 0,
      };
    }
    return this.state;
  }
  has(id) {
    const key = blockId(id);
    return key !== null && this.byId.has(key);
  }
  entries() {
    return [...this.byId.values()];
  }
  // Returns whether anything changed, so a repeated click costs no rewrite.
  set({ id, symbol }, blocked) {
    const key = blockId(id);
    if (!key) throw new Error('代币 id 无效');
    if (this.state.error) throw new Error(this.state.error);
    if (Boolean(blocked) === this.byId.has(key)) return false;
    const next = new Map(this.byId);
    if (blocked) {
      if (next.size >= MAX_BLOCKED)
        throw new Error(`拉黑名单已达上限 ${MAX_BLOCKED} 条`);
      next.set(key, {
        id: key,
        symbol: text(symbol, SYMBOL_LIMIT),
        at: new Date(this.clock()).toISOString(),
      });
    } else next.delete(key);
    // Written before the in-memory list changes, so a failed write leaves the
    // two agreeing instead of blocking something that will not survive restart.
    fs.writeFileSync(
      this.file,
      JSON.stringify([...next.values()], null, 2) + '\n',
      {
        mode: 0o600,
      },
    );
    fs.chmodSync(this.file, 0o600);
    this.byId = next;
    return true;
  }
}
