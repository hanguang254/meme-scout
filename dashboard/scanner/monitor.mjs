import {
  CHAINS,
  selectCandidates,
  orderCandidates,
  capByChain,
  evaluateRisk,
  number,
  SORTS,
} from './risk.mjs';
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
// Pacing belongs to the source limiter, which meters real call starts and so
// holds one requests-per-minute figure whatever the latency does. A sleep here
// on top of it would just make the queue slower than the pace we chose. The
// floor exists for the other case: a scan that reached the rate-limited source
// zero times must not let the loop spin.
const MIN_SCAN_GAP = 1000;
// Discovery runs once a minute because it is several sources deep and one of
// them is rate limited. The market numbers it carries do not need that budget:
// DexScreener takes no key, prices every chain watched here, and answers a whole
// page of candidates in two requests. Quoting them on their own short timer
// keeps the displayed price fresh without pulling the rest of discovery along.
// 6 seconds, not less. Measured: two unrelated solana pairs trading 300+ and
// 550+ times per 5 minutes changed their numbers at the same instants, 31.8s
// and 32.1s apart — DexScreener republishes on a ~32 second server-side cycle,
// so a faster poll returns the identical bytes it just returned. What the
// interval does control is this machine's own share of the delay: at 6s a newly
// published price is on screen within 6 seconds of being published instead of
// 15. Two batches per tick for a full page is 20 requests a minute against a
// ~300/min allowance.
const MARKET_INTERVAL = 6000;
// The tracked-address sweep is pure RPC and spends none of the GMGN budget, so
// its cadence is set by what the answer is worth rather than by a limiter. A
// balance changes when someone trades, which for these coins is far slower than
// the price ticks — and the whole sweep is a handful of requests, so 20 seconds
// keeps it well under one request per second even with a full list.
const TRACKED_INTERVAL = 20000;
// A first scan defers the checks that are not worth making the whole list wait
// for, so its report is short a category on purpose. Waiting out the full
// freshness window before filling those in would leave the loop idle with known
// gaps on the board; they queue behind the coins that have nothing at all.
const incomplete = (report) =>
  (report?.sources || []).some((s) => s.status === 'deferred');
// The listings that decide whether a chain's discovery actually ran. A chain
// keeps its previous candidates unless one of its own primary sources answered,
// so the set has to cover every discovery lane — the GeckoTerminal pair is how
// the chains DexScreener does not index are found at all, and leaving them out
// would mark those chains permanently stale.
const DISCOVERY_PRIMARY = new Set([
  'Robinhood Trenches',
  'Trenches Radar',
  'GMGN 热门',
  'GeckoTerminal 热门池',
  'GeckoTerminal 成交榜',
]);
const withoutData = ({ data: _data, ...meta }) => meta;
// The market cap the first report was written at, carried forward unchanged
// through every rescan. Without it the only anchor on the page is the latest
// report, which is re-taken every ~101 seconds, so the drift beside it can
// never show more than a few minutes of movement.
// Copied out as plain numbers rather than kept as a reference to the candidate:
// the quote loop replaces candidate objects on its own timer, and an anchor
// that tracked one would quietly re-anchor itself.
// The cap is always present here: selectCandidates drops rows without one, so a
// coin cannot reach a report without a market cap to anchor to.
// It is the first *report*, not the first sighting — discovery sees a coin
// before the scanner reaches it — which is why the panel shows the anchor's
// time rather than calling it the moment the coin was found.
const firstMark = (prev, candidate, at) =>
  prev?.first ?? { marketCap: candidate.marketCap, at };
