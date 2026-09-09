import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../scanner/monitor.mjs';
import { normalizeTape, TAPE_RELABEL_INTERVAL } from '../scanner/tape.mjs';

// Mirrors the monitor's push coalescing window.
const NOTIFY_INTERVAL = 200;

const initialNow = 1788658000000;
const fill = (over = {}) => ({
  id: 200,
  ts: initialNow / 1000 - 5,
  side: 'buy',
  token: `0x${'1'.repeat(40)}`,
  wallet: `0x${'2'.repeat(40)}`,
  tx: `0x${'a'.repeat(64)}`,
  symbol: 'PUSH',
  usd: 120,
  price: 0.0002,
  priced: 'cash_leg',
  flags: [],
  is_stock: 0,
  ...over,
});

function setup({ events = [] } = {}) {
  let now = initialNow;
  const handles = {};
  const m = new Monitor({
    autoSchedule: false,
    clock: () => now,
    discover: async () => ({
      candidates: [],
      sources: [{ name: 'GMGN 热门', status: 'ok' }],
    }),
    collect: async () => new Promise(() => {}),
    fetchTape: async () => ({
      status: 'ok',
      fetchedAt: new Date(now).toISOString(),
      data: { events: normalizeTape(events), gap: false },
    }),
    resolveTape: async (trades) => ({
      sources: [],
      candidates: trades.map((t) => ({
        id: t.candidateId,
        address: t.address,
        chain: 'robinhood',
        symbol: t.symbol,
        marketCap: 100000,
        liquidity: 20000,
        source: 'Trenches LIVE TAPE',
      })),
    }),
    openTapeSocket: (h) => {
      Object.assign(handles, h);
      return {
        start: () => h.onStatus({ status: 'live', degraded: false }),
        stop: () => {},
      };
    },
  });
  return { m, handles, advance: (ms) => (now += ms) };
}

test('a pushed fill lands without waiting for the next read', async () => {
  const { m, handles } = setup();
  m.startTapeStream();
  assert.equal(m.state.tape.transport, 'socket');
  handles.onFills([fill()]);
  await m.resolvePromise;
  assert.equal(m.state.tape.events.length, 1);
  assert.equal(m.state.tape.events[0].symbol, 'PUSH');
  assert.ok(m.state.tape.lastFillAt, '推送成交应记录最近成交时间');
});

test('pushed stock fills are dropped, matching the reader stocks=false window', () => {
  const { m, handles } = setup();
  m.startTapeStream();
  handles.onFills([fill({ id: 201, is_stock: true, symbol: 'STOCK' })]);
  assert.equal(m.state.tape.events.length, 0, '股票代币不应进入交易流');
  handles.onFills([fill({ id: 202 })]);
  assert.equal(m.state.tape.events.length, 1);
});

test('a live socket does not read the tape as delayed during quiet minutes', () => {
  const { m, handles, advance } = setup();
  m.startTapeStream();
  handles.onFills([fill()]);
  advance(120000);
  assert.equal(
    m.summary().tape.stale,
    false,
    '推送在线时没有成交不等于数据延迟',
  );
});

test('the reader still runs on the slow cadence, and its silence is reported apart from staleness', async () => {
  const { m, handles, advance } = setup();
  m.startTapeStream();
  handles.onFills([fill()]);
  assert.equal(
    m.tapeInterval(),
    TAPE_RELABEL_INTERVAL,
    '推送在线时读取应降到修订复核节奏',
  );
  assert.equal(
    m.summary().tape.revisionStale,
    true,
    '尚未完成读取时应标明修订未取得',
  );
  await m.pollTape();
  assert.equal(m.summary().tape.revisionStale, false);
  advance(TAPE_RELABEL_INTERVAL * 4);
  assert.equal(
    m.summary().tape.revisionStale,
    true,
    '长时间没有完成读取应重新标记修订未取得',
  );
  assert.equal(m.summary().tape.stale, false, '修订滞后不等于漏掉新成交');
});

