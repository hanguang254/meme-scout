'use client';
import { Fragment, useEffect, useRef, useState } from 'react';
import { LiveTape } from './live-tape';
import { RiskPills, RiskLegend } from './risk-pills';
import { TrackedCell } from './tracked-cell';
import { gmgnTokenUrl } from '@/lib/token-links';
import {
  Radar,
  Radio,
  RefreshCw,
  Pause,
  Play,
  ArrowUpRight,
  ShieldCheck,
  CircleAlert,
  ExternalLink,
  Download,
  SlidersHorizontal,
  Settings2,
  Activity,
  Clock3,
  Eye,
  EyeOff,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { State, Config, Candidate, Report, Source } from './types';
// `note` is what the chain badge says on hover. It is kept in step with
// scanner/providers.mjs, which is the authority — GOPLUS_CHAINS, HONEYPOT_CHAINS
// and RPC_CONTRACT there decide what a report can actually contain. What this
// adds is saying so on the row itself, before a scan, so a chain with thin
// coverage does not read as a coin that passed every check.
const chains = [
  {
    id: 'robinhood',
    label: 'Robinhood',
    tag: 'RH',
    feed: 'Robinhood Trenches · 1h 追踪钱包 + Radar',
    note: '发现来自 Robinhood Trenches（追踪钱包榜、Radar、资金流），行情来自 DexScreener，价格每轮用链上池价刷新。权限证据有 GoPlus 与 Blockscout 合约结构。没有卖出模拟来源，能否卖出一律标未核验。',
  },
  {
    id: 'arc',
    label: 'Arc',
    tag: 'ARC',
    feed: 'GeckoTerminal · 1h 热门池 + 成交榜',
    note: '发现与行情来自 GeckoTerminal（DexScreener 未收录该链），价格每轮用链上池价刷新。GoPlus 不覆盖 5042、Honeypot.is 也不支持，所以权限证据只剩链上只读状态一项，能否卖出未核验。GeckoTerminal 在该链常只发布 FDV，市值列会标出来。',
  },
  {
    id: 'sol',
    label: 'Solana',
    tag: 'SOL',
    feed: 'GMGN · 1 小时热门交易榜',
    note: '发现来自 GMGN 热门，行情来自 DexScreener。权限证据有 GoPlus 与 RugCheck。不是 EVM 链，所以没有链上池价刷新、没有追踪地址持仓、Honeypot.is 也不支持，能否卖出未核验。',
  },
  {
    id: 'bsc',
    label: 'BNB Chain',
    tag: 'BNB',
    feed: 'GMGN · 1 小时热门交易榜',
    note: '发现来自 GMGN 热门，行情来自 DexScreener。权限证据有 GoPlus，卖出模拟有 Honeypot.is。链上池价与追踪地址持仓需要在 .env.local 配 BSC_RPC_URL，未配则如实标未核验。',
  },
  {
    id: 'base',
    label: 'Base',
    tag: 'BASE',
    feed: 'GMGN · 1 小时热门交易榜',
    note: '发现来自 GMGN 热门，行情来自 DexScreener。权限证据有 GoPlus，卖出模拟有 Honeypot.is。链上池价与追踪地址持仓需要在 .env.local 配 BASE_RPC_URL，未配则如实标未核验。',
  },
  {
    id: 'eth',
    label: 'Ethereum',
    tag: 'ETH',
    feed: 'GMGN · 1 小时热门交易榜',
    note: '发现来自 GMGN 热门，行情来自 DexScreener。权限证据有 GoPlus，卖出模拟有 Honeypot.is。链上池价与追踪地址持仓需要在 .env.local 配 ETH_RPC_URL，未配则如实标未核验。',
  },
];
const chainOf = (id: string) => chains.find((c) => c.id === id);
const chainLabel = (id: string) => chainOf(id)?.label || id;
const chainNote = (id: string) =>
  `${chainLabel(id)}：${chainOf(id)?.note || '这条链不在本页登记的覆盖表里，证据能取到哪些以报告里的来源行为准。'}`;
// The order the panel lists them in, not the order they were clicked, so the
// same selection always reads the same and comparing two of them is just this.
const orderChains = (ids: string[]) =>
  chains.map((c) => c.id).filter((id) => ids.includes(id));
const sameChains = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);
// Built field by field rather than spread from the applied config: that one may
// still carry the old single `chain` key, and sending both would leave which of
// the two wins up to the service.
const asConfig = (c: Config, chains: string[]): Config => ({
  chains,
  minCap: c.minCap,
  maxCap: c.maxCap,
  minLiquidity: c.minLiquidity,
});
const money = (n: number | null | undefined) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        maximumFractionDigits: 2,
      }).format(n);
