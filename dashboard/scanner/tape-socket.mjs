// rhtrenches pushes fills over a socket instead of waiting for the next poll.
// Its own page falls back to a 5s REST read when that socket will not open, and
// so does this monitor: a socket that never opens, or that keeps dying, must
// never leave the tape frozen while it retries. The same socket also carries
// `labels` — upstream's later re-judgement of rows it already sent. The
// periodic full read still stays, because a labels frame only speaks for the
// span of ids upstream currently flags, not for the whole tape we hold.
export const TAPE_WS_URL = 'wss://rhtrenches.com/ws';
export const PING_INTERVAL = 20000;
export const OPEN_TIMEOUT = 8000;
export const RECONNECT_MIN = 2000;
export const RECONNECT_SPREAD = 4000;
const OPEN = 1;

export class TapeSocket {
  constructor({
    url = TAPE_WS_URL,
    open = (target) => new WebSocket(target),
    onFills = () => {},
    onLabels = () => {},
    onHello = () => {},
    onStatus = () => {},
    clock = Date.now,
    random = Math.random,
  } = {}) {
    this.url = url;
    this.open = open;
    this.onFills = onFills;
    this.onLabels = onLabels;
    this.onHello = onHello;
    this.onStatus = onStatus;
    this.clock = clock;
    this.random = random;
    this.status = 'idle';
    // `degraded` is not derived from `status`: a socket may be briefly down
    // between two healthy connections without the tape needing fast polling.
    this.degraded = false;
    this.openedOnce = false;
    this.failures = 0;
    this.receivedAt = null;
    this.stopped = true;
    this.ws = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.openTimer = null;
  }
  snapshot() {
    return {
      status: this.status,
      degraded: this.degraded,
      receivedAt: this.receivedAt,
      failures: this.failures,
    };
  }
  announce() {
    this.onStatus(this.snapshot());
  }
  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.announce();
  }
  degrade() {
    if (this.degraded) return;
    this.degraded = true;
    this.announce();
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // Already closing; nothing left to release.
    }
    this.status = 'idle';
    this.degraded = false;
    this.announce();
  }
  clearTimers() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.openTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.openTimer = null;
  }
  connect() {
    if (this.stopped) return;
    this.setStatus('connecting');
    let ws;
    try {
      ws = this.open(this.url);
    } catch {
      this.failures++;
      this.degrade();
      this.setStatus('down');
      this.retry();
      return;
    }
    this.ws = ws;
    // A socket still handshaking after eight seconds is treated as unusable,
    // so the tape starts polling rather than waiting on it.
    this.openTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== OPEN) this.degrade();
    }, OPEN_TIMEOUT);
    this.openTimer?.unref?.();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      clearTimeout(this.openTimer);
      this.openTimer = null;
      this.openedOnce = true;
      this.failures = 0;
      this.degraded = false;
      this.receivedAt = this.clock();
      this.setStatus('live');
      this.announce();
      // Only ping an open socket: a send on a closing one is logged by the
      // runtime even when caught, and that reads as breakage.
      this.pingTimer = setInterval(() => {
        if (this.ws !== ws) return;
        if (ws.readyState === OPEN) {
          try {
            ws.send('p');
          } catch {
            // The close handler owns recovery.
          }
        }
      }, PING_INTERVAL);
      this.pingTimer?.unref?.();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.receivedAt = this.clock();
      let message;
      try {
        message =
          typeof event.data === 'string' ? JSON.parse(event.data) : null;
      } catch {
        // One malformed frame is not a reason to drop a working socket.
        return;
      }
      if (message?.type === 'fills' && Array.isArray(message.data))
        this.onFills(message.data);
      else if (
        message?.type === 'labels' &&
        message.data &&
        typeof message.data === 'object' &&
        !Array.isArray(message.data)
      )
        this.onLabels(message.data);
      else if (message?.type === 'hello' && message.data)
        this.onHello(message.data);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // The close handler owns recovery.
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.openTimer);
      this.pingTimer = null;
      this.openTimer = null;
      this.failures++;
      if (!this.openedOnce || this.failures >= 2) this.degrade();
      this.setStatus('down');
      this.retry();
    };
  }
  retry() {
    if (this.stopped || this.reconnectTimer) return;
    // Jittered: every viewer reconnecting in the same instant after an upstream
    // restart would be a self-inflicted flood.
    const delay = RECONNECT_MIN + this.random() * RECONNECT_SPREAD;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer?.unref?.();
  }
}

export const openTapeSocket = (handlers) => new TapeSocket(handlers);
