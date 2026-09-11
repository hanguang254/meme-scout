export type Source = {
  key?: string;
  name: string;
  url: string;
  status: string;
  error?: string;
  warning?: string;
  fetchedAt: string;
  // Carried over from an earlier scan. fetchedAt is that scan's time, not this
  // report's, and the row says so.
  reused?: boolean;
};
export type TapeEvent = {
  id: string;
  eventId: number;
  ts: number;
  candidateId: string;
  address: string;
  wallet: string | null;
  tx: string | null;
  side: 'buy' | 'sell';
  symbol: string;
  handle: string | null;
  profileUrl: string | null;
  followers: number | null;
  usd: number | null;
  price: number | null;
  amount: number | null;
  firstBuy: boolean | null;
  priced: string;
  flags: string[];
  flagsKnown: boolean;
  reason: string;
};
export type Tape = {
  events: TapeEvent[];
  source: Source | null;
  quoteSources: Source[];
  updatedAt: string | null;
  nextPoll: string | null;
  busy: boolean;
  quoteBusy: boolean;
  stale: boolean;
  error: string | null;
  gap: boolean;
  intervalSeconds: number;
  recentBuys: number;
  recentWallets: number;
  transport: 'socket' | 'polling';
  socketStatus: string;
  polledAt: string | null;
  lastFillAt: string | null;
  revisionStale: boolean;
  stream: null | {
    wallets: number | null;
    trades: number | null;
    lagSeconds: number | null;
    indexerAge: number | null;
    lastBlock: number | null;
    viewers: number | null;
    medianLatency: number | null;
    observedAt: string;
  };
};
export type Candidate = {
  id: string;
  chain: string;
  address: string;
  symbol: string;
  name: string;
  marketCap: number | null;
  // Fully diluted value. Its gap from marketCap is supply that is not counted as
  // circulating; the source publishes neither the supply it used nor the reason
  // they differ, so one can never be substituted for the other.
  fdv?: number | null;
  liquidity: number | null;
  volume: number | null;
  volumeWindow: string;
  volume5m?: number | null;
  price: number | null;
  change: number | null;
  change5m?: number | null;
  buys5m?: number | null;
  sells5m?: number | null;
  marketCapSource?: string;
  source: string;
  sourceUrl: string;
  createdAt?: number | null;
  rugRatio?: number | null;
  buyers?: number | null;
  sellers?: number | null;
  lastTrade?: TapeEvent;
  marketObservedAt?: string;
  trench?: {
    firstBuyer: string | null;
    firstBuyAt: number | null;
    radarBuyers: number | null;
    lead: string | null;
    followers: number | null;
    totalUsd: number | null;
    observedAt: string;
  };
  trackedBuyers: number | null;
  trackedHolders: number | null;
  netFlow: number | null;
};
export type Finding = {
  id: string;
  group: string;
  severity: string;
  title: string;
  detail: string;
  source: string;
  value: unknown;
};
export type Report = {
  verdict: string;
  coverage: number;
  // A source reported that this coin cannot be sold. The candidate list drops
  // it. False also covers "no sell test was obtained", which is most of the
  // list — see the comment where this is computed in scanner/risk.mjs.
  unsellable?: boolean;
  // The X account the source linked to this coin, normalised to a handle in
  // scanner/profile.mjs so the page never builds a URL out of a source string.
  // Null when the source linked none, or linked something that is not an
  // x.com handle. Having one is not evidence of anything.
  twitter?: { handle: string; url: string } | null;
  evidenceSummary?: { total: number; checked: number; unknown: number };
  checkedAt: string;
  candidate: Candidate;
  // The market cap of the first report written for this coin. Rescans replace
  // `candidate`; this one is carried forward, so it is the only anchor on the
  // page older than the last few minutes. Null until a report has a cap at all.
  first?: { marketCap: number | null; at: string } | null;
  findings: Finding[];
  sources: Source[];
  walletSummary: {
    top10: number | null;
    excluded: number;
    wallets: {
      address: string;
      share: number | null;
      tags: string[];
      funder: string | null;
    }[];
    clusters: { address: string; wallets: string[] }[];
  };
  developer: {
    address: string | null;
    total: number | null;
    history: {
      address: string;
      symbol: string;
      marketCap: number | null;
      ath: number | null;
      liquidity: number | null;
      graduated: boolean | null;
    }[];
  };
  social: null | {
    posts: number;
    authors: number;
    duplicateRatio: number | null;
    accountAgeCoverage: number;
    youngAccountRatio: number | null;
    verdict: string;
    signals: string[];
    missingChecks?: string[];
    window: string;
    limitations: string;
    examples: {
      id: string;
      text: string;
      author: string;
      url: string;
      createdAt: string;
    }[];
  };
};
export type Config = {
  chain: string;
  minCap: number;
  maxCap: number;
  minLiquidity: number;
};
// The price-only refresh that runs between discovery passes. It updates the
// market numbers on candidates already listed and never changes which
// candidates are listed — that stays with discovery.
export type Market = {
  observedAt: string | null;
  nextTick: string | null;
  busy: boolean;
  quoted: number;
  supported: boolean;
  error: string | null;
  sources: Source[];
  intervalSeconds: number;
};
export type Sort = 'heat' | 'new';
export type State = {
  enabled: boolean;
  config: Config;
  sort: Sort;
  candidates: Candidate[];
  reports: Record<string, Report>;
  sources: Source[];
  updatedAt: string | null;
  nextRefresh: string | null;
  busy: boolean;
  scanning: string | null;
  error: string | null;
  unknownCap: number;
  total: number;
  connections: { gmgn: boolean; x: boolean };
  freshForSeconds: number;
  // Stamped where the snapshot is built, so a smaller `rev` is always staler.
  // The page drops those: pushes and request replies arrive on separate
  // connections and not in the order they were produced. `boot` identifies the
  // data service process, whose counter starts over when it restarts.
  rev: number;
  boot: string;
  // Present once the source has answered a request with a rate limit: the
  // scanner then runs slower than `target` for the rest of the session.
  gmgnPace?: {
    target: number;
    current: number;
    reducedAt: string | null;
  } | null;
  market: Market;
  tape: Tape;
};
