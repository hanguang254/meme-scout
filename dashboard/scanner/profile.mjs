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

// Turn the source's X field into a link we are willing to render. It arrives in
// two shapes: `token info` stores a path ("CoachPatNFT/status/2098…", sometimes
// pointing at one post rather than the account), while the discovery feed
// returns a full URL. Both are reduced to the first path segment and re-anchored
// to x.com, so the value decides *which account* and never the scheme or the
// host — otherwise a crafted field would become a link the page hands the user.
// The handle rules are X's own: 1–15 of [A-Za-z0-9_]. Anything else returns
// null and the link is simply not drawn; failing closed costs one icon.
export function normalizeXAccount(raw) {
  if (typeof raw !== 'string') return null;
  const handle = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(?:www\.|mobile\.)?(?:x|twitter)\.com(?=\/)/i, '')
    .replace(/^\/+/, '')
    .replace(/^@/, '')
    .split(/[/?#]/)[0];
  return /^[A-Za-z0-9_]{1,15}$/.test(handle)
    ? { handle, url: `https://x.com/${handle}` }
    : null;
}

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

  // What the creator's X account has done across launches, not that it exists.
  // The source keys these three to the token's linked account: how many coins it
  // has launched, how many of those had their posts deleted afterwards, and how
  // many times it was renamed. `token info` already carries them, so this costs
  // no request.
  //
  // Filed under `dev` and never `social`, for the reason spelled out at the view
  // counter below: the social group's only real evidence is the post sample, and
  // a launch counter must not be what marks "X 讨论" as covered.
  const xAccount = normalizeXAccount(info.link?.twitter_username);
  // A negative count is a source error, not an observation of fewer than zero.
  const nonNeg = (v) => (v !== null && v >= 0 ? v : null);
  const launches = nonNeg(number(info.dev?.twitter_create_token_count));
  const deletions = nonNeg(number(info.dev?.twitter_del_post_token_count));
  const renameLog = arr(info.dev?.twitter_name_change_history);
  const renames = renameLog.length || null;
  if (launches !== null || deletions !== null || renames !== null) {
    // 5 and 10 are our lines, not the source's: GMGN publishes the count and no
    // cutoff anywhere, so nothing here inherits a threshold from the data.
    add(
      'dev-twitter',
      'dev',
      launches !== null && launches >= 10
        ? 'high'
        : (launches !== null && launches >= 5) || deletions > 0 || renames
          ? 'medium'
          : 'info', // launches < 5, no deletions, no renames: an observation.
      '开发者推特',
      `${[
        launches !== null ? `同一个 X 账号发过 ${launches} 个币` : null,
        deletions !== null
          ? `${launches !== null ? '其中 ' : ''}${deletions} 个发完删了推文`
          : null,
        renames ? `账号改过 ${renames} 次名` : null,
        xAccount ? `本币登记的账号是 @${xAccount.handle}` : null,
      ]
        .filter(Boolean)
        .join('；')}。发币数 ≥5 标黄、≥10 标红，删推或改名一律标黄——这三条线是本机画的，来源只给计数、没有公布任何基准，也没说明计数含不含本币、统计了多长的时间窗口。连续发币、发完删推、频繁改名是批量发币和仿盘的常见做法，但同一团队的系列币、正常的账号改名，以及来源把不同账号误并成一个，都会计进同一个数字。这个标记是让你自己去看那个账号，不是对账号主人的认定`,
      'GMGN info.dev.twitter_* / info.link.twitter_username',
      {
        launched: launches,
        deleted: deletions,
        renames: renames ?? 0,
        handle: xAccount?.handle ?? null,
        history: renameLog.slice(0, 10),
      },
    );
  }

  // The source reports the holder count in two places and the two are taken at
  // slightly different moments, so they can disagree by a few addresses. Both
  // are kept and neither is averaged away; the headline is the top-level field
  // because it is the one the source's own token page shows.
  const holderCounts = [
    ['info.holder_count', number(info.holder_count)],
    ['info.stat.holder_count', number(info.stat?.holder_count)],
  ]
    .filter(([, value]) => value !== null && value >= 0)
    .map(([field, value]) => ({ field, value }));
  if (holderCounts.length) {
    const holders = holderCounts[0].value;
    const disagrees = holderCounts.some((o) => o.value !== holders);
    add(
      'holder-count',
      'holders',
      'info',
      '持有地址数',
      `来源报告 ${holders} 个持有地址${
        disagrees
          ? `（${holderCounts
              .map((o) => `${o.field.replace(/^info\./, '')} ${o.value}`)
              .join(' / ')} 两个字段不一致，未取平均）`
          : ''
      }。这是地址数不是人数——同一个人可以持有多个地址，交易池与合约地址是否计入来源没有说明。地址多少不参与风险判级：新币早期天然人少，地址多的老币一样会跑路。它的用处是给其余持仓比例一个分母`,
      'GMGN info.holder_count / info.stat.holder_count',
      { holders, observations: holderCounts },
    );
  }

  // Attention, not an on-chain fact. Filed under the market group rather than
  // social: the social group's only real evidence is the X sample, and letting
  // a page-view counter mark that category "covered" would report six of six
  // when the discussion was never checked at all.
  const visits = number(info.visiting_count);
  if (visits !== null && visits >= 0)
    add(
      'visiting-count',
      'liquidity',
      'info',
      'GMGN 浏览数',
      `来源站内浏览计数 ${visits}。来源没有公布统计窗口，也没有说明同一访客重复打开是否只算一次，所以这个数不能读成「${visits} 个人在看」。关注度不参与风险判级：热度可能是自然流量，也可能是买来的`,
      'GMGN info.visiting_count',
      { visits, window: null, deduplicated: null },
    );

  const imageDup = number(info.image_dup_count);
  if (imageDup !== null && imageDup >= 0)
    add(
      'image-dup',
      'contract',
      'info',
      '同图代币',
      `来源报告有 ${imageDup} 个代币在用同一张图片。同图常见于仿盘和批量发币，但也可能是同一团队的系列代币，或来源图片指纹的碰撞；来源没有公布比对方式与是否含本币，因此这里只显示数字，不据此判级`,
      'GMGN info.image_dup_count',
      { imageDup, includesSelf: null },
    );
  return findings;
}
