import { arr, fraction, millis, number } from './values.mjs';

// Evidence that GMGN already returns in responses the scanner fetches anyway.
// Nothing here issues a request: `token info` carries the 5-minute price bucket
// and the wallet tag breakdown, and `token holders` carries per-wallet tags.
// Kept apart from risk.mjs so it can be tested against a raw response alone.

const HOUR = 3600000;
const precisePct = (v) => (v === null ? '未知' : `${(v * 100).toFixed(2)}%`);
const signedPct = (v) =>
  v === null ? '未知' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const usd = (v) => {
  if (v === null) return '未知';
  const abs = Math.abs(v);
  const body =
    abs >= 1000
      ? Math.round(abs).toLocaleString('en-US')
      : abs.toFixed(abs >= 1 ? 2 : 4);
  return `${v < 0 ? '-' : ''}$${body}`;
};
const count = (v) => (v === null ? '未知' : String(v));

export function formatAge(ms) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '未知';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

const TAG_FIELDS = [
  ['sniper_wallets', '狙击'],
  ['bundler_wallets', '捆绑'],
  ['rat_trader_wallets', '老鼠仓'],
  ['fresh_wallets', '新钱包'],
  ['whale_wallets', '巨鲸'],
  ['smart_wallets', '聪明钱'],
  ['renowned_wallets', '知名'],
  ['top_wallets', '头部'],
];
const TAG_LABEL = new Map(TAG_FIELDS);