test('losing the socket restores the fast reader cadence', () => {
  const { m, handles } = setup();
  m.startTapeStream();
  assert.equal(m.tapeInterval(), TAPE_RELABEL_INTERVAL);
  handles.onStatus({ status: 'down', degraded: true });
  assert.equal(m.state.tape.transport, 'polling');
  assert.equal(m.tapeInterval(), 5000, '断开后应立即回到快速读取');
  assert.equal(m.state.tape.stream, null, '断开后不应继续展示来源自报状态');
});

test('subscribers receive pushes and a failing one does not stop the rest', () => {
  const { m, handles, advance } = setup();
  const seen = [];
  m.subscribe(() => {
    throw new Error('boom');
  });
  const off = m.subscribe((s) => seen.push(s));
  m.startTapeStream();
  advance(NOTIFY_INTERVAL);
  handles.onFills([fill()]);
  assert.ok(seen.length >= 1, '安静期后的首笔成交应立即推送');
  assert.equal(seen.at(-1).tape.events.length, 1);
  off();
  advance(NOTIFY_INTERVAL);
  const before = seen.length;
  handles.onFills([fill({ id: 203 })]);
  assert.equal(seen.length, before, '退订后不应继续收到推送');
});

test('a burst inside the coalescing window is delivered once, not dropped', async () => {
  const { m, handles, advance } = setup();
  const seen = [];
  m.subscribe((s) => seen.push(s));
  m.startTapeStream();
  advance(NOTIFY_INTERVAL);
  handles.onFills([fill({ id: 210 })]);
  const afterFirst = seen.length;
  handles.onFills([fill({ id: 211 })]);
  handles.onFills([fill({ id: 212 })]);
  assert.equal(seen.length, afterFirst, '窗口内的连发应合并而非逐条推送');
  await new Promise((r) => setTimeout(r, NOTIFY_INTERVAL + 50));
  assert.equal(seen.length, afterFirst + 1, '合并后的推送仍必须送达');
  assert.equal(
    seen.at(-1).tape.events.length,
    3,
    '合并推送应包含窗口内全部成交',
  );
});

test('fills arriving after a chain switch cannot write into the new generation', () => {
  const { m, handles } = setup();
  m.startTapeStream();
  m.configure({ chain: 'bsc', minCap: 1000, maxCap: 100000, minLiquidity: 100 });
  handles.onFills([fill({ id: 204 })]);
  assert.equal(m.state.tape.events.length, 0, '切换链后的旧推送不应写入');
});

const flagsOf = (m, id) =>
  m.state.tape.events.find((t) => t.eventId === id)?.flags;

test('a pushed label revision reaches the row without waiting for the next read', () => {
  const { m, handles } = setup();
  m.startTapeStream();
  handles.onFills([fill({ id: 300 })]);
  assert.deepEqual(flagsOf(m, 300), []);
  handles.onLabels({ 300: ['not a real buy (transferred)'] });
  assert.deepEqual(
    flagsOf(m, 300),
    ['not a real buy (transferred)'],
    '推送的改判应立即写入已展示的行',
  );
  assert.equal(
    m.state.tape.polledAt,
    null,
    '推送的改判不能冒充一次完成的全量重读',
  );
});

test('a label frame never clears flags on rows outside the span it covers', () => {
  const { m, handles } = setup();
  m.startTapeStream();
  handles.onFills([
    fill({ id: 100, token: `0x${'a'.repeat(40)}` }),
    fill({ id: 300, token: `0x${'b'.repeat(40)}` }),
    fill({ id: 500, token: `0x${'c'.repeat(40)}` }),
  ]);
  handles.onLabels({ 100: ['pool 1m old'], 500: ['pool 2m old'] });
  assert.deepEqual(flagsOf(m, 100), ['pool 1m old']);
  assert.deepEqual(flagsOf(m, 500), ['pool 2m old']);

  // Upstream only publishes the ids it currently flags, and its window is
  // shorter than the tape we keep. Absence outside that span says nothing.
  handles.onLabels({ 300: ['not a real buy (planted)'] });
  assert.deepEqual(
    flagsOf(m, 300),
    ['not a real buy (planted)'],
    '区间内的行应被改判',
  );
  assert.deepEqual(flagsOf(m, 100), ['pool 1m old'], '区间外的标记不应被清空');
  assert.deepEqual(flagsOf(m, 500), ['pool 2m old'], '区间外的标记不应被清空');
});

