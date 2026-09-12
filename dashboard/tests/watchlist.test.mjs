import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseWatchlist,
  entryLabel,
  MAX_ENTRIES,
  Watchlist,
} from '../scanner/watchlist.mjs';
const entry = (address, extra = {}) => ({
  address,
  name: '',
  emoji: '',
  alertsOnToast: true,
  alertsOnFeed: true,
  alertsOnBubble: true,
  sound: 'default',
  ...extra,
});
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
test('读取钱包工具的导出格式，忽略用不到的字段', () => {
  const { entries, skipped } = parseWatchlist(
    JSON.stringify([entry(A, { name: '榜一小地址', emoji: '👻' })]),
  );
  assert.equal(skipped.length, 0);
  assert.deepEqual(entries, [
    { address: A, note: '榜一小地址', emoji: '👻', groups: [] },
  ]);
});
test('地址统一小写，便于和 RPC 的回答对上', () => {
  const { entries } = parseWatchlist(
    JSON.stringify([entry('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01')]),
  );
  assert.equal(
    entries[0].address,
    '0xabcdef0123456789abcdef0123456789abcdef01',
  );
});
test('坏行被跳过并说明原因，不影响同一份名单里的好行', () => {
  const { entries, skipped } = parseWatchlist(
    JSON.stringify([entry(A), entry('0x123'), { name: '没有地址' }, entry(B)]),
  );
  assert.deepEqual(
    entries.map((e) => e.address),
    [A, B],
  );
  assert.deepEqual(
    skipped.map((s) => s.index),
    [2, 3],
  );
  assert.match(skipped[0].reason, /EVM 地址/);
});
test('地址重复只保留第一条，并指出跟哪一条撞了', () => {
  const { entries, skipped } = parseWatchlist(
    JSON.stringify([
      entry(A, { name: '先写的' }),
      entry(B),
      entry(A.toUpperCase().replace('0X', '0x'), { name: '后写的' }),
    ]),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].note, '先写的');
  assert.equal(skipped[0].index, 3);
  assert.match(skipped[0].reason, /与第 1 条地址重复/);
});
test('同名不同址是两条，名字不是主键', () => {
  const { entries } = parseWatchlist(
    JSON.stringify([
      entry(A, { name: '我的地址' }),
      entry(B, { name: '我的地址' }),
    ]),
  );
  assert.equal(entries.length, 2);
});
test('超过上限后停止读取，并说明还剩多少条没读', () => {
  const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) =>
    entry(`0x${String(i).padStart(40, '0')}`),
  );
  const { entries, skipped } = parseWatchlist(JSON.stringify(many));
  assert.equal(entries.length, MAX_ENTRIES);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /超出 500 条上限，其后 5 条未读取/);
});
test('也接受包着 wallets 数组的对象', () => {
  const { entries } = parseWatchlist(JSON.stringify({ wallets: [entry(A)] }));
  assert.equal(entries.length, 1);
});
test('不是 JSON 或不是名单的内容直接报错，不返回空名单', () => {
  assert.throws(() => parseWatchlist('{'), /不是合法 JSON/);
  assert.throws(() => parseWatchlist('{"a":1}'), /需要是数组/);
});
test('没有备注的地址显示成截断地址并标注未命名', () => {
  assert.equal(entryLabel({ address: A, note: '' }), '0x1111…1111（未命名）');
  assert.equal(entryLabel({ address: A, note: '有名字' }), '有名字');
});
test('解析失败时保留上一次成功载入的名单，而不是清空成 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-'));
  const file = path.join(dir, 'watchlist.json');
  const list = new Watchlist({ file });
  fs.writeFileSync(file, JSON.stringify([entry(A), entry(B)]));
  assert.equal(list.load().entries.length, 2);
  fs.writeFileSync(file, '[{');
  const after = list.load();
  assert.equal(after.entries.length, 2, '坏文件不应该把名单变成空');
  assert.match(after.error, /仍在使用上次成功载入的 2 条/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('文件不存在是未配置，不是读取失败', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-'));
  const state = new Watchlist({
    file: path.join(dir, 'watchlist.json'),
  }).load();
  assert.equal(state.present, false);
  assert.equal(state.error, null);
  assert.deepEqual(state.entries, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('只改备注不算地址变化，不必重新读链', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-'));
  const file = path.join(dir, 'watchlist.json');
  const list = new Watchlist({ file });
  const changes = [];
  list.onChange = (addressesChanged) => changes.push(addressesChanged);
  fs.writeFileSync(file, JSON.stringify([entry(A, { name: '旧名字' })]));
  list.load();
  fs.writeFileSync(file, JSON.stringify([entry(A, { name: '新名字' })]));
  list.reload();
  assert.deepEqual(changes, [false]);
  assert.equal(list.state.entries[0].note, '新名字');
  fs.writeFileSync(file, JSON.stringify([entry(A), entry(B)]));
  list.reload();
  assert.deepEqual(changes, [false, true]);
  fs.rmSync(dir, { recursive: true, force: true });
});
