import { number, flag, validAddress } from './risk.mjs';

const text = (v, max = 160) => (typeof v === 'string' ? v.slice(0, max) : '');
export const TAPE_INTERVAL = 5000;
// With the socket live, new fills already arrive on their own. The reader stays
// on the slower cadence purely to re-read the rows we already show: upstream
// re-judges a fill's flags as later evidence lands, and only a full snapshot
// carries those corrections.
export const TAPE_RELABEL_INTERVAL = 60000;
export const LIVE_CANDIDATE_TTL = 15 * 60000;

export function normalizeTape(rows) {
  if (!Array.isArray(rows)) throw new Error('Trenches LIVE TAPE 响应格式无效');
  return rows.flatMap((r) => {
    const eventId = number(r?.id),
      ts = number(r?.ts);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) return [];
    if (
      ts === null ||
      !validAddress('robinhood', r?.token) ||
      !['buy', 'sell'].includes(r.side)
    )
      return [{ id: `trenches:robinhood:${eventId}`, eventId, invalid: true }];
    const handle = text(r.handle, 80);
    const flagsKnown =
      Array.isArray(r.flags) && r.flags.every((f) => typeof f === 'string');
    return [
      {
        id: `trenches:robinhood:${eventId}`,
        eventId,
        ts,
        candidateId: `robinhood:${r.token.toLowerCase()}`,
        address: r.token.toLowerCase(),
        wallet: validAddress('robinhood', r.wallet)
          ? r.wallet.toLowerCase()
          : null,
        tx: /^0x[\da-fA-F]{64}$/.test(r.tx || '') ? r.tx : null,
        side: r.side,
        symbol: text(r.symbol, 50) || '?',
        name: text(r.name),
        handle: handle || null,
        profileUrl: handle
          ? `https://fomo.family/profile/${encodeURIComponent(handle)}`
          : null,
        followers: number(r.followers),
        usd: number(r.usd),
        price: number(r.price),
        amount: number(r.amount),
        firstBuy: flag(r.new_position),
        isStock: flag(r.is_stock),
        priced: text(r.priced, 60),
        flagsKnown,
        flags: flagsKnown ? r.flags.slice(0, 20).map((f) => text(f)) : [],
        twoSided: flag(r.two_sided),
        funding: text(r.funding, 60),
      },
    ];
  });
}

export function mergeTape(previous, incoming) {
  // A transaction may contain multiple fills. Upstream event IDs, not tx hashes,
  // identify rows. Re-reading overlapping snapshots also accepts flag corrections.
  return [...new Map([...previous, ...incoming].map((t) => [t.id, t])).values()]
    .filter((t) => !t.invalid)
    .sort((a, b) => b.eventId - a.eventId)
    .slice(0, 400);
}

export function tapeReason(t, now, maxAge = 120000) {
  if (!t || t.invalid) return '事件无效';
  if (t.isStock !== false) return t.isStock ? '股票代币' : '资产类别未知';
  if (!t.flagsKnown) return '异常标记字段缺失';
  if (t.flags.length) return '来源标记异常';
  if (t.side !== 'buy') return '卖出观察';
  if (t.priced !== 'cash_leg' || !(t.usd > 0) || !(t.price > 0))
    return '未取得现金腿定价';
  if (!t.wallet || !t.tx) return '钱包或交易哈希缺失';
  if (t.ts * 1000 > now + 60000) return '时间异常';
  if (now - t.ts * 1000 > maxAge) return '历史观察';
  return null;
}

export const eligibleBuy = (t, now, maxAge) =>
  tapeReason(t, now, maxAge) === null;
