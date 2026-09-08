'use client';
import { useState } from 'react';
import {
  Radio,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import type { Tape, Candidate } from './types';
import { gmgnTokenUrl } from '@/lib/token-links';

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const money = (n: number | null) =>
  n === null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(n);
const compact = (n: number | null) =>
  n === null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(n);
const time = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });

function Address({
  value,
  label,
  kind,
}: {
  value: string | null;
  label: string;
  kind?: 'address' | 'tx';
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span>—</span>;
  return (
    <span className="tape-address-group">
      {kind && (
        <a
          href={`https://robinhoodchain.blockscout.com/${kind}/${value}`}
          target="_blank"
          rel="noreferrer"
          title={`${label}：${value}`}
        >
          {short(value)}
          <ArrowUpRight size={10} />
        </a>
      )}
      <button
        className="tape-address"
        title={`${label}：${value} · 点击复制`}
        aria-label={`复制${label} ${value}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
      >
        {!kind && <span>{short(value)}</span>}
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
    </span>
  );
}

export function LiveTape({
  tape,
  enabled,
  candidates,
  onSelect,
}: {
  tape?: Tape;
  enabled: boolean;
  candidates: Candidate[];
  onSelect: (id: string) => void;
}) {
  const [side, setSide] = useState('all'),
    [query, setQuery] = useState(''),
    [expanded, setExpanded] = useState(false);
  const q = query.trim().toLowerCase();
  const rows = (tape?.events || []).filter(
    (t) =>
      (side === 'all' || t.side === side) &&
      (!q ||
        [t.symbol, t.address, t.wallet, t.handle].some((v) =>
          v?.toLowerCase().includes(q),
        )),
  );
  const candidateIds = new Set(candidates.map((c) => c.id));
  const quoteError = tape?.quoteSources.find((s) => s.status === 'error');
  return (
    <section className="tape-panel" aria-label="Trenches 追踪钱包交易流">
      <div className="tape-header">
        <div className="tape-heading">
          <Radio size={18} />
          <h2>LIVE TAPE</h2>
          <span className={`dot ${enabled && !tape?.stale ? 'live' : 'off'}`} />
          <span
            title={
              tape?.transport === 'socket'
                ? '已连上来源推送通道，成交在上游落库后即时到达。仍受来源索引延迟影响。'
                : '推送通道未建立或已断开，退回按固定间隔读取；延迟至少一个间隔。'
            }
          >
            {!enabled
              ? '已暂停'
              : tape?.transport === 'socket'
                ? '推送中'
                : !tape?.updatedAt
                  ? '连接中'
                  : tape?.stale
                    ? '数据延迟'
                    : `轮询 ${tape?.intervalSeconds || 5} 秒`}
          </span>
          <a
            href="https://robinhoodtrenches.com"
            target="_blank"
            rel="noreferrer"
          >
            Trenches
            <ArrowUpRight size={12} />
          </a>
        </div>
        <div className="tape-controls">
          <Tabs value={side} onValueChange={setSide}>
            <TabsList>
              <TabsTrigger value="all">全部</TabsTrigger>
              <TabsTrigger value="buy">买入</TabsTrigger>
              <TabsTrigger value="sell">卖出</TabsTrigger>
            </TabsList>
          </Tabs>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜代币 / 交易员 / 地址"
            aria-label="筛选实时交易"
          />
        </div>
      </div>
      <div className="tape-caption">
        <span>
          Robinhood 追踪钱包 · 最近 2 分钟已获取样本：
          <b>{tape?.recentBuys || 0}</b> 笔定价且无标记买入 /{' '}
          <b>{tape?.recentWallets || 0}</b> 个钱包
        </span>
        <span>
          {tape?.transport === 'socket'
            ? `推送通道 · 每 ${tape?.intervalSeconds || 60} 秒复核修订`
            : `每 ${tape?.intervalSeconds || 5} 秒读取`}{' '}
          · 最近成交{' '}
          {tape?.lastFillAt
            ? new Date(tape.lastFillAt).toLocaleTimeString('zh-CN', {
                hour12: false,
              })
            : '—'}
          {tape?.stream?.lagSeconds != null && (
            <span title="来源在建立连接时自报的索引落后秒数，不是本次成交的实测延迟。">
              {' '}
              · 来源自报落后 {tape.stream.lagSeconds.toFixed(1)}s
            </span>
          )}
        </span>
      </div>
      {tape?.revisionStale && enabled && (
        <output className="tape-warning">
          已展示行的修订复核未按时完成：推送只带新成交，来源事后改判的异常标记暂未取得。
        </output>
      )}
      {tape?.error && (
        <output className="tape-warning">
          交易流读取失败：{tape.error}。保留上次记录，时间仍按成交时间计算。
        </output>
      )}
      {quoteError && (
        <output className="tape-warning">
          市值核验暂不可用：{quoteError.error}。未知市值不会进入低市值候选。
        </output>
      )}
      {tape?.gap && (
        <p className="tape-warning">
          中断期间交易超出最近 400 条补抓窗口，可能存在遗漏。
        </p>
      )}
      <div className={`tape-scroll ${expanded ? 'expanded' : ''}`}>
        <Table className="tape-table">
          <TableHeader>
            <TableRow>
              <TableHead>成交时间</TableHead>
              <TableHead>方向</TableHead>
              <TableHead>代币 / CA</TableHead>
              <TableHead className="tape-number">金额 / 价格</TableHead>
              <TableHead>交易员 / 钱包</TableHead>
              <TableHead>FOMO 主页</TableHead>
              <TableHead>交易</TableHead>
              <TableHead>自动排雷</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, expanded ? 100 : 20).map((t) => {
              const anomalous = !t.flagsKnown || t.flags.length > 0;
              return (
                <TableRow
                  className={`tape-row tape-${t.side} ${anomalous ? 'tape-flagged' : ''}`}
                  key={t.id}
                >
                  <TableCell>
                    <time title={new Date(t.ts * 1000).toLocaleString('zh-CN')}>
                      {time(t.ts)}
                    </time>
                  </TableCell>
                  <TableCell>
                    <span className={`tape-side ${t.side}`}>
                      {t.side === 'buy' ? 'BUY' : 'SELL'}
                    </span>
                    {t.firstBuy && t.side === 'buy' && (
                      <small
                        className="tape-first"
                        title="来源标记本次新建仓，不代表钱包历史首次交易"
                      >
                        首次建仓
                      </small>
                    )}
                  </TableCell>
                  <TableCell>
                    <a
                      className="tape-token"
                      href={gmgnTokenUrl('robinhood', t.address)}
                      title="在 GMGN 查看代币"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t.symbol}
                      <ArrowUpRight size={11} />
                    </a>
                    <Address value={t.address} label="代币 CA" />
                  </TableCell>
                  <TableCell className="tape-number">
                    <strong>
                      {t.priced !== 'cash_leg' && t.usd !== null ? '≈' : ''}
                      {money(t.usd)}
                    </strong>
                    <small>
                      {t.price === null
                        ? '价格未知'
                        : `$${t.price.toPrecision(3)}`}{' '}
                      · {compact(t.amount)} 枚
                    </small>
                  </TableCell>
                  <TableCell>
                    <span>
                      {t.handle || '未知交易员'}{' '}
                      <small
                        className="tape-followers"
                        title="来源报告的粉丝数，不代表买入人数"
                      >
                        {compact(t.followers)} 粉丝
                      </small>
                    </span>
                    <Address
                      value={t.wallet}
                      label="交易员钱包"
                      kind="address"
                    />
                  </TableCell>
                  <TableCell>
                    {t.profileUrl ? (
                      <a
                        className="tape-profile"
                        href={t.profileUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={t.profileUrl}
                      >
                        fomo / {t.handle}
                        <ArrowUpRight size={12} />
                      </a>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <Address value={t.tx} label="交易哈希" kind="tx" />
                  </TableCell>
                  <TableCell>
                    <span
                      className={
                        anomalous
                          ? 'tape-anomaly'
                          : t.reason === '已进入候选'
                            ? 'tape-admitted'
                            : 'tape-reason'
                      }
                      title={t.flags.join(' · ') || t.priced}
                    >
                      {t.reason}
                    </span>
                    {t.flags.length > 0 && (
                      <small
                        className="tape-flag-text"
                        title={t.flags.join(' · ')}
                      >
                        {t.flags.join(' · ')}
                      </small>
                    )}
                    {candidateIds.has(t.candidateId) && (
                      <button
                        className="tape-view"
                        onClick={() => onSelect(t.candidateId)}
                      >
                        查看排雷 <ArrowUpRight size={11} />
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {!rows.length && (
          <div className="tape-empty">
            {query || side !== 'all'
              ? '没有匹配的交易记录'
              : !enabled
                ? '监控已暂停'
                : tape?.error
                  ? '等待交易流恢复'
                  : '正在读取网站追踪钱包的近期交易…'}
          </div>
        )}
      </div>
      <div className="tape-footer">
        <p>
          仅观察网站追踪样本。近 2 分钟有现金腿定价、无异常标记的买入，经市值 /
          流动性筛选后自动排队。历史成交保留展示。
        </p>
        <Button variant="ghost" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? '收起' : '展开记录'}
          <span>{rows.length}</span>
        </Button>
      </div>
    </section>
  );
}
