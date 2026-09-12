import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The list is maintained in whatever wallet tracker it came from and dropped in
// here as that tool exported it, so this parser reads that shape instead of
// asking for a conversion step. Fields it does not use — alert toggles, sounds —
// are ignored and never rewritten. Keeping the export directly importable is
// what makes the list maintainable: updating it is one file copy, not an edit
// kept in sync in two places.
export const WATCHLIST_FILE = fileURLToPath(
  new URL('../watchlist.json', import.meta.url),
);
// A bound on the balance matrix, not on anyone's ambitions: every entry costs
// one sub-call per listed candidate per sweep.
export const MAX_ENTRIES = 500;
const NOTE_LIMIT = 80;
const RELOAD_DEBOUNCE = 300;
export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// A quarter of a real list has no note at all. Falling back to the address keeps
// those rows readable and visibly unnamed, which is also the nudge to go name
// them — a hit you cannot attribute is worth less than one you can.
export const entryLabel = (e) =>
  e.note || `${shortAddress(e.address)}（未命名）`;
function readEntry(row) {
  const raw = typeof row === 'string' ? row : row?.address;
  if (typeof raw !== 'string' || !/^0x[\da-fA-F]{40}$/.test(raw.trim()))
    return { error: '不是 EVM 地址（需要 0x 加 40 位十六进制）' };
  const text = (v, limit) =>
    typeof v === 'string' ? v.trim().slice(0, limit) : '';
  return {
    entry: {
      // Lowercased for matching, which is how every address reaches this file
      // and how the RPC answers; EVM addresses are case-insensitive.
      address: raw.trim().toLowerCase(),
      note: text(row?.name, NOTE_LIMIT),
      emoji: text(row?.emoji, 8),
      groups: (Array.isArray(row?.groups) ? row.groups : [])
        .map((g) => text(g, 40))
        .filter(Boolean)
        .slice(0, 8),
    },
  };
}
// Returns what could be read plus a reason for everything that could not. A bad
// row is reported and skipped, never dropped in silence: a list that quietly
// lost half its addresses would turn every count on the page into an
// understatement that still looks like a checked result.
export function parseWatchlist(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('名单不是合法 JSON');
  }
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.wallets)
      ? raw.wallets
      : Array.isArray(raw?.addresses)
        ? raw.addresses
        : null;
  if (!list)
    throw new Error('名单需要是数组，或是含 wallets / addresses 数组的对象');
  const entries = [];
  const skipped = [];
  const seen = new Map();
  for (const [i, row] of list.entries()) {
    if (entries.length >= MAX_ENTRIES) {
      skipped.push({
        index: i + 1,
        address: null,
        reason: `超出 ${MAX_ENTRIES} 条上限，其后 ${list.length - i} 条未读取`,
      });
      break;
    }
    const { entry, error } = readEntry(row);
    if (error) {
      skipped.push({ index: i + 1, address: null, reason: error });
      continue;
    }
    const first = seen.get(entry.address);
    if (first !== undefined) {
      skipped.push({
        index: i + 1,
        address: entry.address,
        reason: `与第 ${first} 条地址重复，保留前一条`,
      });
      continue;
    }
    seen.set(entry.address, i + 1);
    entries.push(entry);
  }
  return { entries, skipped, read: list.length };
}
export class Watchlist {
  constructor({ file = WATCHLIST_FILE, clock = Date.now } = {}) {
    this.file = file;
    this.clock = clock;
    this.onChange = () => {};
    this.watcher = null;
    this.timer = null;
    this.state = {
      entries: [],
      skipped: [],
      read: 0,
      loadedAt: null,
      error: null,
      present: false,
    };
  }
  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      // No file is a configuration state, not a failure: the feature is simply
      // off until one exists, and the page says so rather than showing zeros.
      this.state =
        e.code === 'ENOENT'
          ? {
              entries: [],
              skipped: [],
              read: 0,
              loadedAt: null,
              error: null,
              present: false,
            }
          : {
              ...this.state,
              error: `名单读取失败：${String(e.message).slice(0, 120)}`,
            };
      return this.state;
    }
    try {
      const { entries, skipped, read } = parseWatchlist(text);
      this.state = {
        entries,
        skipped,
        read,
        loadedAt: new Date(this.clock()).toISOString(),
        error: null,
        present: true,
      };
    } catch (e) {
      // The last list that parsed stays in use. Falling back to an empty one
      // would send every count on the page to 0 while a typo is being fixed,
      // and a 0 here is supposed to mean "checked, nobody holds it".
      this.state = {
        ...this.state,
        error: `名单解析失败，仍在使用上次成功载入的 ${this.state.entries.length} 条：${String(e.message).slice(0, 120)}`,
      };
    }
    return this.state;
  }
  addressKey() {
    return this.state.entries.map((e) => e.address).join(',');
  }
  start() {
    this.load();
    if (this.watcher) return this.state;
    try {
      // Watching the directory rather than the file: editors and export tools
      // save by writing a temporary file and renaming it over the target, which
      // stops a file watcher after the very first save.
      this.watcher = fs.watch(path.dirname(this.file), (_event, name) => {
        if (name && name !== path.basename(this.file)) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.reload(), RELOAD_DEBOUNCE);
        this.timer?.unref?.();
      });
      this.watcher.unref?.();
      // A watcher that dies leaves the loaded list in place; it just stops
      // picking up edits until the next restart.
      this.watcher.on('error', () => {});
    } catch {
      // Same: no watcher is survivable, an unhandled throw here is not.
    }
    return this.state;
  }
  reload() {
    const before = this.addressKey();
    this.load();
    // Notes and emoji are resolved when a snapshot is built, so editing one
    // shows up on the next push without re-reading a single balance. Only a
    // changed set of addresses needs the chain asked again.
    this.onChange(this.addressKey() !== before);
  }
  stop() {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = null;
  }
}
