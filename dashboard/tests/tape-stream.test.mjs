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
