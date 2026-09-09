import {
  Activity,
  ArrowDownUp,
  Bot,
  Clock,
  Droplets,
  FileCode,
  Fingerprint,
  HelpCircle,
  KeyRound,
  Lock,
  MessageCircle,
  Percent,
  Pickaxe,
  UsersRound,
} from 'lucide-react';
import type { Finding, Report } from './types';

export type Tone = 'critical' | 'high' | 'medium' | 'info' | 'pass';
export type ChipTone = Tone | 'unknown';
type Found = Map<string, Finding>;

export const rank: Record<Tone, number> = {
  pass: 0,
  info: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
export const toneText: Record<ChipTone, string> = {
  critical: '严重风险',
  high: '高风险',
  medium: '需要警惕',
  info: '已取得观察值',
  pass: '来源未触发',
  unknown: '未核验',
};
const isTone = (s: string): s is Tone => s in rank;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const pct = (v: unknown, digits = 0) => {
  const n = num(v);
  return n === null ? null : `${(n * 100).toFixed(digits)}%`;
};
const compactUsd = (v: unknown) => {
  const n = num(v);
  return n === null
    ? null
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(n);
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const shortAge = (ms: number | null) => {
  if (ms === null || ms < 0) return '未知';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} 时` : `${Math.floor(hours / 24)} 天`;
};

const authorityIds = [
  'mint',
  'freeze',
  'blacklist',
  'default-frozen',
  'non-transferable',
  'close',
  'mutable-balance',
  'fee-upgrade',
  'hook-upgrade',
  'restore-owner',
  'change-balance',
  'pause-transfer',
  'sell-all',
];
const authorityShort: Record<string, string> = {
  mint: '可增发',
  freeze: '可冻结',
  blacklist: '黑名单',
  'default-frozen': '默认冻结',
  'non-transferable': '禁转账',
  close: '可关闭',
  'mutable-balance': '改余额',
  'fee-upgrade': '改费率',
  'hook-upgrade': '改钩子',
  'restore-owner': '可夺回',
  'change-balance': '改余额',
  'pause-transfer': '可暂停',
  'sell-all': '限制全卖',
};

type Slot = {
  key: string;
  name: string;
  Icon: typeof Lock;
  /** What the icon itself means. Shown as the first line of the tooltip. */
  hint: string;
  ids: string[];
  value: (f: Found, now: number) => string;
  passGate?: (f: Found) => boolean;
};

const slots: Slot[] = [
  {
    key: 'sell',
    name: '貔貅 / 卖出限制',
    Icon: ArrowDownUp,
    hint: '这个图标：买进去之后卖不卖得出来。来源模拟卖出失败、标记 rug 行为、或给出跑路评分时变色。',
    ids: ['sell', 'sell-conflict', 'rug-label', 'rug-ratio'],
    passGate: (f) => f.get('sell')?.severity === 'pass',
    value: (f) => {
      if (f.get('sell')?.severity === 'critical') return '不可卖';
      if (f.has('sell-conflict')) return '结果冲突';
      if (f.has('rug-label')) return 'Rug 标签';
      const rug = num(record(f.get('rug-ratio')?.value).ratio);
      if (rug !== null && rug > 0.1) return `跑路 ${(rug * 100).toFixed(0)}%`;
      return '未检出';
    },
  },
  {
    key: 'authority',
    name: '合约权限',
    Icon: KeyRound,
    hint: '这个图标：合约还留着哪些特权。增发、冻结、黑名单、改税这类权限只要还在，持有人的资产就可能被单方面改变。',
    ids: [...authorityIds, 'gmgn-privileges'],
    passGate: (f) => authorityIds.some((id) => f.get(id)?.severity === 'pass'),
    value: (f) => {
      const hits = authorityIds.filter((id) => {
        const s = f.get(id)?.severity;
        return s === 'high' || s === 'critical';
      });
      if (hits.length > 1) return `权限 ${hits.length}`;
      if (hits.length === 1) return authorityShort[hits[0]];
      const marks = f.get('gmgn-privileges');
      if (marks)
        return Array.isArray(marks.value)
          ? `标记 ${marks.value.length}`
          : '有标记';
      return '已撤销';
    },
  },
  {
    key: 'tax',
    name: '买 / 卖税',
    Icon: Percent,
    hint: '这个图标：买入税 / 卖出税。数字是来源返回的百分比；显示「可改税」时，现在的数字随时会变。',
    ids: ['tax', 'tax-conflict', 'change-tax', 'transfer-fee'],
    value: (f) => {
      if (f.get('change-tax')?.severity === 'high') return '可改税';
      const tax = f.get('tax');
      if (tax) {
        const v = record(tax.value);
        const side = (x: unknown) => {
          const n = num(x);
          return n === null ? '?' : String(Math.round(n * 100));
        };
        return `${side(v.buyTax)}/${side(v.sellTax)}%`;
      }
      const fee = num(f.get('transfer-fee')?.value);
      if (fee !== null) return `${(fee / 100).toFixed(fee % 100 ? 2 : 0)}%`;
      return f.has('tax-conflict') ? '来源冲突' : '有税率';
    },
  },
  {
    key: 'lp',
    name: 'LP 锁定 / 销毁',
    Icon: Lock,
    hint: '这个图标：流动性池被锁定或销毁的比例。锁仓数据是来源汇总，LP 持有人份额不等于实际仍锁份额。',
    ids: ['lp', 'lp-summary'],
    value: (f) => {
      const lp = record(f.get('lp')?.value);
      const locks = Array.isArray(lp.locks) ? lp.locks : [];
      if (locks.length) return `锁 ${locks.length} 条`;
      const pools = Array.isArray(lp.pools) ? lp.pools : [];
      const shares = pools
        .map((p) => num(record(p).lockedPct))
        .filter((v): v is number => v !== null && v >= 0 && v <= 100);
      if (shares.length) {
        const top = Math.max(...shares);
        return `锁 ${(top <= 1 ? top * 100 : top).toFixed(0)}%`;
      }
      const summary = record(f.get('lp-summary')?.value);
      const burn = pct(summary.burnRatio);
      if (burn) return `烧 ${burn}`;
      const locked = pct(summary.lockPercent);
      if (locked) return `锁* ${locked}`;
      if (summary.isLocked === false) return '未锁定';
      return '有记录';
    },
  },
  {
    key: 'depth',
    name: '流动性深度',
    Icon: Droplets,
    hint: '这个图标：当前流动性深度（美元）。深度越浅，越少的卖单就能砸穿价格。',
    ids: ['depth'],
    value: (f) => compactUsd(f.get('depth')?.value) ?? '有深度',
  },
  {
    key: 'age',
    name: '代币年龄',
    Icon: Clock,
    hint: '这个图标：合约创建到现在多久。不足 1 小时时，其余每一项指标的统计窗口都很短。年龄本身不判定风险，老币一样会跑路。',
    ids: ['age'],
    value: (f, now) => {
      const v = record(f.get('age')?.value);
      const createdAt = num(v.createdAt);
      if (createdAt !== null) return shortAge(now - createdAt);
      const openAt = num(v.openAt);
      if (openAt !== null) return `开 ${shortAge(now - openAt)}`;
      return shortAge(num(v.ageMs));
    },
  },
  {
    key: 'flow',
    name: '5 分钟盘面',
    Icon: Activity,
    hint: '这个图标：最近 5 分钟的涨跌幅与买 / 卖笔数。来源只给窗口首尾两点，看不到期间的 K 线形态；行情不参与风险判级，只作观察。',
    ids: ['flow-5m'],
    value: (f) => {
      const v = record(f.get('flow-5m')?.value);
      const change = num(v.change);
      const buys = num(v.buys);
      const sells = num(v.sells);
      const move =
        change === null
          ? null
          : `${change >= 0 ? '+' : ''}${(change * 100).toFixed(
              Math.abs(change) < 0.1 ? 1 : 0,
            )}%`;
      const flow =
        buys === null && sells === null
          ? null
          : `买${buys ?? '?'}卖${sells ?? '?'}`;
      return [move, flow].filter(Boolean).join(' ') || '有成交';
    },
  },
  {
    key: 'holders',
    name: 'Top10 集中度',
    Icon: UsersRound,
    hint: '这个图标：返回样本里前 10 个地址的持仓合计。已排除识别出的交易池和销毁地址，但样本不是全量持有人，剩下的地址里可能还有未识别的合约。',
    ids: ['holders', 'holders-reported', 'funders'],
    value: (f) => {
      const own = pct(f.get('holders')?.value);
      if (own) return own;
      const reported = pct(record(f.get('holders-reported')?.value).top10);
      if (reported) return `${reported}*`;
      if (f.has('funders')) return '共同出资';
      return '有样本';
    },
  },
  {
    key: 'wallets',
    name: '钱包分类',
    Icon: Fingerprint,
    hint: '这个图标：来源把持有人分成了哪几类钱包 —— 狙（狙击）、捆（捆绑 / 同源）、鼠（老鼠仓）。这是钱包个数不是比例，来源没有公布分母。',
    ids: ['wallet-tags'],
    value: (f) => {
      const v = record(f.get('wallet-tags')?.value);
      const counts = record(v.counts);
      const parts = (
        [
          ['sniper_wallets', '狙'],
          ['bundler_wallets', '捆'],
          ['rat_trader_wallets', '鼠'],
        ] as const
      )
        .map(([field, label]) => {
          const n = num(counts[field]);
          return n !== null && n > 0 ? `${label}${n}` : null;
        })
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
      if (Object.keys(counts).length) return '无标记';
      const size = num(record(v.sample).size);
      return size === null ? '有分类' : `样本 ${size}`;
    },
  },
  {
    key: 'traders',
    name: '机器人 / 同源交易',
    Icon: Bot,
    hint: '这个图标：来源统计的机器人钱包比例，以及诱捕、老鼠仓、捆绑交易占成交量的比例。统计窗口和分母来源都没披露，标签不等于对钱包身份或作恶的认定。',
    ids: ['wallet-profile', 'trader-profile'],
    value: (f) => {
      const wallet = record(f.get('wallet-profile')?.value);
      const bot = pct(wallet.botWalletRate);
      if (bot) return `Bot ${bot}`;
      const trader = record(f.get('trader-profile')?.value);
      const trap = pct(trader.entrapmentVolume);
      if (trap) return `诱捕 ${trap}`;
      const bundler = pct(trader.bundlerVolume);
      if (bundler) return `捆绑 ${bundler}`;
      const fresh = pct(wallet.freshWalletRate);
      if (fresh) return `新号 ${fresh}`;
      return '有画像';
    },
  },
  {
    key: 'dev',
    name: '开发者',
    Icon: Pickaxe,
    hint: '这个图标：创建者当前持仓，或它历史上发过多少个币。零持仓只反映来源识别到的地址，历史回撤也不等于开发者作恶。',
    ids: ['dev-current', 'dev'],
    value: (f) => {
      const current = record(f.get('dev-current')?.value);
      const creator = num(current.creatorShare);
      if (creator !== null)
        return `持 ${(creator * 100).toFixed(creator < 0.01 && creator > 0 ? 2 : 0)}%`;
      const team = pct(current.teamShare);
      if (team) return `队 ${team}`;
      const count = num(f.get('dev')?.value);
      if (count !== null) return `${count} 币`;
      return '有历史';
    },
  },
  {
    key: 'contract',
    name: '源码 / Owner / 代理',
    Icon: FileCode,
    hint: '这个图标：源码是否开源、Owner 是否已撤销、合约是不是可升级代理。Owner 归零不代表其他权限也撤了。',
    ids: [
      'code',
      'source',
      'source-conflict',
      'owner',
      'owner-conflict',
      'proxy',
    ],
    passGate: (f) => f.get('source')?.severity === 'pass',
    value: (f) => {
      if (f.get('code')?.severity === 'high') return '无字节码';
      if (f.has('source-conflict') || f.has('owner-conflict'))
        return '来源冲突';
      if (f.get('proxy')?.severity === 'high') return '可升级';
      if (f.get('source')?.severity === 'medium') return '未开源';
      if (f.has('proxy')) return '代理';
      if (f.get('source')?.severity === 'pass') return '已开源';
      return 'Owner';
    },
  },
  {
    key: 'social',
    name: 'X 讨论',
    Icon: MessageCircle,
    hint: '这个图标：X 上按合约地址检索的近 7 天讨论样本，最多 100 条。只看复读率、新号和发帖时间集中度，不能确认背后是不是真人。',
    ids: ['social'],
    value: (f) =>
      f.get('social')?.severity === 'medium' ? '有异常' : '有样本',
  },
];

export type Pill = {
  key: string;
  name: string;
  Icon: typeof Lock;
  tone: ChipTone;
  value: string;
  incomplete: boolean;
  /** Fixed explanation of what the icon stands for. */
  hint: string;
  /** Name plus graded state, e.g. `LP 锁定 / 销毁｜需要警惕`. */
  head: string;
  /** One evidence line per finding, worst first. */
  lines: string[];
};

const line = (f: Finding) => `${f.title}：${f.detail}（来源：${f.source}）`;

export const UNKNOWN_KEY = '__unknown';
export const PENDING_KEY = '__pending';

export function pendingPill(scanning: boolean): Pill {
  return {
    key: PENDING_KEY,
    name: '尚未产出报告',
    Icon: HelpCircle,
    tone: 'unknown',
    value: scanning ? '扫描中…' : '排队中',
    incomplete: true,
    hint: '这个图标：这个候选还没轮到深度检查，所有风险项都没有核验过。',
    head: '尚未产出报告｜未核验',
    lines: ['未核验不等于安全。深扫串行执行，候选多或来源变慢时排队会变长。'],
  };
}

export function buildPills(report: Report, now = Date.now()) {
  const byId: Found = new Map();
  const unknown: Finding[] = [];
  for (const f of report.findings) {
    if (f.severity === 'unknown') unknown.push(f);
    if (!byId.has(f.id)) byId.set(f.id, f);
  }
  const pills: Pill[] = [];
  for (const slot of slots) {
    const present = slot.ids
      .map((id) => byId.get(id))
      .filter((f): f is Finding => Boolean(f));
    const graded = present.filter((f) => isTone(f.severity));
    if (!graded.length) continue;
    const incomplete = present.some((f) => f.severity === 'unknown');
    let tone = graded
      .map((f) => f.severity as Tone)
      .reduce((a, b) => (rank[b] > rank[a] ? b : a));
    if (tone === 'pass' && (incomplete || !(slot.passGate?.(byId) ?? true)))
      tone = 'info';
    pills.push({
      key: slot.key,
      name: slot.name,
      Icon: slot.Icon,
      tone,
      value: slot.value(byId, now),
      incomplete,
      hint: slot.hint,
      head: `${slot.name}｜${toneText[tone]}${incomplete ? '（仍含未核验项）' : ''}`,
      lines: [
        ...graded
          .slice()
          .sort((a, b) => rank[b.severity as Tone] - rank[a.severity as Tone])
          .map(line),
        ...present
          .filter((f) => f.severity === 'unknown')
          .map((f) => `${f.title}：未核验 — ${f.detail}`),
      ],
    });
  }
  const unknownCount = report.evidenceSummary?.unknown ?? unknown.length;
  if (unknownCount > 0)
    pills.push({
      key: UNKNOWN_KEY,
      name: '未核验项',
      Icon: HelpCircle,
      tone: 'unknown',
      value: `${unknownCount} 项未核验`,
      incomplete: false,
      hint: '这个图标：来源没给出明确结果的检查项。灰色不是安全，只是没有证据。',
      head: `未核验项｜共 ${unknownCount} 项`,
      lines: [
        ...unknown.slice(0, 14).map(line),
        ...(unknown.length > 14 ? [`…以及另外 ${unknown.length - 14} 项`] : []),
        '条件触发的检查项在来源没有返回时不会进入这份清单，计数不代表已覆盖全部风险。完整逐条证据在导出的 JSON 报告里。',
      ],
    });
  return pills;
}
