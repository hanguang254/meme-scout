'use client';
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { atlasUrl, bubblemapsUrl, ATLAS_EMBED_HOSTS } from '@/lib/token-links';
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
// Opened by hand only. Nothing here runs until a row's button is clicked: the
// embed loads InsightX's map straight from InsightX, and the header numbers
// come from one request through the local service, which holds the key.
export function BubbleMap({
  coin,
  onClose,
}: {
  coin: Candidate | null;
  onClose: () => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const id = coin?.id;
  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    fetch(`/api/insightx?id=${encodeURIComponent(id)}`, { signal: ctrl.signal })
      .then(async (r) => {
        const body = (await r.json()) as Metrics & { error?: string };
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
  // A reply for the coin opened before this one is not this coin's.
  const own = result && result.id === id ? result : null;
  const m = own?.data;
  const evm = coin?.chain !== 'sol';
  // Read only while open, which is only ever after a click on the client, so
  // the server render (always closed) has nothing to disagree with.
  const embeddable =
    coin !== null && ATLAS_EMBED_HOSTS.includes(window.location.hostname);
  const external = coin ? bubblemapsUrl(coin.chain, coin.address) : '#';
  return (
    <Dialog
      open={coin !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="bubble-dialog">
        <DialogHeader className="bubble-head">
          <DialogTitle>
            InsightX <span>BubbleMaps</span>
            {coin && <small>{coin.symbol}</small>}
          </DialogTitle>
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
                <span title="被 InsightX 按共同资金来源或交易模式归为同一簇的钱包合计持仓。簇只说明钱包之间有关联，不证明同一控制人——交易所出金也会把人连在一起。">
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
                    <b className={tone(m?.bundlers, 0.01)}>
                      {pct(m?.bundlers)}
                    </b>
                  )}
                </span>
              </>
            )}
          </div>
          <DialogDescription className="sr-only">
            InsightX 持有人关系气泡图
          </DialogDescription>
        </DialogHeader>
        {coin && embeddable && (
          <iframe
            className="bubble-frame"
            src={atlasUrl(coin.chain, coin.address)}
            title={`${coin.symbol} 持有人气泡图`}
            allow="clipboard-write"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
        {coin && !embeddable && (
          <div className="bubble-away">
            <p>
              InsightX 只允许在本机地址（localhost /
              127.0.0.1）免费嵌入气泡图，这个域名下嵌进来只会显示拒绝页，所以在它的官网打开。
            </p>
            <a
              className="bubble-open"
              href={external}
              target="_blank"
              rel="noreferrer"
            >
              在 InsightX 打开 {coin.symbol} 的气泡图
              <ExternalLink size={15} />
            </a>
          </div>
        )}
        {coin && embeddable && (
          <a
            className="bubble-away-link"
            href={external}
            target="_blank"
            rel="noreferrer"
          >
            在 InsightX 官网打开
            <ExternalLink size={12} />
          </a>
        )}
        <p className="bubble-note">
          图和比例都来自
          InsightX，只在你点开时读取。钱包之间连线表示有过转账或共同资金来源，不证明同一控制人。
        </p>
      </DialogContent>
    </Dialog>
  );
}