const time = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
// How far the live number has moved from the one the report was written against.
// Null when either end is missing: a report with no market cap of its own has
// nothing to compare, and showing 0% there would claim the price held still.
// The colour is decided from the rounded number, not the raw one, so a move too
// small to survive rounding reads 0.0% and stays grey instead of being painted
// green. Green and red mean only "moved up / moved down since the check" —
// a rise on a token that can still be minted is not good news, so this reuses
// the same green/red as the 1h change column and never the risk colours.
const drift = (then: number | null | undefined, now: number | null | undefined) => {
  if (then == null || now == null || then === 0) return null;
  const raw = ((now - then) / then) * 100;
  const digits = Math.abs(raw) < 10 ? 1 : 0;
  const d = Number(raw.toFixed(digits));
  return {
    cls: d > 0 ? 'green' : d < 0 ? 'red' : '',
    text: `${d > 0 ? '+' : ''}${d.toFixed(digits)}%`,
  };
};
// What the market-cap cell says on hover. Three separate things, kept separate:
// what the number is a measure of, where it came from, and whether the price
// inside it was re-read on chain this cycle. The last one is the whole point of
// the pool-price lane — a row that does not say which of the two it is showing
// would let a stale source number pass for a fresh chain read.
const capNote = (c: Candidate, age: string | null) =>
  [
    c.capIsFdv
      ? `市值 ${money(c.marketCap)}：来源没有发布流通市值，这里显示的是完全稀释估值（FDV）。只有在供应量已全部流通时两者才相等，否则这个数偏大。`
      : `实时市值 ${money(c.marketCap)}，完全稀释估值 ${money(c.fdv)}；两者的差是未计入流通的供应量，来源没有公布它用的流通量，也没有说明差在哪里，所以不能互相替代。`,
    `取自 ${c.marketCapSource || c.source}${age ? `，${age}读取` : ''}。`,
    c.onchain
      ? `价格已按链上池价重算：区块 ${c.onchain.block ?? '未知'}，${String(
          c.onchain.version,
        ).toUpperCase()} 池，比来源报的价 ${
          drift(1, c.onchain.ratio)?.text ?? '持平'
        }。流通量口径和报价币的美元价仍然来自来源，只有价格是刚从链上读的。`
      : `本轮没有用上链上池价（${c.onchainNote || '未读到该池'}），显示的是来源自己发布的数字，它可能比链上落后几十秒。`,
  ].join('\n');
