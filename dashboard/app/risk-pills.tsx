'use client';
import { Tooltip } from '@base-ui/react/tooltip';
import { useMemo, useState } from 'react';
import {
  buildPills,
  type Pill,
  pendingPill,
  toneText,
  UNKNOWN_KEY,
} from './pill-slots';
import type { Report } from './types';

export { buildPills, type Pill } from './pill-slots';

export function RiskPills({
  report,
  scanning,
  stale,
}: {
  report?: Report;
  scanning: boolean;
  stale: boolean;
}) {
  const [active, setActive] = useState<{ el: HTMLElement; pill: Pill } | null>(
    null,
  );
  // Ages are rendered from an absolute timestamp, so they follow the poll that
  // re-renders this row rather than the (up to 3 minutes old) report.
  const pills = useMemo(
    () => (report ? buildPills(report) : [pendingPill(scanning)]),
    [report, scanning],
  );
  const byKey = useMemo(
    () => new Map(pills.map((p) => [p.key, p])),
    [pills],
  );
  // One controlled tooltip per strip, anchored at whichever chip is hovered.
  const track = (e: { target: EventTarget | null }) => {
    const el =
      e.target instanceof Element
        ? e.target.closest<HTMLElement>('[data-pill]')
        : null;
    const pill = el?.dataset.pill ? byKey.get(el.dataset.pill) : undefined;
    setActive(el && pill ? { el, pill } : null);
  };
  return (
    <div
      className={`risk-strip${stale ? ' risk-strip-stale' : ''}`}
      onPointerOver={track}
      onPointerLeave={() => setActive(null)}
      onPointerDown={() => setActive(null)}
    >
      {pills.map((p) => (
        <span
          key={p.key}
          data-pill={p.key}
          className={`risk-chip ${p.tone}${p.incomplete ? ' is-incomplete' : ''}${p.key === UNKNOWN_KEY ? ' risk-unknown' : ''}`}
          aria-label={`${p.name}：${p.value}，${toneText[p.tone]}。${p.hint}`}
        >
          <p.Icon size={12} />
          <b>{p.value}</b>
        </span>
      ))}
      {stale && <span className="risk-stale-tag">报告已过期，等待重查</span>}
      <Tooltip.Root
        open={active !== null}
        onOpenChange={(open) => {
          if (!open) setActive(null);
        }}
        disableHoverablePopup
      >
        <Tooltip.Portal>
          <Tooltip.Positioner
            anchor={active?.el ?? null}
            side="top"
            sideOffset={8}
            className="pill-tip-positioner"
          >
            <Tooltip.Popup className="pill-tip">
              {active && (
                <>
                  <p className="pill-tip-hint">{active.pill.hint}</p>
                  <p className={`pill-tip-head ${active.pill.tone}`}>
                    {active.pill.head}
                  </p>
                  {active.pill.lines.map((text, i) => (
                    <p key={i} className="pill-tip-line">
                      {text}
                    </p>
                  ))}
                </>
              )}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </div>
  );
}

export function RiskLegend() {
  return (
    <div className="risk-legend">
      <span>
        <i className="lg-pass" />绿 ＝ 来源明确返回未触发
      </span>
      <span>
        <i className="lg-info" />蓝 ＝ 取得观察值，不代表安全
      </span>
      <span>
        <i className="lg-medium" />黄 ＝ 需要警惕
      </span>
      <span>
        <i className="lg-high" />红 ＝ 高风险 / 严重
      </span>
      <span>
        <i className="lg-unknown" />灰 ＝ 未核验，灰 ≠ 安全
      </span>
      <span>角标 ? ＝ 该项仍含未核验内容 · 悬停任意标记看图标含义、原始证据与来源</span>
    </div>
  );
}
