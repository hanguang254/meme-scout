import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Blocklist,
  parseBlocklist,
  MAX_BLOCKED,
} from '../scanner/blocklist.mjs';

const A = `robinhood:0x${'1'.repeat(40)}`;
const B = 'sol:So11111111111111111111111111111111111111112';
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocklist-'));
  return {
    file: path.join(dir, 'blocklist.json'),
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};
let now = 1790000000000;
const clock = () => now;

test('拉黑写进文件，重启后仍然有效', () => {
  const t = temp();
  const list = new Blocklist({ file: t.file, clock });
  list.load();
  list.set({ id: A, symbol: 'APAX' }, true);
  const again = new Blocklist({ file: t.file, clock });
  again.load();
  assert.equal(again.has(A), true);
  assert.deepEqual(again.entries(), [
    { id: A, symbol: 'APAX', at: new Date(now).toISOString() },
  ]);
  // Written private, like the watchlist: what you blocked is your own list.
  assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
  t.done();
});

test('解除拉黑后从文件里去掉', () => {
  const t = temp();
  const list = new Blocklist({ file: t.file, clock });
  list.load();
  list.set({ id: A, symbol: 'APAX' }, true);
  list.set({ id: B, symbol: 'SOLX' }, true);
  list.set({ id: A }, false);
  const again = new Blocklist({ file: t.file, clock });
  again.load();
  assert.equal(again.has(A), false);
  assert.equal(again.has(B), true);
  t.done();
});

test('重复拉黑不改最初的拉黑时间', () => {
  const t = temp();
  const list = new Blocklist({ file: t.file, clock });
  list.load();
  list.set({ id: A, symbol: 'APAX' }, true);
  const first = list.entries()[0].at;
  now += 60000;
  assert.equal(list.set({ id: A, symbol: 'APAX' }, true), false);
  assert.equal(list.entries()[0].at, first);
  t.done();
});

test('EVM 地址大小写不同是同一个币', () => {
  const t = temp();
  const list = new Blocklist({ file: t.file, clock });
  list.load();
  list.set({ id: `robinhood:0x${'A'.repeat(40)}`, symbol: 'X' }, true);
  assert.equal(list.has(`robinhood:0x${'a'.repeat(40)}`), true);
  // Solana addresses are base58 and case-sensitive, so they are left alone.
  list.set({ id: B, symbol: 'Y' }, true);
  assert.equal(list.has(B.toLowerCase()), false);
  t.done();
});

test('不认识的链或不像地址的 id 拒绝写入', () => {
  const t = temp();
  const list = new Blocklist({ file: t.file, clock });
  list.load();
  assert.throws(
    () => list.set({ id: 'evil:0x1', symbol: 'X' }, true),
    /代币 id 无效/,
  );
  assert.throws(
    () => list.set({ id: 'robinhood:0x123', symbol: 'X' }, true),
    /代币 id 无效/,
  );
  assert.throws(() => list.set({ id: 42 }, true), /代币 id 无效/);
  assert.equal(fs.existsSync(t.file), false, '拒绝的请求不该写出文件');
  t.done();
});

test('代币符号截断保存，缺省时留空', () => {
  const { entries } = parseBlocklist(
    JSON.stringify([
      { id: A, symbol: 'X'.repeat(200), at: '2026-09-29T00:00:00.000Z' },
      { id: B },
    ]),
  );
  assert.equal(entries[0].symbol.length, 50);
  assert.equal(entries[1].symbol, '');
  assert.equal(entries[1].at, null);
});

test('坏行跳过，好行照读；重复 id 只留第一条', () => {
  const { entries, skipped } = parseBlocklist(
    JSON.stringify([
      { id: A },
      { id: 'nope' },
      'x',
      { id: A.toUpperCase().replace('ROBINHOOD:0X', 'robinhood:0x') },
      { id: B },
    ]),
  );
  assert.deepEqual(
    entries.map((e) => e.id),
    [A, B],
  );
  assert.equal(skipped, 3);
});

test('超过上限的部分不读', () => {
  const many = Array.from({ length: MAX_BLOCKED + 3 }, (_, i) => ({
    id: `bsc:0x${String(i).padStart(40, '0')}`,
  }));
  const { entries, skipped } = parseBlocklist(JSON.stringify(many));
  assert.equal(entries.length, MAX_BLOCKED);
  assert.equal(skipped, 3);
});

test('名单满了拒绝再拉黑，而不是悄悄挤掉旧的', () => {
  const t = temp();
  fs.writeFileSync(
    t.file,
    JSON.stringify(
      Array.from({ length: MAX_BLOCKED }, (_, i) => ({
        id: `bsc:0x${String(i).padStart(40, '0')}`,
      })),
    ),
  );
  const list = new Blocklist({ file: t.file, clock });
  list.load();
  assert.throws(() => list.set({ id: A, symbol: 'X' }, true), /已达上限/);
  assert.equal(list.has(`bsc:0x${'0'.repeat(40)}`), true);
  t.done();
});

test('文件不存在是空名单，不是错误', () => {
  const t = temp();
  const list = new Blocklist({ file: t.file, clock });
  const state = list.load();
  assert.equal(state.error, null);
  assert.deepEqual(list.entries(), []);
  t.done();
});

test('文件损坏时报错并保持空名单，下一次拉黑不会把坏文件静默覆盖成只剩一条', () => {
  const t = temp();
  fs.writeFileSync(t.file, '[{');
  const list = new Blocklist({ file: t.file, clock });
  const state = list.load();
  assert.match(state.error, /解析失败/);
  // Writing now would replace every entry the broken file still holds with the
  // one just added. Refusing leaves the file for the user to fix.
  assert.throws(() => list.set({ id: A, symbol: 'X' }, true), /解析失败/);
  assert.equal(fs.readFileSync(t.file, 'utf8'), '[{');
  t.done();
});
