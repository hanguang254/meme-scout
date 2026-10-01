'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Popover } from '@heroui/react';
import { Bubbles, ExternalLink, X } from 'lucide-react';
import {
  atlasUrl,
  bubblemapsUrl,
  canEmbedAtlas,
  ATLAS_CHAINS,
} from '@/lib/token-links';
import type { Candidate } from './types';

type Metrics = {
  id: string;
  top10: number | null;
  cluster: number | null;
  bundlers: number | null;
  snipers: number | null;
  dev: number | null;
  insiders: number | null;
  fetchedAt: string;
};
type Result = { id: string; data?: Metrics; error?: string };
const pct = (v: number | null | undefined) =>
  v == null ? '未给出' : `${v.toFixed(2)}%`;
const tone = (v: number | null | undefined, high: number) =>
  v == null ? 'muted' : v >= high ? 'red' : 'green';
const subscribeHost = () => () => {};
const localHost = () => canEmbedAtlas(window.location.hostname);
const serverHost = () => false;

// The server and first client render agree. After hydration only hosts allowed
// by InsightX get a hover preview; deployed hosts remain ordinary direct links.
export function BubbleMapAction({ coin }: { coin: Candidate }) {
  const local = useSyncExternalStore(subscribeHost, localHost, serverHost);
  if (!ATLAS_CHAINS.includes(coin.chain)) return null;
  if (local) return <LocalBubbleMap coin={coin} />;
  return (
    <a
      href={bubblemapsUrl(coin.chain, coin.address)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`在 InsightX 打开 ${coin.symbol} 的持有人气泡图`}
      aria-label={`查看 ${coin.symbol} 的捆绑气泡图`}
    >
      <Bubbles size={15} />
    </a>
  );
}

function LocalBubbleMap({ coin }: { coin: Candidate }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinned = useRef(false);
  const keyboardOpen = useRef(false);
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = () => {
    cancelClose();
    pinned.current = false;
    if (dialog.current?.contains(document.activeElement))
      trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  };
  const leave = () => {
    cancelClose();
    if (!pinned.current) closeTimer.current = setTimeout(close, 300);
  };
  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    if (keyboardOpen.current) {
      dialog.current?.focus({ preventScroll: true });
      keyboardOpen.current = false;
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dialog.current?.contains(document.activeElement))
          trigger.current?.focus({ preventScroll: true });
        if (closeTimer.current !== null) clearTimeout(closeTimer.current);
        closeTimer.current = null;
        pinned.current = false;
        setOpen(false);
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`查看 ${coin.symbol} 的捆绑气泡图`}
        title={`悬停预览 ${coin.symbol} 的气泡图，点击固定展开`}
        onPointerEnter={(e) => {
          if (e.pointerType !== 'mouse') return;
          cancelClose();
          setOpen(true);
        }}
        onPointerLeave={leave}
        onClick={(e) => {
          e.stopPropagation();
          cancelClose();
          if (pinned.current) close();
          else {
            pinned.current = true;
            keyboardOpen.current = e.detail === 0;
            if (open && keyboardOpen.current) {
              dialog.current?.focus({ preventScroll: true });
              keyboardOpen.current = false;
            }
            setOpen(true);
          }
        }}
      >
        <Bubbles size={15} />
      </button>
      <Popover.Content
        isOpen={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        triggerRef={trigger}
        isNonModal
        placement="top end"
        offset={8}
        containerPadding={16}
        className="bubble-popover"
        onPointerEnter={cancelClose}
        onPointerLeave={leave}
        onClick={(e) => e.stopPropagation()}
      >
        <dialog
          open
          ref={dialog}
          tabIndex={-1}
          className="bubble-popover-dialog"
          aria-label={`${coin.symbol} 持有人气泡图`}
        >
          {open && <BubbleMapContent coin={coin} onClose={close} />}
        </dialog>
      </Popover.Content>
    </>
  );
}

// Mounted only while a local preview is open: idle rows and deployed links
// never request metrics or load an iframe. Closing aborts any pending request.
function BubbleMapContent({
  coin,
  onClose,
}: {
  coin: Candidate;
  onClose: () => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const id = coin.id;
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/insightx?id=${encodeURIComponent(id)}`, { signal: ctrl.signal })
      .then(async (r) => {
        const body = (await r.json()) as Metrics & { error?: string };
        if (!ctrl.signal.aborted)
          setResult(
            r.ok ? { id, data: body } : { id, error: body.error || '取数失败' },
          );
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted)
          setResult({ id, error: e instanceof Error ? e.message : '取数失败' });
      });
    return () => ctrl.abort();
  }, [id]);
  const own = result?.id === id ? result : null;
  const m = own?.data;
  const evm = coin.chain !== 'sol';
  return (
    <>
      <header className="bubble-head">
        <Popover.Heading className="bubble-title">
          InsightX <span>BubbleMaps</span>
          <small>{coin.symbol}</small>
        </Popover.Heading>
        <button
          type="button"
          className="bubble-close"
          aria-label="关闭气泡图"
          onClick={onClose}
        >
          <X size={16} />
        </button>
        <div className="bubble-metrics">
          {!own ? (
            <span className="muted">读取中…</span>
          ) : own.error ? (
            <span className="muted" title={own.error}>
              持仓比例取不到：{own.error}
            </span>
          ) : (
            <>
              <span title="前 10 名持有人（不含已识别的流动性池）合计持有的供应量比例。">
                Top10 <b className={tone(m?.top10, 30)}>{pct(m?.top10)}</b>
              </span>
              <span title="被 InsightX 按共同资金来源或交易模式归为同一簇的钱包合计持仓。簇只说明钱包之间有关联，不证明同一控制人。">
                聚类 <b className={tone(m?.cluster, 20)}>{pct(m?.cluster)}</b>
              </span>
              <span
                title={
                  evm
                    ? 'InsightX 只在 Solana 上检测捆绑钱包，EVM 链上接口固定返回 0，这里写「未测」而不是 0%。'
                    : '同一笔交易里多钱包协同买入的捆绑钱包，当前合计持仓。'
                }
              >
                捆绑持仓{' '}
                {evm ? (
                  <b className="muted">未测</b>
                ) : (
                  <b className={tone(m?.bundlers, 0.01)}>{pct(m?.bundlers)}</b>
                )}
              </span>
            </>
          )}
        </div>
      </header>
      <iframe
        className="bubble-frame"
        src={atlasUrl(coin.chain, coin.address)}
        title={`${coin.symbol} 持有人气泡图`}
        allow="clipboard-write"
        referrerPolicy="strict-origin-when-cross-origin"
      />
      <a
        className="bubble-away-link"
        href={bubblemapsUrl(coin.chain, coin.address)}
        target="_blank"
        rel="noopener noreferrer"
      >
        在 InsightX 官网打开 <ExternalLink size={12} />
      </a>
      <p className="bubble-note">
        悬停时读取，移出自动关闭，点击图标可固定展开。钱包之间连线表示有过转账或共同资金来源，不证明同一控制人。
      </p>
    </>
  );
}