export function buildProfileFindings(data = {}, candidate = {}, now = Date.now()) {
  const findings = [];
  const add = (id, group, severity, title, detail, source, value = null) =>
    findings.push({ id, group, severity, title, detail, source, value });
  const info = data.info || {};
  const sec = data.security || {};
  const price = info.price && typeof info.price === 'object' ? info.price : {};

  // Timestamps ahead of the clock are source errors, not negative ages.
  const past = (t) => (t !== null && t <= now + 60000 ? t : null);
  const reportedCreation = past(millis(info.creation_timestamp));
  const createdAt = reportedCreation ?? past(millis(candidate.createdAt));
  const openAt = past(millis(info.open_timestamp));
  const ageMs = createdAt === null ? null : now - createdAt;
  const openAgeMs = openAt === null ? null : now - openAt;
  if (createdAt !== null || openAt !== null) {
    const young = (ageMs ?? openAgeMs) < HOUR;
    add(
      'age',
      'contract',
      young ? 'medium' : 'info',
      '代币年龄',
      `${
        createdAt !== null
          ? `合约创建至今 ${formatAge(ageMs)}`
          : '未取得合约创建时间'
      }${openAt !== null ? `；开放交易至今 ${formatAge(openAgeMs)}` : ''}。${
        young
          ? '不足 1 小时：持仓、成交与钱包标签的统计窗口都极短，其余指标的样本量不足以支撑结论。'
          : ''
      }年龄本身不是风险判定，老币同样可以跑路；这里只说明其他证据能覆盖多长的历史`,
      reportedCreation !== null
        ? 'GMGN info.creation_timestamp'
        : 'GMGN 发现阶段创建时间',
      { createdAt, openAt, ageMs, openAgeMs, observedAt: now },
    );
  }

  // risk.mjs already raises `rug-label` from the discovery feed's rug_ratio, so
  // that same field is only repeated here when it stayed below that threshold.
  const discovered = fraction(candidate.rugRatio);
  const rugObservations = [
    ['info.rug_ratio', fraction(info.rug_ratio)],
    ['security.rug_ratio', fraction(sec.rug_ratio)],
    ['发现阶段 rug_ratio', discovered !== null && discovered < 0.3 ? discovered : null],
  ]
    .filter(([, value]) => value !== null)
    .map(([field, value]) => ({ field, value }));
  if (rugObservations.length) {
    const ratio = Math.max(...rugObservations.map((o) => o.value));
    const disagrees = rugObservations.some((o) => o.value !== ratio);
    add(
      'rug-ratio',
      'honeypot',
      ratio > 0.3 ? 'high' : ratio > 0.1 ? 'medium' : 'info',
      'GMGN 跑路评分',
      `来源给出的 rug_ratio ${precisePct(ratio)}（0–1）${
        disagrees ? `；${rugObservations.length} 个字段不一致，显示最高观察值` : ''
      }。来源未公布计算方式，这不是统计概率，也不代表已经跑路；低分同样不能当作安全`,
      `GMGN ${rugObservations.map((o) => o.field).join(' / ')}`,
      { ratio, observations: rugObservations },
    );
  }

  const openPrice = number(price.price_5m);
  const lastPrice = number(price.price);
  const change =
    openPrice !== null && openPrice > 0 && lastPrice !== null
      ? (lastPrice - openPrice) / openPrice
      : null;
  const buys = number(price.buys_5m);
  const sells = number(price.sells_5m);
  const buyUsd = number(price.buy_volume_5m);
  const sellUsd = number(price.sell_volume_5m);
  const volume = number(price.volume_5m);
  const netUsd = buyUsd !== null && sellUsd !== null ? buyUsd - sellUsd : null;
  if ([change, buys, sells, volume, netUsd].some((v) => v !== null))
    add(
      'flow-5m',
      'liquidity',
      'info',
      '5 分钟盘面',
      `价格 ${signedPct(change)}；买 ${count(buys)} 笔 / 卖 ${count(sells)} 笔；买卖额净值 ${usd(netUsd)}，总成交 ${usd(volume)}。来源只给窗口首尾两点，看不到窗口内的 K 线形态，无法据此判断是一次性拉砸还是持续成交；行情涨跌不参与风险判级，只作观察`,
      'GMGN info.price.*_5m',
      {
        change,
        buys,
        sells,
        buyUsd,
        sellUsd,
        volume,
        netUsd,
        window: '5m',
        observedAt: now,
      },
    );

  const tagStat =
    info.wallet_tags_stat && typeof info.wallet_tags_stat === 'object'
      ? info.wallet_tags_stat
      : {};
  const counts = {};
  for (const [field] of TAG_FIELDS) {
    const n = number(tagStat[field]);
    if (n !== null && n >= 0) counts[field] = n;
  }
  const sample = arr(data.holders?.list);
  const sampleTags = new Map();
  for (const holder of sample)
    for (const tag of new Set(
      arr(holder?.tags).concat(arr(holder?.maker_token_tags)),
    ))
      if (typeof tag === 'string' && tag)
        sampleTags.set(tag, (sampleTags.get(tag) || 0) + 1);
  const reported = Object.keys(counts);
  if (reported.length || sampleTags.size) {
    const ranked = [...sampleTags].sort((a, b) => b[1] - a[1]);
    const alerts = [];
    for (const field of ['sniper_wallets', 'bundler_wallets'])
      if (counts[field] >= 5)
        alerts.push(`${TAG_LABEL.get(field)}钱包 ${counts[field]} 个`);
    add(
      'wallet-tags',
      'holders',
      alerts.length ? 'medium' : 'info',
      'GMGN 钱包分类',
      `${
        reported.length
          ? `来源标记的钱包个数：${TAG_FIELDS.filter(([f]) => f in counts)
              .map(([f, label]) => `${label} ${counts[f]}`)
              .join('、')}。来源没有公布这些计数的分母（持有人还是全部交易者），个数不能换算成比例`
          : '来源未返回钱包分类统计'
      }${
        ranked.length
          ? `。本机取得的 ${sample.length} 个持仓样本中带标签的地址：${ranked
              .slice(0, 8)
              .map(([tag, n]) => `${tag} ${n}`)
              .join('、')}${ranked.length > 8 ? ` 等 ${ranked.length} 种` : ''}（分母是这 ${sample.length} 个样本，不是全链持有人）`
          : ''
      }${
        alerts.length
          ? `。触发复核阈值：${alerts.join('、')}；阈值只用于提醒复核，不是对钱包身份或作恶的认定`
          : ''
      }`,
      'GMGN info.wallet_tags_stat / holders[].tags',
      {
        counts,
        sample: { size: sample.length, tags: Object.fromEntries(ranked) },
      },
    );
  }
  return findings;
}
