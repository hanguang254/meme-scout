import { CHAINS, selectCandidates, evaluateRisk, number } from './risk.mjs';
import {
  mergeTape,
  normalizeTape,
  eligibleBuy,
  tapeReason,
  TAPE_INTERVAL,
  TAPE_RELABEL_INTERVAL,
  LIVE_CANDIDATE_TTL,
} from './tape.mjs';
// Subscriber pushes are coalesced: a burst of fills should reach the page at
// once rather than re-serialising the whole state per row.
const NOTIFY_INTERVAL = 200;
const withoutData = ({ data: _data, ...meta }) => meta;
const emptyTape = () => ({
  events: [],
  source: null,
  quoteSources: [],
  updatedAt: null,
  nextPoll: null,
  busy: false,
  quoteBusy: false,
  stale: true,
  error: null,
  gap: false,
  intervalSeconds: TAPE_INTERVAL / 1000,
  transport: 'polling',
  socketStatus: 'idle',
  polledAt: null,
  lastFillAt: null,
  stream: null,
});
export class Monitor {
  constructor({
    discover,
    collect,
    fetchTape,
    resolveTape,
    openTapeSocket = null,
    autoSchedule = true,
    clock = Date.now,
  }) {
    this.discover = discover;
    this.collect = collect;
    this.autoSchedule = autoSchedule;
    this.clock = clock;
    this.fetchTape = fetchTape;
    this.resolveTape = resolveTape;
    this.openTapeSocket = openTapeSocket;
    this.socket = null;
    this.listeners = new Set();
    this.notifyTimer = null;
    this.notifiedAt = 0;
    this.baseCandidates = [];
    this.quoteCache = new Map();
    this.quoteAttempts = new Map();
    this.liveIds = new Set();
    this.scanAttempts = new Map();
    this.liveStarts = 0;
    this.tapePromise = null;
    this.resolvePromise = null;
    this.tapeTimer = null;
    this.state = {
      enabled: true,
      config: {
        chain: 'robinhood',
        minCap: 10000,
        maxCap: 5000000,
        minLiquidity: 5000,
      },
      candidates: [],
      reports: {},
      sources: [],
      updatedAt: null,
      nextRefresh: null,
      busy: false,
      scanning: null,
      error: null,
      unknownCap: 0,
      total: 0,
      generation: 0,
      discoveryStale: false,
      tape: emptyTape(),
    };
    this.refreshPromise = null;
    this.scanPromise = null;
    this.timer = null;
  }
  configure(c) {
    if (
      !CHAINS[c.chain] ||
      [c.minCap, c.maxCap, c.minLiquidity].some(
        (v) => number(v) === null || v < 0,
      ) ||
      c.minCap >= c.maxCap ||
      c.maxCap > 1e12
    )
      throw new Error('市值或流动性范围无效');
    this.state.config = {
      chain: c.chain,
      minCap: Number(c.minCap),
      maxCap: Number(c.maxCap),
      minLiquidity: Number(c.minLiquidity),
    };
    this.state.generation++;
    this.state.candidates = [];
    this.state.reports = {};
    this.state.updatedAt = null;
    this.baseCandidates = [];
    this.quoteCache.clear();
    this.quoteAttempts.clear();
    this.liveIds.clear();
    this.scanAttempts.clear();
    this.state.tape = emptyTape();
    clearTimeout(this.tapeTimer);
    // The socket is bound to one chain's fills; a chain switch must drop it.
    this.stopTapeStream();
    if (this.state.enabled) this.startTapeStream();
    this.push();
  }
  pause() {
    this.state.enabled = false;
    this.state.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.tapeTimer);
    this.stopTapeStream();
    this.state.nextRefresh = null;
    this.state.tape.nextPoll = null;
    this.push();
  }
  resume() {
    this.state.enabled = true;
    this.startTapeStream();
    if (this.refreshPromise)
      void this.refreshPromise.then(() => this.refresh());
    else void this.refresh();
    if (this.tapePromise) void this.tapePromise.then(() => this.pollTape());
    else void this.pollTape();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  push() {
    if (!this.listeners.size || this.notifyTimer) return;
    const wait = Math.max(
      0,
      NOTIFY_INTERVAL - (this.clock() - this.notifiedAt),
    );
    // Leading edge: the first change of a burst goes out immediately, so a
    // single fill is not held back by the coalescing window.
    if (wait === 0) return this.flush();
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.flush();
    }, wait);
    this.notifyTimer?.unref?.();
  }
  flush() {
    this.notifiedAt = this.clock();
    if (!this.listeners.size) return;
    const payload = this.summary();
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        // One stalled subscriber must not stop the others.
      }
    }
  }
  startTapeStream() {
    if (
      !this.openTapeSocket ||
      this.socket ||
      !this.state.enabled ||
      this.state.config.chain !== 'robinhood'
    )
      return;
    const generation = this.state.generation;
    const current = () =>
      this.state.enabled && generation === this.state.generation;
    this.socket = this.openTapeSocket({
      onFills: (rows) => {
        if (current()) this.ingestFills(rows);
      },
      onHello: (data) => {
        if (!current()) return;
        // Reported by the source at connect time, not a live measurement.
        this.state.tape.stream = {
          wallets: number(data.wallets),
          trades: number(data.trades),
          lagSeconds: number(data.lag_seconds),
          indexerAge: number(data.indexer_age),
          lastBlock: number(data.last_block),
          viewers: number(data.viewers),
          medianLatency: number(data.latency?.median),
          observedAt: new Date(this.clock()).toISOString(),
        };
        this.push();
      },
      onStatus: (status) => {
        if (!current()) return;
        const tape = this.state.tape;
        const transport = status.status === 'live' ? 'socket' : 'polling';
        const switched = tape.transport !== transport;
        const changed = switched || tape.socketStatus !== status.status;
        tape.socketStatus = status.status;
        tape.transport = transport;
        tape.intervalSeconds = this.tapeInterval() / 1000;
        if (status.status !== 'live') tape.stream = null;
        // Only an actual change of transport re-reads immediately. A flapping
        // socket cycles connecting/down many times while still polling, and
        // each of those must not buy another read below the reader's floor.
        if (switched && this.autoSchedule) {
          clearTimeout(this.tapeTimer);
          this.tapeTimer = null;
          tape.nextPoll = null;
          void this.pollTape();
        }
        if (changed) this.push();
      },
    });
    this.socket.start();
  }
  stopTapeStream() {
    const socket = this.socket;
    this.socket = null;
    socket?.stop();
    const tape = this.state.tape;
    tape.socketStatus = 'idle';
    tape.transport = 'polling';
    tape.stream = null;
    tape.intervalSeconds = TAPE_INTERVAL / 1000;
  }
  tapeInterval() {
    // A live socket already delivers new fills; the reader then runs only often
    // enough to pick up upstream's later re-judgement of rows already on screen.
    return this.state.tape.socketStatus === 'live'
      ? TAPE_RELABEL_INTERVAL
      : TAPE_INTERVAL;
  }
  ingestFills(rows) {
    const tape = this.state.tape;
    // The socket carries every fill the source indexes. The reader asks for
    // stocks=false, so drop them here too and keep one definition of the window.
    const events = normalizeTape(rows).filter((t) => t.invalid || !t.isStock);
    if (!events.length) return;
    const now = this.clock();
    tape.events = mergeTape(tape.events, events);
    tape.updatedAt = new Date(now).toISOString();
    tape.lastFillAt = new Date(now).toISOString();
    tape.stale = false;
    tape.error = null;
    this.reconcile();
    void this.resolveLive();
    void this.scan();
    this.push();
  }
  liveTrades() {
    const latest = new Map();
    for (const t of this.state.tape.events) {
      const age = this.liveIds.has(t.candidateId) ? LIVE_CANDIDATE_TTL : 120000;
      if (
        eligibleBuy(t, this.clock(), age) &&
        (!latest.has(t.candidateId) || t.ts > latest.get(t.candidateId).ts)
      )
        latest.set(t.candidateId, t);
    }
    return latest;
  }
  reconcile() {
    const s = this.state,
      now = this.clock(),
      latest = this.liveTrades();
    for (const id of this.liveIds) if (!latest.has(id)) this.liveIds.delete(id);
    const live = [];
    for (const [id, trade] of latest) {
      const quote = this.quoteCache.get(id);
      // Don't use an old market cap to admit a low-cap token during a source outage.
      if (!quote || now - quote.at > 90000) continue;
      const candidate = { ...quote.candidate, lastTrade: trade };
      if (!selectCandidates([candidate], s.config).selected.length) continue;
      this.liveIds.add(id);
      const base = this.baseCandidates.find((c) => c.id === id);
      live.push({
        ...base,
        ...candidate,
        trench: base?.trench,
        trackedBuyers: base?.trackedBuyers ?? null,
        trackedHolders: base?.trackedHolders ?? null,
        netFlow: base?.netFlow ?? null,
        source: base ? `${base.source} + LIVE TAPE` : candidate.source,
      });
    }
    live.sort((a, b) => b.lastTrade.ts - a.lastTrade.ts);
    const merged = new Map(this.baseCandidates.map((c) => [c.id, c]));
    for (const c of live) merged.set(c.id, c);
    const picked = selectCandidates([...merged.values()], s.config);
    const priority = live
        .filter((c) => eligibleBuy(c.lastTrade, now))
        .slice(0, 10),
      ids = new Set(priority.map((c) => c.id));
    s.candidates = [
      ...priority,
      ...picked.selected.filter((c) => !ids.has(c.id)),
    ].slice(0, 40);
    s.total = merged.size;
    s.unknownCap = picked.unknownCap;
    for (const [id, value] of this.quoteCache)
      if (now - value.at > LIVE_CANDIDATE_TTL) this.quoteCache.delete(id);
    for (const [id, at] of this.quoteAttempts)
      if (now - at > LIVE_CANDIDATE_TTL) this.quoteAttempts.delete(id);
    for (const [id, at] of this.scanAttempts)
      if (now - at > LIVE_CANDIDATE_TTL) this.scanAttempts.delete(id);
    // Keep recent reports across list churn, while bounding the private cache.
    for (const [id, r] of Object.entries(s.reports))
      if (
        now - Date.parse(r.checkedAt) > LIVE_CANDIDATE_TTL &&
        !s.candidates.some((c) => c.id === id)
      )
        delete s.reports[id];
  }
  async pollTape() {
    if (
      !this.fetchTape ||
      !this.state.enabled ||
      this.state.config.chain !== 'robinhood'
    )
      return;
    if (this.tapePromise) return this.tapePromise;
    clearTimeout(this.tapeTimer);
    const start = this.clock(),
      generation = this.state.generation,
      tape = this.state.tape;
    const current = () =>
      this.state.enabled && generation === this.state.generation;
    tape.busy = true;
    tape.nextPoll = null;
    this.tapePromise = (async () => {
      try {
        const r = await this.fetchTape(tape.events);
        if (!current()) return;
        tape.source = withoutData(r);
        if (r.status !== 'ok') throw new Error(r.error || '交易流暂不可用');
        tape.events = mergeTape(tape.events, r.data.events);
        tape.updatedAt = r.fetchedAt || new Date(this.clock()).toISOString();
        // Tracked apart from `updatedAt`, which a pushed fill also advances:
        // only a completed read proves the flag revisions were re-collected.
        tape.polledAt = tape.updatedAt;
        tape.gap ||= Boolean(r.data.gap);
        tape.stale = false;
        tape.error = null;
      } catch (e) {
        if (!current()) return;
        tape.stale = true;
        tape.error = String(e.message).slice(0, 200);
      } finally {
        tape.busy = false;
        if (current()) {
          this.reconcile();
          if (!tape.stale) void this.resolveLive();
          void this.scan();
          const interval = this.tapeInterval();
          tape.intervalSeconds = interval / 1000;
          if (this.autoSchedule) {
            const delay = Math.max(1000, interval - (this.clock() - start));
            tape.nextPoll = new Date(this.clock() + delay).toISOString();
            this.tapeTimer = setTimeout(() => void this.pollTape(), delay);
          }
          this.push();
        }
      }
    })();
    try {
      await this.tapePromise;
    } finally {
      this.tapePromise = null;
    }
  }
  async resolveLive() {
    if (this.resolvePromise || !this.resolveTape) return this.resolvePromise;
    const s = this.state,
      generation = s.generation,
      tape = s.tape;
    const current = () => s.enabled && generation === s.generation;
    const trades = [...this.liveTrades().values()]
      .filter(
        (t) =>
          this.clock() - (this.quoteAttempts.get(t.candidateId) ?? -Infinity) >=
          60000,
      )
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 30);
    if (!trades.length) return;
    for (const t of trades) this.quoteAttempts.set(t.candidateId, this.clock());
    tape.quoteBusy = true;
    this.resolvePromise = (async () => {
      try {
        const r = await this.resolveTape(trades);
        if (!current()) return;
        tape.quoteSources = r.sources.map(withoutData);
        // Resolve only the exact requested IDs; recheck event flags and age below.
        const ids = new Set(trades.map((t) => t.candidateId));
        for (const c of r.candidates)
          if (ids.has(c.id))
            this.quoteCache.set(c.id, { candidate: c, at: this.clock() });
        this.reconcile();
        void this.scan();
        this.push();
      } catch (e) {
        if (current())
          tape.quoteSources = [
            {
              name: 'LIVE TAPE 市值',
              url: 'https://dexscreener.com',
              status: 'error',
              fetchedAt: new Date(this.clock()).toISOString(),
              error: String(e.message).slice(0, 180),
            },
          ];
      } finally {
        tape.quoteBusy = false;
      }
    })();
    try {
      await this.resolvePromise;
    } finally {
      this.resolvePromise = null;
    }
  }
  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    const start = this.clock();
    clearTimeout(this.timer);
    this.refreshPromise = (async () => {
      const s = this.state,
        generation = s.generation;
      s.busy = true;
      s.nextRefresh = null;
      s.error = null;
      try {
        const r = await this.discover(s.config.chain);
        if (generation !== s.generation || !s.enabled) return;
        s.sources = r.sources.map(withoutData);
        if (
          !r.sources.some(
            (x) =>
              ['Robinhood Trenches', 'Trenches Radar', 'GMGN 热门'].includes(
                x.name,
              ) && x.status === 'ok',
          )
        ) {
          s.discoveryStale = true;
          s.error =
            '发现来源暂不可用，保留上次成功候选与报告；它们可能已过期。';
          return;
        }
        this.baseCandidates = r.candidates;
        this.reconcile();
        s.updatedAt = new Date(this.clock()).toISOString();
        s.discoveryStale = false;
        void this.scan();
      } catch (e) {
        s.error = String(e.message).slice(0, 200);
        s.discoveryStale = true;
      } finally {
        s.busy = false;
        if (s.enabled && this.autoSchedule) {
          const delay = Math.max(1000, 60000 - (this.clock() - start));
          s.nextRefresh = new Date(this.clock() + delay).toISOString();
          this.timer = setTimeout(() => void this.refresh(), delay);
        }
        this.push();
      }
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }
  async scan() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      const s = this.state;
      while (s.enabled) {
        const waiting = s.candidates
          .filter(
            (c) =>
              (!s.reports[c.id] ||
                this.clock() - Date.parse(s.reports[c.id].checkedAt) >
                  180000) &&
              this.clock() - (this.scanAttempts.get(c.id) ?? -Infinity) >=
                60000,
          )
          .sort(
            (a, b) =>
              Date.parse(s.reports[a.id]?.checkedAt || '1970-01-01') -
              Date.parse(s.reports[b.id]?.checkedAt || '1970-01-01'),
          );
        const live = waiting.find(
          (c) => c.lastTrade && this.clock() - c.lastTrade.ts * 1000 <= 120000,
        );
        const ordinary = waiting.find(
          (c) => !c.lastTrade || this.clock() - c.lastTrade.ts * 1000 > 120000,
        );
        const candidate =
          this.liveStarts < 2 ? live || waiting[0] : ordinary || waiting[0];
        if (!candidate) break;
        this.liveStarts = candidate === live ? this.liveStarts + 1 : 0;
        this.scanAttempts.set(candidate.id, this.clock());
        const generation = s.generation;
        s.scanning = candidate.id;
        try {
          const raw = await this.collect(
            candidate,
            () => s.enabled && generation === s.generation,
          );
          if (
            s.enabled &&
            generation === s.generation &&
            s.candidates.some((c) => c.id === candidate.id)
          )
            s.reports[candidate.id] = {
              ...evaluateRisk(candidate, raw.data, raw.sources),
              candidate,
              checkedAt: new Date(this.clock()).toISOString(),
              sources: raw.sources.map(withoutData),
              raw: raw.data,
            };
          this.push();
        } catch (e) {
          if (s.enabled && generation === s.generation)
            s.error = `${candidate.symbol} 扫描未完成：${String(e.message).slice(0, 140)}`;
        } finally {
          s.scanning = null;
        }
        if (!this.autoSchedule) break;
        // At most ten complete token starts/minute; source cooldowns apply globally.
        if (s.enabled)
          await new Promise((resolve) => setTimeout(resolve, 6000));
      }
    })();
    try {
      await this.scanPromise;
    } finally {
      this.scanPromise = null;
    }
  }
  summary() {
    const now = this.clock(),
      s = this.state;
    const candidateIds = new Set(s.candidates.map((c) => c.id));
    const recent = s.tape.events.filter((t) => eligibleBuy(t, now));
    return {
      ...this.state,
      tape: {
        ...s.tape,
        recentBuys: recent.length,
        recentWallets: new Set(recent.map((t) => t.wallet)).size,
        // A live socket delivers each fill as it lands, so quiet minutes are
        // not a delay. Only the reader's own silence means fills may be missing.
        stale:
          s.tape.socketStatus === 'live'
            ? false
            : s.tape.stale ||
              !s.tape.updatedAt ||
              now - Date.parse(s.tape.updatedAt) > 20000,
        // The socket carries new fills only. Without a completed read, upstream's
        // later re-judgement of rows already on screen has not been collected.
        revisionStale:
          !s.tape.polledAt ||
          now - Date.parse(s.tape.polledAt) > TAPE_RELABEL_INTERVAL * 3,
        events: s.tape.events.map((t) => {
          let reason = tapeReason(t, now);
          if (!reason) {
            const quote = this.quoteCache.get(t.candidateId);
            reason =
              !quote || now - quote.at > 90000
                ? '等待市值核验'
                : number(quote.candidate.marketCap) === null
                  ? '市值未知，未入候选'
                  : number(quote.candidate.liquidity) === null
                    ? '流动性未知，未入候选'
                    : !selectCandidates([quote.candidate], s.config).selected
                          .length
                      ? '超出筛选范围'
                      : candidateIds.has(t.candidateId)
                        ? '已进入候选'
                        : '候选名额已满';
          }
          return { ...t, reason };
        }),
      },
      reports: Object.fromEntries(
        Object.entries(this.state.reports)
          .filter(([key]) => candidateIds.has(key))
          .map(([key, { raw: _raw, ...r }]) => [key, r]),
      ),
      connections: { gmgn: true, x: Boolean(process.env.X_BEARER_TOKEN) },
      freshForSeconds: 180,
    };
  }
}
