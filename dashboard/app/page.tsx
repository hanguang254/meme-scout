'use client';
import { Fragment, useEffect, useState } from 'react';
import { LiveTape } from './live-tape';
import { RiskPills, RiskLegend } from './risk-pills';
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
import type { State, Config, Report, Source } from './types';
const chains = [
  { id: 'robinhood', label: 'Robinhood' },
  { id: 'sol', label: 'Solana' },
  { id: 'bsc', label: 'BNB Chain' },
  { id: 'base', label: 'Base' },
  { id: 'eth', label: 'Ethereum' },
];
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
const ageText = (at: string | null | undefined, now: number) => {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分钟前`;
};
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
export default function Home() {
  const [state, setState] = useState<State | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(''),
    [filterOpen, setFilterOpen] = useState(false),
    [mode, setMode] = useState('all'),
    [xToken, setXToken] = useState(''),
    [saved, setSaved] = useState(false),
    [pending, setPending] = useState(false),
    [observedNow, setObservedNow] = useState(0);
  const pace = state?.gmgnPace;
  const marketAge = ageText(state?.market?.observedAt, observedNow);
  const [config, setConfig] = useState<Config>({
    chain: 'robinhood',
    minCap: 10000,
    maxCap: 5000000,
    minLiquidity: 5000,
  });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const apply = (next: State) => {
      if (!active) return;
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
      if (data.config) setState(data);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      return false;
    } finally {
      setPending(false);
    }
  };
  const rows = (state?.candidates || []).filter(
    (c) =>
      mode === 'all' ||
      (mode === 'risk'
        ? ['严重风险', '发现高风险'].includes(
            state?.reports[c.id]?.verdict || '',
          )
        : !state?.reports[c.id]),
  );
  const riskCount = Object.values(state?.reports || {}).filter((r) =>
    ['严重风险', '发现高风险'].includes(r.verdict),
  ).length;
  const applied = state?.config || config;
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
              title={`市值、成交、流动性由 DexScreener 每 ${state?.market?.intervalSeconds ?? 15} 秒单独重取，不消耗 GMGN 额度，也不改变候选名单——名单仍由每 60 秒的发现决定。报告里的证据只在该币重扫时更新。`}
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
        {applied.chain === 'robinhood' && (
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
                value={applied.chain}
                onValueChange={(value) => {
                  if (value) {
                    const c = { ...applied, chain: String(value) };
                    setConfig(c);
                    void post('/api/monitor', { config: c, enabled: true });
                  }
                }}
              >
                <SelectTrigger aria-label="选择监控链">
                  <SelectValue>
                    {chains.find((c) => c.id === applied.chain)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {chains.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                className="filter-button"
                onClick={() => {
                  setConfig(applied);
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
            <span>
              {applied.chain === 'robinhood'
                ? 'Trenches 追踪钱包 + GMGN 热门'
                : 'GMGN · 1 小时热门交易榜'}
            </span>
            <span>{state?.unknownCap || 0} 个市值未知，未纳入</span>
          </div>
          <div className="list-controls">
            <Tabs value={mode} onValueChange={(v) => setMode(String(v))}>
              <TabsList variant="line" className="market-tabs">
                <TabsTrigger value="all">
                  全部候选<span>{state?.candidates.length || 0}</span>
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
                          <button
                            className="token-cell"
                            onClick={() => setSelected(c.id)}
                            aria-label={`高亮 ${c.symbol}`}
                          >
                            <span className="rank">
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <span className={`mini-coin hue-${i % 4}`}>
                              {c.symbol.slice(0, 2)}
                            </span>
                            <span>
                              <strong>{c.symbol}</strong>
                              <small
                                title={`实时市值 ${money(c.marketCap)}，取自 ${c.marketCapSource || c.source}${
                                  marketAge ? `，${marketAge}读取` : ''
                                }。完全稀释估值 ${money(c.fdv)}；两者的差是未计入流通的供应量，来源没有公布它用的流通量，也没有说明差在哪里，所以不能互相替代。`}
                              >
                                {money(c.marketCap)}
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
                          </button>
                        </TableCell>
                        <TableCell>
                          <strong>{money(c.volume)}</strong>
                          <small>LP {money(c.liquidity)}</small>
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
                        <TableCell colSpan={5}>
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
                    : '当前筛选下没有候选'}
              </h3>
              <p>
                {mode === 'risk'
                  ? '未扫描、未知和数据缺失都不能视为安全。'
                  : '榜单自动更新。可调整市值 / 流动性范围，或切换监控链。'}
              </p>
            </div>
          )}
          <div className="market-footnote">
            <CircleAlert size={14} />
            <span>
              {applied.chain === 'robinhood'
                ? '追踪钱包是有限样本；市值由 DexScreener / GMGN 补齐。榜单按追踪买家数、成交量排序。'
                : '热门榜只用于发现，热度和聪明钱标签不构成安全证据。'}
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
