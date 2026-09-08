'use client';
import {
  ArrowDownUp,
  Droplets,
  FileCode,
  HelpCircle,
  KeyRound,
  Lock,
  MessageCircle,
  Percent,
  Pickaxe,
  UsersRound,
} from 'lucide-react';
import type { Finding, Report } from './types';

type Tone = 'critical' | 'high' | 'medium' | 'info' | 'pass';
type Found = Map<string, Finding>;

const rank: Record<Tone, number> = {
  pass: 0,
  info: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
const toneText: Record<Tone, string> = {
  critical: '严重风险',
  high: '高风险',
  medium: '需要警惕',
  info: '已取得观察值',
  pass: '来源未触发',
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
  ids: string[];
  value: (f: Found, worst: Tone) => string;
  passGate?: (f: Found) => boolean;
};

const slots: Slot[] = [
  {
    key: 'sell',
    name: '貔貅 / 卖出限制',
    Icon: ArrowDownUp,
    ids: ['sell', 'sell-conflict', 'rug-label'],
    passGate: (f) => f.get('sell')?.severity === 'pass',
    value: (f) => {
      if (f.get('sell')?.severity === 'critical') return '不可卖';
      if (f.has('sell-conflict')) return '结果冲突';
      if (f.has('rug-label')) return 'Rug 标签';
      return '未检出';
    },
  },
  {
    key: 'authority',
    name: '合约权限',
    Icon: KeyRound,
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
    ids: ['depth'],
    value: (f) => compactUsd(f.get('depth')?.value) ?? '有深度',
  },
  {
    key: 'holders',
    name: 'Top10 集中度',
    Icon: UsersRound,
    ids: [
      'holders',
      'holders-reported',
      'funders',
      'trader-profile',
      'wallet-profile',
    ],
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
    key: 'dev',
    name: '开发者',
    Icon: Pickaxe,
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
    ids: ['social'],
    value: (f) =>
      f.get('social')?.severity === 'medium' ? '有异常' : '有样本',
  },
];

export type Pill = {
  key: string;
  name: string;
  Icon: typeof Lock;
  tone: Tone;
  value: string;
  incomplete: boolean;
  title: string;
};

const line = (f: Finding) => `${f.title}：${f.detail}（来源：${f.source}）`;

export function buildPills(report: Report) {
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
      value: slot.value(byId, tone),
      incomplete,
      title: [
        `${slot.name}｜${toneText[tone]}${incomplete ? '（仍含未核验项）' : ''}`,
        ...graded
          .slice()
          .sort((a, b) => rank[b.severity as Tone] - rank[a.severity as Tone])
          .map(line),
        ...present
          .filter((f) => f.severity === 'unknown')
          .map((f) => `${f.title}：未核验 — ${f.detail}`),
      ].join('\n'),
    });
  }
  return {
    pills,
    unknown: report.evidenceSummary?.unknown ?? unknown.length,
    unknownTitle: [
      '这些项目没有取得足够证据，未核验不等于安全：',
      ...unknown.slice(0, 14).map(line),
      unknown.length > 14 ? `…以及另外 ${unknown.length - 14} 项` : '',
      '条件触发的检查项在来源没有返回时不会进入这份清单，计数不代表已覆盖全部风险。完整逐条证据在导出的 JSON 报告里。',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function RiskPills({
  report,
  scanning,
  stale,
}: {
  report?: Report;
  scanning: boolean;
  stale: boolean;
}) {
  if (!report)
    return (
      <div className="risk-strip">
        <span
          className="risk-chip unknown"
          title="该候选尚未产出报告，所有风险项都未核验。未核验不等于安全。"
        >
          <HelpCircle size={12} />
          {scanning ? '扫描中…' : '排队中'}
        </span>
      </div>
    );
  const { pills, unknown, unknownTitle } = buildPills(report);
  return (
    <div className={`risk-strip${stale ? ' risk-strip-stale' : ''}`}>
      {pills.map((p) => (
        <span
          key={p.key}
          className={`risk-chip ${p.tone}${p.incomplete ? ' is-incomplete' : ''}`}
          title={p.title}
          aria-label={`${p.name}：${p.value}，${toneText[p.tone]}`}
        >
          <p.Icon size={12} />
          <b>{p.value}</b>
        </span>
      ))}
      {unknown > 0 && (
        <span className="risk-chip unknown risk-unknown" title={unknownTitle}>
          <HelpCircle size={12} />
          <b>{unknown} 项未核验</b>
        </span>
      )}
      {stale && <span className="risk-stale-tag">报告已过期，等待重查</span>}
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
      <span>角标 ? ＝ 该项仍含未核验内容 · 悬停任意标记看原始证据与来源</span>
    </div>
  );
}