test('a revoked buy loses its candidate seat as soon as the label arrives', async () => {
  const { m, handles } = setup();
  m.startTapeStream();
  handles.onFills([fill({ id: 301 })]);
  await m.resolvePromise;
  const id = m.state.tape.events[0].candidateId;
  assert.ok(
    m.state.candidates.some((c) => c.id === id),
    '无标记的定价买入应先进入候选',
  );
  handles.onLabels({ 301: ['not a real buy (transferred)'] });
  assert.equal(
    m.state.candidates.some((c) => c.id === id),
    false,
    '上游撤回后该买入不应继续占据候选席位',
  );
});

test('clearing a flag lets the buy compete again', async () => {
  const { m, handles } = setup();
  m.startTapeStream();
  handles.onFills([fill({ id: 302, flags: ['pool 1m old'] })]);
  await m.resolvePromise;
  assert.deepEqual(m.state.candidates, [], '带标记的买入不应触发候选');

  handles.onLabels({ 301: [], 302: [], 303: [] });
  assert.deepEqual(flagsOf(m, 302), []);
  await m.resolvePromise;
  assert.equal(
    m.state.candidates.length,
    1,
    '标记被撤销后应重新参与候选准入',
  );
});

test('a label frame that changes nothing does not push, and unusable entries are skipped', () => {
  const { m, handles, advance } = setup();
  const seen = [];
  m.startTapeStream();
  handles.onFills([fill({ id: 304, flags: ['pool 1m old'] })]);
  m.subscribe((s) => seen.push(s));
  advance(NOTIFY_INTERVAL);

  handles.onLabels({ 304: ['pool 1m old'] });
  assert.equal(seen.length, 0, '无变化的帧不应触发推送');

  handles.onLabels({});
  handles.onLabels({ notanid: ['x'], 304: 'not-an-array' });
  assert.deepEqual(
    flagsOf(m, 304),
    ['pool 1m old'],
    '无法解析的条目应让该行保留原有标记',
  );
  assert.equal(seen.length, 0, '空帧和畸形条目不应改写任何行');
});

test('labels arriving after a chain switch cannot write into the new generation', () => {
  const { m, handles } = setup();
  m.startTapeStream();
  handles.onFills([fill({ id: 305 })]);
  m.configure({
    chain: 'bsc',
    minCap: 1000,
    maxCap: 100000,
    minLiquidity: 100,
  });
  handles.onLabels({ 305: ['not a real buy (planted)'] });
  assert.deepEqual(m.state.tape.events, [], '切换链后的旧改判不应写入');
});

test('a flapping socket does not buy extra reads below the reader floor', () => {
  const { m, handles } = setup();
  let polls = 0;
  m.pollTape = async () => {
    polls++;
  };
  m.autoSchedule = true;
  m.startTapeStream();
  const afterLive = polls;
  // connecting/down cycles while still polling must not each force a read.
  handles.onStatus({ status: 'down', degraded: true });
  const afterFallback = polls;
  assert.equal(afterFallback, afterLive + 1, '切回轮询应立即读取一次');
  for (let i = 0; i < 5; i++) {
    handles.onStatus({ status: 'connecting', degraded: true });
    handles.onStatus({ status: 'down', degraded: true });
  }
  assert.equal(polls, afterFallback, '抖动期的状态变化不应反复强制读取');
  assert.equal(m.state.tape.socketStatus, 'down', '状态本身仍应如实反映');
});
