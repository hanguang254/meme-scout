'use client';
import { Tooltip } from '@base-ui/react/tooltip';
import { useState } from 'react';
import type { Tracked, TrackedHit } from './types';
// Names would wrap the popup into a wall; this is how many fit before it stops
// being scannable. The rest are counted, never dropped in silence.
const SHOWN = 12;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const label = (h: TrackedHit) =>
  `${h.emoji ? `${h.emoji} ` : ''}${h.note || `${short(h.address)}（未命名）`}`;
const usd = (n: number | null) =>
  n == null
    ? ''
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(n);
const clock = (s: string | null) =>
  s ? new Date(s).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
type View = {
  tone: string;
  value: string;
  unit: string;
  sub: string;
  hint: string;
  head: string;
  lines: string[];
};
// Everything this column can say, and the reason it is saying it. The one thing
// it must never do is print a number that reads as "checked, nobody holds it"
// when nothing was actually checked — so "0" and "未核验" are separate states
// all the way through, and the state that produced each is on the hover.
// Each chain is swept separately against its own endpoint and fails separately,
// so a row's block, freshness and errors are its own chain's — never the
// weakest of all of them. A Robinhood row reading "未配置 RPC" because Base was
// selected without one would be reporting a different chain's settings as this
// coin's, which is exactly the kind of borrowed answer this column exists to
// avoid. A chain absent from the breakdown was not read this round rather than
// unreadable, so it keeps `supported` and lands in 本轮未取得.
const laneFor = (tracked: Tracked | undefined, chain: string) => {
  const lanes = tracked?.chains;
  if (!lanes?.length)
    // A data service that has not restarted sends no breakdown. Its aggregate
    // fields then describe the single chain it was watching, which is this one.
    return {
      supported: tracked?.supported ?? true,
      block: tracked?.block ?? null,
      observedAt: tracked?.observedAt ?? null,
      swept: tracked?.swept ?? 0,
      error: tracked?.error ?? null,
    };
  return (
    lanes.find((x) => x.chain === chain) || {
      supported: true,
      block: null,
      observedAt: null,
      swept: 0,
      error: null,
    }
  );
};
function build(tracked: Tracked | undefined, id: string, chain: string): View {
  const lane = laneFor(tracked, chain);
  const at = lane.observedAt
    ? `区块 #${lane.block} · ${clock(lane.observedAt)} 读取`
    : '尚未读取';
  if (!tracked || !tracked.configured)
    return {
      tone: 'muted',
      value: '未配置',
      unit: '',
      sub: '没有名单',
      hint: '把追踪名单放到 dashboard/watchlist.json 就会启用这一列。',
      head: '追踪地址｜未配置',
      lines: [
        '格式见 dashboard/watchlist.example.json，直接用钱包追踪工具导出的 JSON 即可。',
        tracked?.listError || '名单文件改动后会自动重载，不用重启服务。',
      ],
    };
  if (!lane.supported)
    return {
      tone: 'unknown',
      value: '未核验',
      unit: '',
      sub: '该链不可读',
      hint: '这一格不是 0，也不代表名单里没人持有——这条链的余额根本没读到。',
      head: '追踪地址｜无法核验',
      lines: [lane.error || '该链未配置 RPC。'],
    };
  const row = tracked.byCandidate[id];
  if (!row || row.status === 'unchecked')
    return {
      tone: 'unknown',
      value: '未核验',
      unit: '',
      sub: tracked.busy ? '核验中…' : '等待本轮',
      hint: '这一格不是 0：这个币这一轮没有读到任何一个名单地址的余额。',
      head: '追踪地址｜本轮未取得',
      lines: [
        row?.unknown
          ? `${row.unknown} 个地址的 balanceOf 调用未成功，可能不是标准 ERC-20。`
          : `名单 ${tracked.wallets} 个地址，每 ${tracked.intervalSeconds} 秒核验一轮。`,
        lane.error || at,
      ],
    };
  const extra: string[] = [];
  if (row.unknown)
    extra.push(`另有 ${row.unknown} 个地址本轮未取得余额，未计入上面的数量。`);
  if (lane.swept && lane.swept < tracked.wallets)
    extra.push(
      `名单已改为 ${tracked.wallets} 个（这次读的是 ${lane.swept} 个），正在重新核验。`,
    );
  if (lane.error) extra.push(lane.error);
  if (tracked.stale) extra.push('这一轮没有刷新，上面是上次读到的结果。');
  if (tracked.listError) extra.push(tracked.listError);
  if (!row.count)
    return {
      tone: 'muted',
      value: '0',
      unit: '',
      sub: `${lane.swept || tracked.wallets} 个已查`,
      hint: `名单里 ${lane.swept || tracked.wallets} 个地址在这个区块上的余额都是 0。`,
      head: '追踪地址｜无人持有',
      lines: [at, ...extra],
    };
  const shown = row.hits.slice(0, SHOWN);
  return {
    tone: `hit${tracked.stale ? ' is-stale' : ''}`,
    value: String(row.count),
    unit: `/${tracked.wallets}`,
    sub: label(row.hits[0]) + (row.count > 1 ? ` 等 ${row.count} 个` : ''),
    hint: `名单地址在链上的当前余额 · ${at}`,
    head: `追踪地址｜${row.count} / ${tracked.wallets} 命中`,
    lines: [
      ...shown.map((h) => {
        const size =
          h.usd != null
            ? usd(h.usd)
            : h.amount != null
              ? '价格未知'
              : '数量未知';
        return `${label(h)} · ${short(h.address)} · ${size}`;
      }),
      ...(row.count > shown.length
        ? [`还有 ${row.count - shown.length} 个未列出。`]
        : []),
      ...extra,
    ],
  };
}
export function TrackedCell({
  tracked,
  id,
  chain,
}: {
  tracked?: Tracked;
  id: string;
  chain: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const view = build(tracked, id, chain);
  return (
    <span
      ref={setAnchor}
      className={`tracked-cell ${view.tone}`}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onPointerDown={() => setOpen(false)}
      aria-label={`${view.head}。${view.hint}`}
    >
      <strong>
        {view.value}
        {view.unit && <span className="tiny">{view.unit}</span>}
      </strong>
      <small>{view.sub}</small>
      <Tooltip.Root open={open} onOpenChange={setOpen} disableHoverablePopup>
        <Tooltip.Portal>
          <Tooltip.Positioner
            anchor={anchor}
            side="top"
            sideOffset={8}
            className="pill-tip-positioner"
          >
            <Tooltip.Popup className="pill-tip">
              <p className="pill-tip-hint">{view.hint}</p>
              <p className={`pill-tip-head ${view.tone.split(' ')[0]}`}>
                {view.head}
              </p>
              {view.lines.filter(Boolean).map((text, i) => (
                <p key={i} className="pill-tip-line">
                  {text}
                </p>
              ))}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </span>
  );
}