const emptyMarket = () => ({
  observedAt: null,
  nextTick: null,
  busy: false,
  quoted: 0,
  supported: true,
  error: null,
  sources: [],
  intervalSeconds: MARKET_INTERVAL / 1000,
});
const emptyTracked = () => ({
  supported: true,
  block: null,
  rpc: null,
  observedAt: null,
  nextTick: null,
  busy: false,
  // How many addresses the last sweep actually covered. Compared against the
  // list's length so a freshly added address cannot be mistaken for one that was
  // checked and found holding nothing.
  swept: 0,
  requests: 0,
  error: null,
  byCandidate: {},
  // One entry per selected chain. The sweep reads each chain separately and
  // they fail separately, so a single block number and a single error message
  // would have to speak for all of them — and would be wrong about most.
  chains: [],
  intervalSeconds: TRACKED_INTERVAL / 1000,
});
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
    quoteMarket = null,
    freshenMarket = null,
    anchorTtl = () => 0,
    openTapeSocket = null,
    readTracked = null,
    watchlist = null,
    autoSchedule = true,
    clock = Date.now,
    gmgnCooldown = () => 0,
    gmgnPace = () => null,
  }) {
    this.discover = discover;
    this.collect = collect;
    this.quoteMarket = quoteMarket;
    this.freshenMarket = freshenMarket;
    this.anchorTtl = anchorTtl;
    this.readTracked = readTracked;
    this.watchlist = watchlist;
    this.gmgnCooldown = gmgnCooldown;
    this.gmgnPace = gmgnPace;
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
    // Discovery is per chain and fails per chain. Holding the last good result
    // for each one separately is what lets a chain whose sources are down keep
    // showing what it had while the others refresh normally.
    this.baseByChain = new Map();
    this.quoteCache = new Map();
    this.quoteAttempts = new Map();
    this.liveIds = new Set();
    this.scanAttempts = new Map();
    this.liveStarts = 0;
    this.tapePromise = null;
    this.resolvePromise = null;
    this.tapeTimer = null;
    this.marketPromise = null;
    this.marketTimer = null;
    this.trackedPromise = null;
    this.trackedTimer = null;
    // ERC-20 decimals cannot change, so one read per token lasts as long as the
    // token is on the list.
    this.trackedDecimals = new Map();
    // The unscaled quote each chain's source last published, kept so the
    // on-chain price can be applied to it as a ratio. Applying that ratio to an
    // already-scaled price would compound the two and drift further every tick,
    // so what is stored here is deliberately the source's own number.
    this.marketAnchors = new Map();
    // Pool token order and token decimals, per chain. Neither can change, but
    // both are chain-scoped facts: the same address is a different contract on
    // a different chain, so one shared map would answer confidently and wrongly.
    this.poolMeta = new Map();
    // Stamps every snapshot handed to a page. See summary() for why.
    this.rev = 0;
    this.boot = Math.random().toString(36).slice(2, 10);
    this.state = {
      enabled: true,
      config: {
        chains: ['robinhood'],
        minCap: 10000,
        maxCap: 5000000,
        minLiquidity: 5000,
      },
      // Display order only. Kept outside config because config changes discard
      // every cached report, and re-ordering a list must not cost a rescan.
      sort: 'heat',
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
      market: emptyMarket(),
      tape: emptyTape(),
      tracked: emptyTracked(),
    };
    this.refreshPromise = null;
    this.scanPromise = null;
    this.timer = null;
  }
  configure(c) {
    // A page that has not reloaded since this became multi-select still sends
    // one chain as a string. One selected chain is exactly what that means.
    const chains = [
      ...new Set(Array.isArray(c.chains) ? c.chains : c.chain ? [c.chain] : []),
    ];
    if (
      !chains.length ||
      chains.some((chain) => !CHAINS[chain]) ||
      [c.minCap, c.maxCap, c.minLiquidity].some(
        (v) => number(v) === null || v < 0,
      ) ||
      c.minCap >= c.maxCap ||
      c.maxCap > 1e12
    )
      throw new Error('所选链或市值、流动性范围无效');
    this.state.config = {
      chains,
      minCap: Number(c.minCap),
      maxCap: Number(c.maxCap),
      minLiquidity: Number(c.minLiquidity),
    };
    this.state.generation++;
    this.state.candidates = [];
    this.state.reports = {};
    this.state.updatedAt = null;
    this.baseCandidates = [];
    this.baseByChain.clear();
    this.quoteCache.clear();
    this.quoteAttempts.clear();
    this.liveIds.clear();
    this.scanAttempts.clear();
    this.state.market = emptyMarket();
    this.state.tape = emptyTape();
    this.marketAnchors.clear();
    this.poolMeta.clear();
    // Balances belong to the chain they were read on, and a token id is
    // chain-scoped, so a chain switch invalidates every one of them.
    this.state.tracked = emptyTracked();
    this.trackedDecimals.clear();
    clearTimeout(this.marketTimer);
    clearTimeout(this.trackedTimer);
    clearTimeout(this.tapeTimer);
    // The socket is bound to one chain's fills; a chain switch must drop it.
    this.stopTapeStream();
    if (this.state.enabled) this.startTapeStream();
    this.push();
  }
  chains() {
    return this.state.config.chains;
  }
  watching(chain) {
    return this.state.config.chains.includes(chain);
  }
  // Re-ordering issues no request and keeps every cached report, so unlike
  // configure() this reuses the candidates already discovered.
  setSort(sort) {
    if (!SORTS.includes(sort)) throw new Error('排序方式无效');
    if (this.state.sort === sort) return;
    this.state.sort = sort;
    this.reconcile();
    this.push();
  }
  pause() {
    this.state.enabled = false;
    this.state.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.tapeTimer);
    clearTimeout(this.marketTimer);
    clearTimeout(this.trackedTimer);
    this.stopTapeStream();
    this.state.nextRefresh = null;
    this.state.market.nextTick = null;
    this.state.tracked.nextTick = null;
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
    if (this.marketPromise)
      void this.marketPromise.then(() => this.tickMarket());
    else void this.tickMarket();
    this.refreshTracked();
  }
  // Editing the list takes effect now rather than at the next tick: hot-reloading
  // the file is only worth anything if using the edit does not mean waiting.
  refreshTracked() {
    clearTimeout(this.trackedTimer);
    this.state.tracked.nextTick = null;
    if (this.trackedPromise)
      void this.trackedPromise.then(() => this.tickTracked());
    else void this.tickTracked();
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
    // The tape is one chain's order flow and exists nowhere else, so it runs
    // whenever Robinhood is among the selected chains rather than only when it
    // is the sole one.
    if (
      !this.openTapeSocket ||
      this.socket ||
      !this.state.enabled ||
      !this.watching('robinhood')
    )
      return;
    const generation = this.state.generation;
    const current = () =>
      this.state.enabled && generation === this.state.generation;
    this.socket = this.openTapeSocket({
      onFills: (rows) => {
        if (current()) this.ingestFills(rows);
      },
      onLabels: (map) => {
        if (current()) this.applyLabels(map);
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
    // A live socket delivers new fills and re-judged flags on its own; the
    // reader then runs only often enough to backstop the rows it cannot cover.
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
  // Upstream re-judges a fill after it lands — a stranger turning out to have
  // funded the buy, a pool pulled minutes later — and pushes the new verdict on
  // the same socket. Applying it here is what keeps a revoked buy from holding
  // its priority seat until the next full read.
  applyLabels(map) {
    // The frame lists only the ids upstream currently flags, so an id missing
    // from it means "no flags" — but only across the span the frame speaks for.
    // Our tape reaches further back than that span, and reading absence as
    // "cleared" outside it would silently drop warnings the frame never covered.
    let low = Infinity,
      high = -Infinity;
    const flags = new Map();
    for (const [key, value] of Object.entries(map)) {
      const id = number(key);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      // One unusable entry is not a reason to discard the rest of the frame;
      // the row it names simply keeps the flags it already had.
      if (!Array.isArray(value) || value.some((f) => typeof f !== 'string'))
        continue;
      flags.set(
        id,
        value.slice(0, 20).map((f) => f.slice(0, 160)),
      );
      if (id < low) low = id;
      if (id > high) high = id;
    }
    if (low > high) return;
    const tape = this.state.tape;
    let changed = false;
    tape.events = tape.events.map((t) => {
      if (t.eventId < low || t.eventId > high) return t;
      const next = flags.get(t.eventId) ?? [];
      // A row whose flags were unreadable at read time counts as changed even
      // when the frame agrees it has none: unknown and none are not the same.
      if (t.flagsKnown && t.flags.join('|') === next.join('|')) return t;
      changed = true;
      return { ...t, flags: next, flagsKnown: true };
    });
    if (!changed) return;
    // Deliberately not touching polledAt: only a completed full read proves the
    // rows outside this frame's span were re-collected too.
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
    // Order before the cap, so a token that ranks low on heat can still reach
    // the list on age. Live buys keep the front regardless of the chosen order.
    s.candidates = capByChain(
      [
        ...priority,
        ...orderCandidates(
          picked.selected.filter((c) => !ids.has(c.id)),
          s.sort,
        ),
      ],
      s.config.chains,
    );
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
    if (!this.fetchTape || !this.state.enabled || !this.watching('robinhood'))
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
  // Written as a replacement, never a mutation. Every stored report holds a
  // reference to the candidate it was built from, so writing a new price through
  // that object would silently rewrite the market cap the verdict was reached
  // at — the one number that makes an old report readable.
  // `byChain` is Map<chain, Map<lowercase address, quote>>. Keeping the chain in
  // the lookup is not defensive tidiness: the same 20-byte address is a
  // different contract on every EVM chain, and a flat address key would file
  // one chain's price under another chain's coin as a number that looks fine.
  applyQuotes(byChain) {
    let total = 0;
    for (const quotes of byChain.values()) total += quotes.size;
    if (!total) return 0;
    const find = (c) =>
      byChain.get(c.chain)?.get(String(c.address).toLowerCase()) ?? null;
    const merge = (c) => {
      const q = find(c);
      return q ? { ...c, ...q } : c;
    };
    this.baseCandidates = this.baseCandidates.map(merge);
    for (const [chain, rows] of this.baseByChain)
      this.baseByChain.set(chain, rows.map(merge));
    this.state.candidates = this.state.candidates.map(merge);
    return this.state.candidates.filter((c) => find(c)).length;
  }
  // The source's own quote for one chain, re-fetched only when it has nothing
  // useful left to say. DexScreener republishes about every 32 seconds and
  // allows ~300 requests a minute, so it is asked every tick; GeckoTerminal
  // allows a tenth of that and was measured lagging the chain by minutes, so
  // polling it every 6 seconds would spend its whole budget re-reading bytes it
  // had already sent. Either way the price on screen comes from the pool read
  // below, which runs every tick on both.
  async marketAnchor(chain, addresses, now) {
    const held = this.marketAnchors.get(chain);
    const ttl = this.anchorTtl(chain);
    const covered =
      held && addresses.every((a) => held.quotes.has(String(a).toLowerCase()));
    // A candidate the anchor has never seen has no pool, no supply and no
    // dollar rate to scale, so a newly discovered coin re-fetches regardless of
    // how recently the rest of the chain was quoted.
    if (held && covered && now - held.at < ttl) return { ...held, reused: true };
    const r = await this.quoteMarket(chain, addresses);
    const fresh = { quotes: r.quotes, sources: r.sources, at: now };
    this.marketAnchors.set(chain, fresh);
    return { ...fresh, reused: false };
  }
  async quoteChain(chain, addresses, now) {
    const anchor = await this.marketAnchor(chain, addresses, now);
    const sources = anchor.sources.map((s) =>
      anchor.reused
        ? // Reused evidence keeps the time it was actually fetched. Re-stamping
          // it now would make the age beside the row the age of this tick.
          { ...s, reused: true }
        : s,
    );
    // A held anchor still carries coins that have since left the list. Reading
    // their pools would spend sub-calls on rows nobody can see.
    const wanted = new Set(addresses.map((a) => String(a).toLowerCase()));
    const quotes = new Map(
      [...anchor.quotes].filter(([address]) => wanted.has(address)),
    );
    if (!this.freshenMarket || !quotes.size) return { chain, quotes, sources };
    if (!this.poolMeta.has(chain)) this.poolMeta.set(chain, new Map());
    const r = await this.freshenMarket({
      chain,
      quotes,
      meta: this.poolMeta.get(chain),
    });
    return {
      chain,
      quotes: r.quotes,
      sources: r.source ? [...sources, r.source] : sources,
    };
  }
  async tickMarket() {
    if (!this.quoteMarket || this.marketPromise) return this.marketPromise;
    const s = this.state;
    if (!s.enabled) return;
    clearTimeout(this.marketTimer);
    const start = this.clock(),
      generation = s.generation,
      market = s.market;
    const current = () => s.enabled && generation === s.generation;
    // Grouped by chain because each chain has its own quote source, its own
    // rate limit and its own RPC; one chain's outage must not blank the others.
    const wanted = new Map(s.config.chains.map((chain) => [chain, []]));
    for (const c of s.candidates) wanted.get(c.chain)?.push(c.address);
    market.busy = true;
    market.nextTick = null;
    this.marketPromise = (async () => {
      try {
        if (![...wanted.values()].some((a) => a.length)) return;
        const lanes = await Promise.all(
          [...wanted]
            .filter(([, addresses]) => addresses.length)
            .map(async ([chain, addresses]) => {
              try {
                return await this.quoteChain(chain, addresses, this.clock());
              } catch (e) {
                // A lane that threw is one chain's failure, reported as that
                // chain's — not as a market tick that did not happen.
                return {
                  chain,
                  quotes: new Map(),
                  sources: [
                    {
                      name: `${CHAINS[chain]?.label || chain} 实时行情`,
                      url: '',
                      status: 'error',
                      fetchedAt: new Date(this.clock()).toISOString(),
                      error: String(e.message).slice(0, 180),
                    },
                  ],
                };
              }
            }),
        );
        if (!current()) return;
        market.sources = lanes.flatMap((lane) =>
          lane.sources.map((x) => ({
            ...withoutData(x),
            chain: lane.chain,
          })),
        );
        // No batches at all means none of these chains has a quotable endpoint,
        // which is a different thing from requests that failed.
        if (!market.sources.length) {
          market.supported = false;
          market.error = null;
          return;
        }
        market.supported = true;
        const failed = market.sources.filter((x) =>
          ['error', 'unconfigured'].includes(x.status),
        );
        market.quoted = this.applyQuotes(
          new Map(lanes.map((lane) => [lane.chain, lane.quotes])),
        );
        // A tick that updated nothing must not stamp a fresh observation time:
        // the age on screen would then be the age of the request rather than of
        // the price, which is the one thing this timestamp exists to say.
        if (market.quoted)
          market.observedAt = new Date(this.clock()).toISOString();
        market.error = failed.length
          ? `实时行情 ${failed.length}/${market.sources.length} 批未取得（${CHAINS[failed[0].chain]?.label || failed[0].chain}）：${failed[0].error || '来源错误'}`
          : null;
      } catch (e) {
        if (current()) market.error = String(e.message).slice(0, 180);
      } finally {
        market.busy = false;
        if (current() && this.autoSchedule) {
          const delay = Math.max(
            1000,
            MARKET_INTERVAL - (this.clock() - start),
          );
          market.nextTick = new Date(this.clock() + delay).toISOString();
          this.marketTimer = setTimeout(() => void this.tickMarket(), delay);
          this.marketTimer?.unref?.();
        }
        this.push();
      }
    })();
    try {
      await this.marketPromise;
    } finally {
      this.marketPromise = null;
    }
  }
  async tickTracked() {
    if (!this.readTracked || this.trackedPromise) return this.trackedPromise;
    const s = this.state;
    if (!s.enabled) return;
    clearTimeout(this.trackedTimer);
    const start = this.clock(),
      generation = s.generation,
      tracked = s.tracked;
    const current = () => s.enabled && generation === s.generation;
    const wallets = (this.watchlist?.state.entries || []).map((e) => e.address);
    const byChain = new Map(s.config.chains.map((chain) => [chain, []]));
    for (const c of s.candidates)
      byChain.get(c.chain)?.push({ id: c.id, address: c.address });
    tracked.busy = true;
    tracked.nextTick = null;
    this.trackedPromise = (async () => {
      try {
        const lanes = [...byChain].filter(([, tokens]) => tokens.length);
        if (!wallets.length || !lanes.length) {
          tracked.error = null;
          return;
        }
        // Each chain is its own sweep against its own endpoint. Solana has no
        // EVM call to make at all and simply reports that, without costing the
        // EVM chains beside it their counts.
        const results = await Promise.all(
          lanes.map(async ([chain, tokens]) => {
            try {
              const r = await this.readTracked({
                chain,
                tokens,
                wallets,
                decimals: this.trackedDecimals,
              });
              return { chain, ok: true, r };
            } catch (e) {
              const message = String(e.message).slice(0, 180);
              return {
                chain,
                ok: false,
                // A chain with no endpoint configured is not a chain whose read
                // failed. The page says so differently, because one of them is a
                // thing to go fix and the other is a thing to wait out.
                supported: !/未配置|不支持|没有 Multicall3/.test(message),
                error: message,
              };
            }
          }),
        );
        if (!current()) return;
        // Whole-sweep replacement. A coin that dropped off the list keeps no
        // stale row, and a coin that arrived has none until it is read.
        const merged = {};
        // Token ids carry their chain, so merging the per-chain results cannot
        // collide even when two chains hold the same address.
        for (const lane of results)
          if (lane.ok) Object.assign(merged, lane.r.tokens);
        tracked.byCandidate = merged;
        tracked.chains = results.map((lane) => ({
          chain: lane.chain,
          supported: lane.ok ? true : lane.supported,
          rpc: lane.ok ? lane.r.rpc : null,
          block: lane.ok ? lane.r.block : null,
          swept: lane.ok ? lane.r.wallets : 0,
          requests: lane.ok ? lane.r.requests : 0,
          observedAt: lane.ok ? lane.r.observedAt : null,
          error: lane.ok
            ? lane.r.failedChunks
              ? `${lane.r.failedChunks} 批余额未取得，相关地址按未核验计：${lane.r.error}`
              : null
            : lane.error,
        }));
        const read = tracked.chains.filter((x) => x.observedAt);
        // The headline figures describe the whole sweep, so they take the
        // weakest answer any chain gave: a count is only as swept as its least
        // swept chain, and one unsupported chain makes the column partial.
        tracked.supported = tracked.chains.some((x) => x.supported);
        tracked.rpc = read.length === 1 ? read[0].rpc : null;
        tracked.block = read.length === 1 ? read[0].block : null;
        tracked.swept = read.length ? Math.min(...read.map((x) => x.swept)) : 0;
        tracked.requests = tracked.chains.reduce((n, x) => n + x.requests, 0);
        // The oldest of the sweeps, because that is the age the whole column is
        // good for; the newest would overstate every chain but one.
        tracked.observedAt = read.length
          ? read
              .map((x) => x.observedAt)
              .sort((a, b) => Date.parse(a) - Date.parse(b))[0]
          : null;
        const broken = tracked.chains.filter((x) => x.error);
        tracked.error = broken.length
          ? broken
              .map((x) => `${CHAINS[x.chain]?.label || x.chain}：${x.error}`)
              .join('；')
          : null;
      } catch (e) {
        if (!current()) return;
        tracked.error = String(e.message).slice(0, 180);
      } finally {
        tracked.busy = false;
        if (current() && this.autoSchedule) {
          const delay = Math.max(
            2000,
            TRACKED_INTERVAL - (this.clock() - start),
          );
          tracked.nextTick = new Date(this.clock() + delay).toISOString();
          this.trackedTimer = setTimeout(() => void this.tickTracked(), delay);
          this.trackedTimer?.unref?.();
        }
        this.push();
      }
    })();
    try {
      await this.trackedPromise;
    } finally {
      this.trackedPromise = null;
    }
  }
  // Balances are stored against addresses; the notes are joined on here, every
  // time a snapshot is built. So renaming an address shows up on the next push
  // without re-reading anything, and deleting one stops it counting at once
  // rather than at the next sweep.
  trackedSummary(now) {
    const s = this.state,
      t = s.tracked;
    const list = this.watchlist?.state || null;
    const entries = new Map((list?.entries || []).map((e) => [e.address, e]));
    const byCandidate = {};
    for (const c of s.candidates) {
      const row = t.byCandidate[c.id];
      if (!row) continue;
      const price = number(c.price);
      const decimals = this.trackedDecimals.get(c.id);
      const hits = row.hits
        .filter((h) => entries.has(h.wallet))
        .map((h) => {
          const e = entries.get(h.wallet);
          // Float division is fine here and only here: the raw integer is what
          // was read, and this is the approximate size shown beside a name.
          const amount =
            decimals === undefined ? null : Number(h.raw) / 10 ** decimals;
          return {
            address: e.address,
            note: e.note,
            emoji: e.emoji,
            amount,
            usd: amount !== null && price !== null ? amount * price : null,
          };
        })
        .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
      byCandidate[c.id] = {
        count: hits.length,
        hits,
        unknown: row.unknown,
        status: row.status,
      };
    }
    return {
      ...t,
      byCandidate,
      // The file exists and parsed into at least one address. Without that the
      // column shows "未配置" rather than a column of zeroes.
      configured: Boolean(list?.present && entries.size),
      wallets: entries.size,
      listError: list?.error || null,
      listLoadedAt: list?.loadedAt || null,
      listSkipped: (list?.skipped || []).slice(0, 12),
      listSkippedTotal: (list?.skipped || []).length,
      // The list moved since the sweep that produced these numbers. A re-sweep
      // is already queued; until it lands the counts speak for the old list.
      pending: Boolean(t.observedAt) && t.swept !== entries.size,
      stale:
        Boolean(t.observedAt) &&
        now - Date.parse(t.observedAt) > TRACKED_INTERVAL * 3,
    };
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
        const chains = s.config.chains;
        const lanes = await Promise.all(
          chains.map(async (chain) => {
            try {
              return { chain, ...(await this.discover(chain)) };
            } catch (e) {
              return {
                chain,
                candidates: [],
                sources: [],
                error: String(e.message).slice(0, 200),
              };
            }
          }),
        );
        if (generation !== s.generation || !s.enabled) return;
        s.sources = lanes.flatMap((lane) =>
          lane.sources.map((x) => ({ ...withoutData(x), chain: lane.chain })),
        );
        // Judged per chain, kept per chain. A chain whose sources are down
        // holds the candidates it last had instead of emptying the board, and
        // the chains beside it still refresh — which is the whole reason the
        // last good result is stored per chain rather than as one list.
        const down = [];
        for (const lane of lanes) {
          if (lane.sources.some((x) => DISCOVERY_PRIMARY.has(x.name) && x.status === 'ok')) {
            this.baseByChain.set(lane.chain, lane.candidates);
            continue;
          }
          down.push(CHAINS[lane.chain]?.label || lane.chain);
        }
        // Chains that have gone away since the last refresh must not keep
        // contributing rows to a board they are no longer part of. Deleting the
        // key being visited is defined behaviour for a Map, so this iterates the
        // live view rather than a copy.
        for (const chain of this.baseByChain.keys())
          if (!chains.includes(chain)) this.baseByChain.delete(chain);
        this.baseCandidates = chains.flatMap(
          (chain) => this.baseByChain.get(chain) || [],
        );
        s.discoveryStale = down.length > 0;
        s.error = down.length
          ? `${down.join('、')} 发现来源暂不可用，保留上次成功候选与报告；它们可能已过期。`
          : null;
        // A refresh where every chain failed learned nothing, so it must not
        // stamp a new observation time over the one the old rows came from.
        if (down.length === chains.length) return;
        this.reconcile();
        s.updatedAt = new Date(this.clock()).toISOString();
        void this.scan();
        void this.tickMarket();
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
                incomplete(s.reports[c.id]) ||
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
        // Scanning through a cooldown produces a token's worth of rate-limit
        // errors per candidate and nothing else. Wait it out instead.
        const until = this.gmgnCooldown();
        if (until > this.clock()) {
          s.error = `GMGN 限流，扫描暂停至 ${new Date(until).toISOString()}`;
          this.push();
          if (!this.autoSchedule) break;
          await new Promise((r) => setTimeout(r, until - this.clock()));
          continue;
        }
        this.liveStarts = candidate === live ? this.liveStarts + 1 : 0;
        this.scanAttempts.set(candidate.id, this.clock());
        const generation = s.generation;
        s.scanning = candidate.id;
        let spent = 0;
        try {
          const raw = await this.collect(
            candidate,
            () => s.enabled && generation === s.generation,
            s.reports[candidate.id] ?? null,
          );
          spent = raw.gmgnCalls ?? 0;
          const info = raw.sources.find((r) => r.key === 'info');
          // A rate-limited scan skips security, holders and dev entirely. Writing
          // it would stamp a near-empty report as checked now and hide the older,
          // real one behind a fresh timestamp for the next three minutes.
          const limited =
            info?.status === 'error' && /限流|超时/.test(info.error || '');
          const checkedAt = new Date(this.clock()).toISOString();
          if (limited) {
            // The attempt still counts: a timeout sets no cooldown, and retrying
            // it immediately would starve every other candidate in the queue.
            s.error = `${candidate.symbol} 未重查：${info.error}`;
          } else if (
            s.enabled &&
            generation === s.generation &&
            s.candidates.some((c) => c.id === candidate.id)
          )
            s.reports[candidate.id] = {
              ...evaluateRisk(candidate, raw.data, raw.sources),
              candidate,
              first: firstMark(s.reports[candidate.id], candidate, checkedAt),
              checkedAt,
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
        // A scan that spent nothing at the limiter was never paced by it.
        if (s.enabled && !spent)
          await new Promise((resolve) => setTimeout(resolve, MIN_SCAN_GAP));
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
        // Pushed labels only speak for the ids upstream currently flags. Without
        // a completed read, the rows outside that span are still un-re-collected.
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
      tracked: this.trackedSummary(now),
      reports: Object.fromEntries(
        Object.entries(this.state.reports)
          .filter(([key]) => candidateIds.has(key))
          .map(([key, { raw: _raw, ...r }]) => [key, r]),
      ),
      connections: { gmgn: true, x: Boolean(process.env.X_BEARER_TOKEN) },
      freshForSeconds: 180,
      gmgnPace: this.gmgnPace(),
      // Every snapshot a page can receive is built right here, by reading the
      // state at the moment of the call — so a larger `rev` always means
      // newer-or-equal content. That is the whole ordering guarantee the page
      // needs. It needs one because pushes and request replies travel on
      // separate connections and are not delivered in the order they were
      // produced: a frame flushed a moment before a chain switch can land
      // after the switch's reply and put the previous chain's candidates back
      // on screen, where they stay until the next push.
      // `boot` changes when this process restarts, and the counter starts over
      // with it. Without it a page holding a watermark from the old process
      // would reject every frame from the new one, forever.
      rev: ++this.rev,
      boot: this.boot,
    };
  }
}