const ageText = (at: string | null | undefined, now: number) => {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分钟前`;
};
// Two separate icons sit by the name and they must not be confused. The
// magnifying glass is a *search* on the contract address — always present,
// finds nothing but whatever anyone happened to post. The X logo appears only
// when the source linked an actual account to this coin, and it is drawn as the
// brand mark precisely because it is that specific claim ("the source says this
// coin's account is @handle"), not a generic search. Neither is evidence: the
// tooltips say the search turns up nothing verified and the account is not
// checked for being real or the owner's.
const XLogo = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
const riskClass = (r?: Report) =>
  !r
    ? 'waiting'
    : r.verdict === '严重风险'
      ? 'critical'
      : r.verdict === '发现高风险'
        ? 'high'
        : r.verdict === '需要警惕'
          ? 'medium'
          : 'unknown';
const safeUrl = (u: string) => {
  try {
    return new URL(u).protocol === 'https:' ? u : '#';
  } catch {
    return '#';
  }
};
// A rescan reuses the evidence that does not move between scans. The report
// header says which parts those were and when they were actually fetched, so a
// carried finding is never read as having been checked at the report's time.
const carriedNote = (r: Report) => {
  const carried = (r.sources || []).filter((s) => s.reused);
  if (!carried.length) return '';
  const at = carried
    .map((s) => Date.parse(s.fetchedAt))
    .filter((t) => Number.isFinite(t));
  if (!at.length) return '';
  const minutes = Math.round(
    (Date.parse(r.checkedAt) - Math.min(...at)) / 60000,
  );
  return ` · ${carried.map((s) => s.name).join('、')}沿用 ${time(
    new Date(Math.min(...at)).toISOString(),
  )} 取得${minutes >= 1 ? `（早 ${minutes} 分钟）` : ''}`;
};
function SourceList({ sources }: { sources: Source[] }) {
  return (
    <div className="sources">
      {sources.map((s, i) => (
        <div className="source-row" key={`${s.name}-${i}`}>
          <span className={`dot ${s.status === 'ok' ? 'live' : 'off'}`} />
          <div>
            <a href={safeUrl(s.url)} target="_blank" rel="noreferrer">
              {s.name}
              <ArrowUpRight size={12} />
            </a>
            <small>
              {s.error || s.warning || `获取于 ${time(s.fetchedAt)}`}
            </small>
          </div>
          <span className="source-state">
            {s.status === 'ok'
              ? '已连接'
              : s.status === 'partial'
                ? '部分数据'
                : s.status === 'unconfigured'
                  ? '未配置'
                  : '不可用'}
          </span>
        </div>
      ))}
    </div>
  );
}
// True when `next` is newer than what the page already holds, and records it.
// The stream and the request replies are separate connections, so the order
// they are delivered in is not the order the service produced them in: a frame
// flushed a moment before a chain switch can land after that switch's reply and
// put the previous chain — its name and its whole candidate list — back on
// screen, where it sits until the next push. `rev` is stamped where the
// snapshot is built, so a smaller one is always staler and is dropped.
// A different `boot` means the data service restarted and its counter began
// again; that snapshot is taken on its own terms rather than compared against a
// watermark from a process that no longer exists.
const advance = (
  seen: { current: { boot: string; rev: number } },
  next: State,
) => {
  if (next.boot === seen.current.boot && next.rev <= seen.current.rev)
    return false;
  seen.current = { boot: next.boot, rev: next.rev };
  return true;
};
export default function Home() {
  const [state, setState] = useState<State | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(''),
    [filterOpen, setFilterOpen] = useState(false),
    [mode, setMode] = useState('all'),
    [showHidden, setShowHidden] = useState(false),
    [xToken, setXToken] = useState(''),
    [saved, setSaved] = useState(false),
    [pending, setPending] = useState(false),
    // Held only while the chain popup is open. Every configure() on the service
    // throws away the reports collected so far, so picking three chains has to
    // cost one reset, not three — the draft is committed when the popup closes.
    [chainDraft, setChainDraft] = useState<string[] | null>(null),
    [observedNow, setObservedNow] = useState(0);
  const seen = useRef({ boot: '', rev: 0 });
  const pace = state?.gmgnPace;
  const marketAge = ageText(state?.market?.observedAt, observedNow);
  const [config, setConfig] = useState<Config>({
    chains: ['robinhood'],
    minCap: 10000,
    maxCap: 5000000,
    minLiquidity: 5000,
  });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const apply = (next: State) => {
      if (!active || !advance(seen, next)) return;
      setState(next);
      setObservedNow(Date.now());
      setError('');
    };
    const tick = async () => {
      try {
        const r = await fetch('/api/state');
        if (!r.ok) throw new Error('数据服务暂不可用');
        apply((await r.json()) as State);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : '连接失败');
      }
    };
    const startPolling = () => {
      if (timer || !active) return;
      void tick();
      timer = setInterval(() => void tick(), 3000);
    };
    const stopPolling = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    // The service pushes on every change, so the page renders a fill as it
    // lands instead of on the next tick. Polling stays as the fallback: a
    // stream that never opens, or that drops, must not freeze the view.
    let stream: EventSource | null = null;
    try {
      stream = new EventSource('/api/stream');
      stream.onmessage = (event) => {
        try {
          apply(JSON.parse(event.data) as State);
          stopPolling();
        } catch {
          // A truncated frame is not a reason to tear down the stream.
        }
      };
      // EventSource retries on its own; polling covers the gap meanwhile.
      stream.onerror = () => startPolling();
    } catch {
      startPolling();
    }
    const opening = setTimeout(() => {
      if (stream?.readyState !== 1) startPolling();
    }, 4000);
    return () => {
      active = false;
      clearTimeout(opening);
      stopPolling();
      stream?.close();
    };
  }, []);
  const revealRow = (id: string) =>
    requestAnimationFrame(() => {
      const row = document.getElementById(`candidate-${id}`);
      (row || document.getElementById('candidate-workspace'))?.scrollIntoView({
        behavior: 'smooth',
        block: row ? 'center' : 'start',
      });
    });
  const post = async (path: string, body: unknown) => {
    setPending(true);
    setError('');
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as State & { error?: string };
      if (!r.ok) throw new Error(data.error || '操作失败');
      // Through the same watermark as the stream: this reply is the newest
      // snapshot at the moment a switch is made, and letting it bypass the
      // check would leave the stream free to overwrite it with an older one.
      if (data.config && advance(seen, data)) setState(data);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      return false;
    } finally {
      setPending(false);
    }
  };
  // Coins a source reported cannot be sold. They come out of 全部候选 — a coin
  // you cannot exit is not a candidate — but not out of the panel: 高风险 still
  // lists them, their reports and exports are untouched, and the scanner keeps
  // rescanning them. Hiding is a listing decision, not a retired verdict.
  const blocked = new Set(
    (state?.candidates || [])
      .filter((c) => state?.reports[c.id]?.unsellable)
      .map((c) => c.id),
  );
  const rows = (state?.candidates || []).filter((c) =>
    mode === 'all'
      ? showHidden || !blocked.has(c.id)
      : mode === 'risk'
        ? ['严重风险', '发现高风险'].includes(
            state?.reports[c.id]?.verdict || '',
          )
        : !state?.reports[c.id],
  );
  const riskCount = Object.values(state?.reports || {}).filter((r) =>
    ['严重风险', '发现高风险'].includes(r.verdict),
  ).length;
  const applied = state?.config || config;
  // A data service that has not been restarted still answers with the old
  // single `chain` key. Reading it here keeps a half-upgraded pair of processes
  // showing the chain it is actually watching instead of an empty selector.
  const watching: string[] = applied.chains?.length
    ? applied.chains
    : [(applied as unknown as { chain?: string }).chain || 'robinhood'];
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Radar size={24} />
          </span>
          <strong>
            meme<span>scout</span>
          </strong>
          <span className="brand-label">链上排雷工作台</span>
        </div>
        <div className="top-actions">
          <span className="local-badge">
            <span className="dot live" />
            本机运行
          </span>
          <Dialog>
            <DialogTrigger
              render={<Button variant="outline" className="subtle-button" />}
            >
              <Settings2 size={16} />
              数据连接
            </DialogTrigger>
            <DialogContent className="settings-dialog">
              <DialogHeader>
                <DialogTitle>数据连接</DialogTitle>
                <DialogDescription>
                  GMGN 使用本机配置。X 凭据仅保存在此电脑，不会返回浏览器。
                </DialogDescription>
              </DialogHeader>
              <SourceList
                sources={[
                  ...(state?.sources || []),
                  ...(state?.tape?.source ? [state.tape.source] : []),
                  ...(state?.tape?.quoteSources || []),
                ]}
              />
              <label className="field-label" htmlFor="x-token">
                X API Bearer Token
              </label>
              <Input
                id="x-token"
                type="password"
                autoComplete="off"
                value={xToken}
                onChange={(e) => {
                  setXToken(e.target.value);
                  setSaved(false);
                }}
                placeholder="粘贴具有 Recent Search 权限的 Token"
              />
              <p className="note">
                X
                接口需要账户权限与可用额度。未接入时，所有币的讨论质量均标为未核验。
              </p>
              <Button
                disabled={pending || !xToken}
                onClick={() =>
                  void post('/api/settings', { xToken }).then((ok) => {
                    if (ok) {
                      setXToken('');
                      setSaved(true);
                    }
                  })
                }
              >
                {saved ? '已保存，下轮扫描生效' : '保存 X 连接'}
              </Button>
              <a
                href="https://developer.x.com/"
                target="_blank"
                rel="noreferrer"
                className="text-link"
              >
                打开 X 开发者平台
                <ArrowUpRight size={14} />
              </a>
            </DialogContent>
          </Dialog>
        </div>
      </header>
      <div className="workspace">
        <section className="monitor-toolbar">
          <div>
            <div className="eyebrow">LIVE DISCOVERY</div>
            <h1>
              发现热度，先看风险
              <span className="live-status">
                <span className={`dot ${state?.enabled ? 'live' : 'off'}`} />
                {state?.enabled ? '监控中' : '已暂停'}
              </span>
            </h1>
            <p>每 60 秒发现热门候选 · 风险检查独立排队执行</p>
          </div>
          <div className="monitor-actions">
            <Button
              variant="outline"
              className="subtle-button"
              disabled={pending || !state}
              onClick={() =>
                void post('/api/monitor', { enabled: !state?.enabled })
              }
            >
              {state?.enabled ? <Pause size={15} /> : <Play size={15} />}{' '}
              {state?.enabled ? '暂停' : '恢复'}
            </Button>
            <Button
              className="refresh-button"
              disabled={!state?.enabled || state?.busy || pending}
              onClick={() => void post('/api/refresh', {})}
            >
              <RefreshCw size={15} className={state?.busy ? 'spinning' : ''} />
              {state?.busy ? '正在更新' : '立即刷新'}
            </Button>
          </div>
        </section>
        {(error || state?.error) && (
          <div className="error-banner" role="alert">
            <CircleAlert size={17} />
            {error || state?.error}
          </div>
        )}
        {pace && pace.current < pace.target && (
          <output className="error-banner">
            <CircleAlert size={17} />
            {`${time(pace.reducedAt)} GMGN 返回过限流，扫描速率已从 ${pace.target} 次/分降到 ${pace.current} 次/分并保持到重启。重查一轮更慢，过期标记会更常见。`}
          </output>
        )}
        <div className="stat-grid">
          <div className="stat-box">
            <span>
              <Radio size={15} />
              符合筛选
            </span>
            <strong>
              {state?.candidates.length ?? '—'}
              <small> / {state?.total ?? '—'} 个热门币</small>
            </strong>
            <p>
              市值 {money(applied.minCap)} – {money(applied.maxCap)}
            </p>
          </div>
          <div className="stat-box">
            <span>
              <ShieldCheck size={15} />
              已生成报告
            </span>
            <strong>
              {Object.keys(state?.reports || {}).length}
              <small> 个候选</small>
            </strong>
            <p>
              {state?.scanning
                ? `正在核验 ${state.candidates.find((c) => c.id === state.scanning)?.symbol || '候选'}`
                : '顺序检查 · 3 分钟后待重查'}
            </p>
          </div>
          <div className="stat-box">
            <span>
              <CircleAlert size={15} />
              高风险提示
            </span>
            <strong className={riskCount ? 'red' : ''}>
              {riskCount}
              <small> 个已扫描候选</small>
            </strong>
            <p>未知与未扫描不计入无风险</p>
          </div>
          <div className="stat-box">
            <span>
              <Clock3 size={15} />
              最近发现
            </span>
            <strong className="time-value">{time(state?.updatedAt)}</strong>
            <p>
              {state?.busy
                ? '发现 / 风险扫描进行中'
                : state?.nextRefresh
                  ? `下一轮 ${time(state.nextRefresh)}`
                  : '监控未启动'}
            </p>
            {/* Two different clocks drive this page and conflating them is what
                makes a stale number look live: discovery decides which coins are
                listed once a minute, the quote only re-reads their prices. */}
            <p
              title={`市值、成交、流动性每 ${state?.market?.intervalSeconds ?? 15} 秒单独重取（DexScreener，Arc 用 GeckoTerminal），每条链各取各的，不消耗 GMGN 额度，也不改变候选名单——名单仍由每 60 秒的发现决定。取回后价格还会用链上池价重算一次，能读到的行会标「链上」。报告里的证据只在该币重扫时更新。`}
            >
              {state?.market?.supported === false
                ? '实时行情：该链未接入'
                : state?.market?.error
                  ? `实时行情：${state.market.error}`
                  : marketAge
                    ? `行情 ${marketAge}（${state?.market?.quoted ?? 0} 个）`
                    : '行情待首次读取'}
            </p>
          </div>
        </div>
        {/* The tape is a Robinhood Trenches socket. With several chains watched
            at once it still only carries Robinhood fills, and the rows it
            highlights are matched by candidate id, which carries the chain. */}
        {watching.includes('robinhood') && (
          <LiveTape
            tape={state?.tape}
            enabled={state?.enabled ?? true}
            candidates={state?.candidates || []}
            onSelect={(id) => {
              setSelected(id);
              setMode('all');
              revealRow(id);
            }}
          />
        )}
        <section className="market-panel" id="candidate-workspace">
          <div className="market-controls">
            <div className="market-title">
              <Activity size={18} />
              <h2>热门候选</h2>
            </div>
            <div className="market-select">
              <Select
                multiple
                value={chainDraft ?? watching}
                onValueChange={(value) =>
                  setChainDraft(orderChains(value as string[]))
                }
                onOpenChange={(open) => {
                  if (open) return setChainDraft(watching);
                  const next = chainDraft;
                  setChainDraft(null);
                  if (!next || sameChains(next, watching)) return;
                  // Refusing an empty selection out loud. Quietly restoring the
                  // previous chains would leave the panel showing something
                  // other than what was just clicked, with no reason given.
                  if (!next.length) return setError('至少选择一条链');
                  const c = asConfig(applied, next);
                  setConfig(c);
                  void post('/api/monitor', { config: c, enabled: true });
                }}
              >
                <SelectTrigger
                  aria-label="选择监控链，可多选"
                  title={(chainDraft ?? watching).map(chainNote).join('\n\n')}
                >
                  <SelectValue>
                    {((ids: string[]) =>
                      ids.length === 1
                        ? chainLabel(ids[0])
                        : ids.length <= 3
                          ? ids.map((id) => chainOf(id)?.tag || id).join(' · ')
                          : `${ids.length} 条链`)(chainDraft ?? watching)}
                  </SelectValue>
                </SelectTrigger>
                {/* No single selected item to align the popup to once more than
                    one can be checked. */}
                <SelectContent alignItemWithTrigger={false}>
                  {chains.map((c) => (
                    <SelectItem key={c.id} value={c.id} title={c.note}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                className="filter-button"
                onClick={() => {
                  setConfig(asConfig(applied, watching));
                  setFilterOpen(!filterOpen);
                }}
                aria-expanded={filterOpen}
              >
                <SlidersHorizontal size={15} />
                筛选
              </Button>
            </div>
          </div>
          {filterOpen && (
            <form
              className="filters"
              onSubmit={(e) => {
                e.preventDefault();
                void post('/api/monitor', { config, enabled: true }).then(
                  (ok) => {
                    if (ok) setFilterOpen(false);
                  },
                );
              }}
            >
              <label htmlFor="min-cap">
                最低市值 / USD
                <Input
                  id="min-cap"
                  type="number"
                  min="0"
                  step="1000"
                  value={config.minCap}
                  onChange={(e) =>
                    setConfig({ ...config, minCap: Number(e.target.value) })
                  }
                />
              </label>
              <label htmlFor="max-cap">
                最高市值 / USD
                <Input
                  id="max-cap"
                  type="number"
                  min="1"
                  step="10000"
                  value={config.maxCap}
                  onChange={(e) =>
                    setConfig({ ...config, maxCap: Number(e.target.value) })
                  }
                />
              </label>
              <label htmlFor="min-liquidity">
                最低流动性 / USD
                <Input
                  id="min-liquidity"
                  type="number"
                  min="0"
                  step="1000"
                  value={config.minLiquidity}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      minLiquidity: Number(e.target.value),
                    })
                  }
                />
              </label>
              <Button type="submit" disabled={pending}>
                应用
              </Button>
            </form>
          )}
          <div className="list-subtitle">
            <span title={watching.map(chainNote).join('\n\n')}>
              {watching.length > 1
                ? `${watching
                    .map(
                      (id) =>
                        `${chainOf(id)?.tag || id} ${
                          (state?.candidates || []).filter(
                            (c) => c.chain === id,
                          ).length
                        }`,
                    )
                    .join(' · ')} · 合并一张榜，每链有保底名额`
                : chainOf(watching[0])?.feed || watching[0]}
            </span>
            <span>{state?.unknownCap || 0} 个市值未知，未纳入</span>
          </div>
          <div className="list-controls">
            <Tabs value={mode} onValueChange={(v) => setMode(String(v))}>
              <TabsList variant="line" className="market-tabs">
                <TabsTrigger value="all">
                  全部候选
                  <span>
                    {(state?.candidates.length || 0) -
                      (showHidden ? 0 : blocked.size)}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="risk">
                  高风险<span>{riskCount}</span>
                </TabsTrigger>
                <TabsTrigger value="pending">
                  待核验
                  <span>
                    {Math.max(
                      0,
                      (state?.candidates.length || 0) -
                        Object.keys(state?.reports || {}).length,
                    )}
                  </span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {blocked.size > 0 && (
              <button
                type="button"
                className={`hidden-toggle${showHidden ? ' is-open' : ''}`}
                onClick={() => setShowHidden(!showHidden)}
                title={
                  '这些币有来源明确报告无法卖出（貔貅 / 无法全部卖出），已从「全部候选」移出；「高风险」页签里仍然在，报告和导出都没有删。\n' +
                  '这只是把检出的拿掉，不代表剩下的已验证可卖：榜上多数币的卖出检测是「未取得」。'
                }
              >
                {showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
                {showHidden ? '收起' : '已隐藏'} {blocked.size} 个检出不可卖出
              </button>
            )}
            <div className="sort-switch">
              <span aria-hidden>排序</span>
              {(
                [
                  [
                    'heat',
                    '热度',
                    '按来源热度排序：追踪钱包买家数多的在前，相同则成交额大的在前。这是发现接口给出的原始顺序。',
                  ],
                  [
                    'new',
                    '最新',
                    '按建池时间从新到旧排序。取不到创建时间的候选留在原来的热度位置，不猜、也不当作新币。这里的时间是交易对/池的创建时间，不是代币合约的部署时间——换池会得到更“新”的时间。',
                  ],
                ] as const
              ).map(([key, label, hint]) => (
                <button
                  key={key}
                  type="button"
                  title={hint}
                  aria-label={hint}
                  aria-pressed={(state?.sort || 'heat') === key}
                  disabled={pending || !state}
                  onClick={() => void post('/api/monitor', { sort: key })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="candidate-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>代币 / 市值</TableHead>
                  <TableHead>成交 / 流动性</TableHead>
                  <TableHead className="hide-narrow">热度</TableHead>
                  <TableHead>排雷结论</TableHead>
                  <TableHead>追踪地址</TableHead>
                  <TableHead className="sr-only">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c, i) => {
                  const r = state?.reports[c.id];
                  const moved = drift(r?.candidate.marketCap, c.marketCap);
                  // Only worth its own line once a rescan has moved the other
                  // anchor away from it; on the first report the two lines
                  // would hold the same number twice.
                  const since =
                    r?.first && r.first.at !== r.checkedAt
                      ? drift(r.first.marketCap, c.marketCap)
                      : null;
                  const old = Boolean(
                    r &&
                    observedNow - Date.parse(r.checkedAt) >
                      (state?.freshForSeconds || 180) * 1000,
                  );
                  const sel = c.id === selected ? ' selected' : '';
                  return (
                    <Fragment key={c.id}>
                      <TableRow
                        id={`candidate-${c.id}`}
                        className={`candidate-row has-strip${sel}`}
                        onClick={() => setSelected(c.id)}
                      >
                        <TableCell>
                          <div className="token-cell">
                            <span className="rank">
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <span className={`mini-coin hue-${i % 4}`}>
                              {c.symbol.slice(0, 2)}
                            </span>
                            <span>
                              <span className="token-head">
                                {/* The row itself still selects on click; this
                                    button is what makes the name reachable by
                                    keyboard. It is a button rather than the
                                    whole cell so the X link can sit beside the
                                    name — an anchor cannot live in a button. */}
                                <button
                                  className="token-pick"
                                  onClick={() => setSelected(c.id)}
                                  aria-label={`高亮 ${c.symbol}`}
                                >
                                  {c.symbol}
                                </button>
                                {/* Always drawn, even when only one chain is
                                    watched: it carries the coverage note, and
                                    the gaps it names are the same gaps whether
                                    or not another chain sits beside it. */}
                                <span
                                  className="chain-tag"
                                  title={chainNote(c.chain)}
                                >
                                  {chainOf(c.chain)?.tag || c.chain}
                                </span>
                                <a
                                  className="x-search"
                                  href={`https://x.com/search?q=${encodeURIComponent(c.address)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  title={`在 X 搜索合约地址 ${c.address}。搜到的帖子只是有人贴过这个地址，不是风险证据，也不代表真人讨论——发帖的可能是项目方、机器人或批量转发。数量多寡都不参与本页任何判级。`}
                                  aria-label={`在 X 搜索 ${c.symbol} 的合约地址`}
                                >
                                  <Search size={12} />
                                </a>
                                {r?.twitter && (
                                  <a
                                    className="x-account"
                                    href={r.twitter.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    title={`打开来源登记的 X 账号 @${r.twitter.handle}。这只是本币在来源里登记的账号，能不能打开、是不是本人、有没有被冒用，这里都没有核验；账号存在本身不是安全或真实的证据。开发者的发币/删推/改名记录看下方「开发者推特」标记。`}
                                    aria-label={`打开 ${c.symbol} 登记的 X 账号 @${r.twitter.handle}`}
                                  >
                                    <XLogo />
                                  </a>
                                )}
                              </span>
                              <small title={capNote(c, marketAge)}>
                                {/* Remounting on a new value restarts the
                                    flash, so the eye is drawn only when the
                                    number actually moved — not every poll. */}
                                <span className="tick" key={c.marketCap}>
                                  {money(c.marketCap)}
                                </span>
                                {/* A diluted figure standing in for a
                                    circulating one is a different quantity, not
                                    a rounder version of the same one, so the
                                    number never appears unlabelled. */}
                                {c.capIsFdv && (
                                  <span className="cap-tag">FDV</span>
                                )}
                                {c.onchain && (
                                  <span className="cap-tag onchain">链上</span>
                                )}
                              </small>
                              {since && r?.first && (
                                <small
                                  className="cap-checked"
                                  title={`第一份报告写于 ${time(r.first.at)}，当时市值 ${money(r.first.marketCap)}。这个锚点不随重扫改变，所以它量的是从第一次出报告到现在；下面一行量的是从最近一次重扫到现在。该币掉出名单超过 15 分钟、报告被清理后才会重新计起。`}
                                >
                                  首次 {money(r.first.marketCap)}
                                  <span className={`cap-drift ${since.cls}`}>
                                    {since.text}
                                  </span>
                                </small>
                              )}
                              {r && (
                                <small
                                  className="cap-checked"
                                  title={`这份报告是在市值 ${money(r.candidate.marketCap)} 时写的（${time(r.checkedAt)}）。上面的市值每 ${state?.market?.intervalSeconds ?? 15} 秒重取一次，报告只在重扫时更新，所以两个数不同是正常的。涨跌幅只是两次取值之间的差，不是风险判断。`}
                                >
                                  核验时 {money(r.candidate.marketCap)}
                                  {moved && (
                                    <span className={`cap-drift ${moved.cls}`}>
                                      {moved.text}
                                    </span>
                                  )}
                                </small>
                              )}
                              {c.lastTrade && (
                                <span
                                  className="live-candidate-label"
                                  title={`${c.lastTrade.handle || '未知交易员'} 于 ${new Date(c.lastTrade.ts * 1000).toLocaleString('zh-CN')} 买入 ${money(c.lastTrade.usd)}。买入记录不代表风险检查通过，完整成交证据见上方 LIVE TAPE。`}
                                >
                                  TAPE 买入触发
                                </span>
                              )}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <strong>
                            <span className="tick" key={c.volume}>
                              {money(c.volume)}
                            </span>
                          </strong>
                          <small>
                            LP{' '}
                            <span className="tick" key={c.liquidity}>
                              {money(c.liquidity)}
                            </span>
                          </small>
                          {(c.buys5m != null ||
                            c.sells5m != null ||
                            c.volume5m != null) && (
                            <small
                              className="flow-live"
                              title={`最近 5 分钟：成交 ${money(c.volume5m)}，买 ${c.buys5m ?? '未知'} 笔 / 卖 ${c.sells5m ?? '未知'} 笔。与上面的成交额一样每 ${state?.market?.intervalSeconds ?? 15} 秒重取，是实时值；报告里的「5 分钟盘面」是上次重扫时的快照，两者会对不上。笔数不参与风险判级。`}
                            >
                              5m {money(c.volume5m)} 买
                              {c.buys5m ?? '?'}/卖{c.sells5m ?? '?'}
                            </small>
                          )}
                        </TableCell>
                        <TableCell className="hide-narrow">
                          {c.trackedBuyers !== null ? (
                            <>
                              <strong>
                                {c.trackedBuyers}
                                <span className="tiny"> 买入钱包</span>
                              </strong>
                              <small>样本净流入 {money(c.netFlow)}</small>
                            </>
                          ) : (
                            <>
                              <strong
                                className={
                                  c.change == null
                                    ? ''
                                    : c.change >= 0
                                      ? 'green'
                                      : 'red'
                                }
                              >
                                {c.change == null
                                  ? '—'
                                  : `${c.change >= 0 ? '+' : ''}${c.change.toFixed(1)}%`}
                              </strong>
                              <small>1h 涨跌</small>
                            </>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className={`badge ${riskClass(r)}`}>
                            {r
                              ? r.verdict
                              : state?.scanning === c.id
                                ? '扫描中…'
                                : '排队中'}
                          </span>
                          <small>
                            {r
                              ? `${time(r.checkedAt)} 核验 · ${r.coverage}/6 类有证据${carriedNote(r)}`
                              : '尚未判定风险'}
                          </small>
                        </TableCell>
                        <TableCell>
                          <TrackedCell
                            tracked={state?.tracked}
                            id={c.id}
                            chain={c.chain}
                          />
                        </TableCell>
                        <TableCell className="row-actions">
                          <a
                            href={safeUrl(gmgnTokenUrl(c.chain, c.address))}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title={`在 GMGN 打开 ${c.symbol}`}
                            aria-label={`在 GMGN 打开 ${c.symbol}`}
                          >
                            <ExternalLink size={15} />
                          </a>
                          {r && (
                            <a
                              href={`/api/report?id=${encodeURIComponent(c.id)}`}
                              download={`${c.chain}-${c.address}.json`}
                              onClick={(e) => e.stopPropagation()}
                              title="导出完整证据 JSON：逐条风险项、钱包分布、开发者发币历史、X 原帖与各来源原始响应"
                              aria-label={`导出 ${c.symbol} 的完整证据 JSON`}
                            >
                              <Download size={15} />
                            </a>
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow
                        className={`risk-strip-row${sel}`}
                        onClick={() => setSelected(c.id)}
                      >
                        <TableCell colSpan={6}>
                          <RiskPills
                            report={r}
                            scanning={state?.scanning === c.id}
                            stale={old}
                          />
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {rows.length > 0 && <RiskLegend />}
          {!rows.length && (
            <div className="market-empty">
              <Radar size={42} className={state?.busy ? 'spinning' : ''} />
              <h3>
                {!state || state.busy
                  ? '正在发现链上热门候选'
                  : mode === 'risk'
                    ? '当前没有已标出的高风险候选'
                    : mode === 'all' && blocked.size > 0
                      ? `当前候选全部检出不可卖出，已隐藏 ${blocked.size} 个`
                      : '当前筛选下没有候选'}
              </h3>
              <p>
                {mode === 'risk'
                  ? '未扫描、未知和数据缺失都不能视为安全。'
                  : mode === 'all' && blocked.size > 0
                    ? '点上方的「已隐藏」可以展开查看，它们也在「高风险」页签里。'
                    : '榜单自动更新。可调整市值 / 流动性范围，或切换监控链。'}
              </p>
            </div>
          )}
          <div className="market-footnote">
            <CircleAlert size={14} />
            <span>
              热门榜只用于发现，热度和聪明钱标签不构成安全证据。
              {watching.includes('robinhood') &&
                '追踪钱包是有限样本，榜单按追踪买家数、成交量排序。'}
              {watching.length > 1 &&
                '多条链合并在一张榜上，排序只比较各自来源给出的热度，跨链之间没有可比的统一口径。'}
            </span>
          </div>
          <div className="feed-health">
            <div className="eyebrow">DISCOVERY SOURCES</div>
            <SourceList sources={state?.sources || []} />
          </div>
        </section>
        <footer className="page-footer">
          <span>
            <Radar size={14} />
            MEME SCOUT <span className="footer-divider">/</span>只读监控
          </span>
          <span>数据有时效，缺失不等于安全。最终决定由你作出。</span>
        </footer>
      </div>
    </main>
  );
}
