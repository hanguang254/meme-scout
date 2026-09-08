import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TapeSocket,
  OPEN_TIMEOUT,
  PING_INTERVAL,
  RECONNECT_MIN,
  RECONNECT_SPREAD,
} from '../scanner/tape-socket.mjs';

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  accept() {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function setup({ failOpen = false } = {}) {
  const sockets = [];
  const fills = [];
  const hellos = [];
  const statuses = [];
  const socket = new TapeSocket({
    open: () => {
      if (failOpen) throw new Error('blocked');
      const ws = new FakeSocket();
      sockets.push(ws);
      return ws;
    },
    onFills: (rows) => fills.push(rows),
    onHello: (data) => hellos.push(data),
    onStatus: (s) => statuses.push(s),
    random: () => 0.5,
  });
  return { socket, sockets, fills, hellos, statuses };
}

test('an accepted socket reports live, pings on the open socket and forwards fills', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { socket, sockets, fills, hellos } = setup();
  socket.start();
  assert.equal(socket.status, 'connecting');
  sockets[0].accept();
  assert.equal(socket.status, 'live');
  assert.equal(socket.degraded, false);

  t.mock.timers.tick(PING_INTERVAL);
  assert.deepEqual(sockets[0].sent, ['p']);

  sockets[0].deliver({ type: 'hello', data: { wallets: 147, lag_seconds: 0.1 } });
  sockets[0].deliver({ type: 'fills', data: [{ id: 1 }] });
  assert.equal(hellos[0].wallets, 147);
  assert.deepEqual(fills, [[{ id: 1 }]]);
  socket.stop();
});

test('a socket that never opens degrades to polling without waiting for a close', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { socket } = setup();
  socket.start();
  assert.equal(socket.degraded, false);
  t.mock.timers.tick(OPEN_TIMEOUT);
  assert.equal(socket.degraded, true, '未在超时内建立连接应立即退回轮询');
  socket.stop();
});

test('a first drop reconnects without degrading; a second drop falls back to polling', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { socket, sockets } = setup();
  socket.start();
  sockets[0].accept();
  sockets[0].drop();
  assert.equal(socket.status, 'down');
  assert.equal(socket.degraded, false, '一次断开不应立刻判定通道不可用');

  t.mock.timers.tick(RECONNECT_MIN + RECONNECT_SPREAD);
  assert.equal(sockets.length, 2, '断开后应按抖动延迟重连');
  sockets[1].accept();
  sockets[1].drop();
  t.mock.timers.tick(RECONNECT_MIN + RECONNECT_SPREAD);
  sockets[2].drop();
  assert.equal(socket.degraded, true, '连续失败应退回轮询');
  socket.stop();
});

test('a construction failure still schedules a retry instead of stalling', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { socket, statuses } = setup({ failOpen: true });
  socket.start();
  assert.equal(socket.degraded, true);
  assert.equal(socket.status, 'down');
  assert.ok(statuses.some((s) => s.degraded));
  socket.stop();
});

test('a malformed frame does not drop a working socket', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { socket, sockets, fills } = setup();
  socket.start();
  sockets[0].accept();
  sockets[0].onmessage({ data: '{not json' });
  sockets[0].deliver({ type: 'fills', data: 'not-an-array' });
  assert.equal(socket.status, 'live');
  assert.deepEqual(fills, [], '非数组载荷不应当作成交');
  sockets[0].deliver({ type: 'fills', data: [{ id: 7 }] });
  assert.deepEqual(fills, [[{ id: 7 }]]);
  socket.stop();
});

test('a superseded socket cannot schedule reconnects after stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { socket, sockets } = setup();
  socket.start();
  sockets[0].accept();
  socket.stop();
  const opened = sockets.length;
  sockets[0].drop();
  t.mock.timers.tick(RECONNECT_MIN + RECONNECT_SPREAD);
  assert.equal(sockets.length, opened, '停止后不应再建立连接');
  assert.equal(socket.status, 'idle');
});
