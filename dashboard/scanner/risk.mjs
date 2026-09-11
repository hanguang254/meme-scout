import { buildProfileFindings, normalizeXAccount } from './profile.mjs';
import { arr, flag, fraction, number } from './values.mjs';
export { flag, fraction, number } from './values.mjs';
export const CHAINS = {
  sol: { label: 'Solana', dex: 'solana' },
  bsc: { label: 'BNB Chain', dex: 'bsc', id: 56 },
  base: { label: 'Base', dex: 'base', id: 8453 },
  eth: { label: 'Ethereum', dex: 'ethereum', id: 1 },
  robinhood: { label: 'Robinhood', dex: 'robinhood', id: 4663 },
};
export function validAddress(chain, address) {
  if (!CHAINS[chain] || typeof address !== 'string') return false;
  if (chain !== 'sol') return /^0x[\da-fA-F]{40}$/.test(address);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of address) n = n * 58n + BigInt(alphabet.indexOf(c));
  let bytes = 0;
  for (let v = n; v > 0; v >>= 8n) bytes++;
  return bytes + (address.match(/^1*/)?.[0].length || 0) === 32;
}
export function selectCandidates(rows, config) {
  let unknownCap = 0;
  const selected = rows.filter((r) => {
    if (number(r.marketCap) === null) {
      unknownCap++;
      return false;
    }
    return (
      r.marketCap >= config.minCap &&
      r.marketCap <= config.maxCap &&
      number(r.liquidity) !== null &&
      r.liquidity >= config.minLiquidity
    );
  });
  return { selected, unknownCap };
}
export const SORTS = ['heat', 'new'];
// `heat` is the order discovery already produced. `new` re-sorts by pool
// creation time without inventing one for the rows that lack it: those keep the
// index they held under `heat`, and only the dated rows compete for the slots
// left between them. Nothing here reads the clock, so the order is stable
// between polls and an absent timestamp never reads as brand new.
export function orderCandidates(rows, sort) {
  if (sort !== 'new') return rows;
  const dated = [];
  const pinned = new Map();
  rows.forEach((row, index) => {
    const at = number(row?.createdAt);
    if (at === null) pinned.set(index, row);
    else dated.push({ row, at, index });
  });
  if (!dated.length) return rows;
  dated.sort((a, b) => b.at - a.at || a.index - b.index);
  let next = 0;
  return rows.map((_, index) =>
    pinned.has(index) ? pinned.get(index) : dated[next++].row,
  );
}
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const precisePct = (v) => (v === null ? '未知' : `${(v * 100).toFixed(2)}%`);
const first = (...v) => v.find((x) => x !== null && x !== undefined);
const combined = (...values) =>
  values.some((v) => v === true)
    ? true
    : values.some((v) => v === false)
      ? false
      : null;
export function analyzeSocial(raw, now = Date.now()) {
  const byId = new Map();
  for (const p of arr(raw?.data)) if (p.id && p.text) byId.set(p.id, p);
  const posts = [...byId.values()],
    users = new Map(arr(raw?.includes?.users).map((u) => [u.id, u]));
  const authors = new Set(posts.map((p) => p.author_id).filter(Boolean));
  const normalize = (t) =>
    t
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, '')
      .replace(/0x[\da-f]{40}/g, '[ca]')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const normalized = posts.map((p) => normalize(p.text)).filter(Boolean);
  const texts = new Set(normalized);
  const duplicateRatio = normalized.length
    ? 1 - texts.size / normalized.length
    : null;
  const ages = [...authors]
    .map((id) => Date.parse(users.get(id)?.created_at))
    .filter((n) => Number.isFinite(n) && n <= now);
  const young = ages.filter((d) => (now - d) / 86400000 < 30).length;
  const buckets = new Map();
  for (const p of posts) {
    const t = Date.parse(p.created_at);
    if (Number.isFinite(t)) {
      const b = Math.floor(t / 60000);
      buckets.set(b, (buckets.get(b) || 0) + 1);
    }
  }
  const timed = [...buckets.values()].reduce((a, b) => a + b, 0);
  const burstRatio = timed ? Math.max(...buckets.values()) / timed : null;
  const sufficient = posts.length >= 20 && authors.size >= 10;
  const missingChecks = [];
  if (normalized.length < 20) missingChecks.push('有效正文');
  if (ages.length < 10 || ages.length < authors.size / 2)
    missingChecks.push('账号年龄');
  if (timed < 20) missingChecks.push('发帖时间');
  const signals = [];
  if (duplicateRatio !== null && duplicateRatio >= 0.35)
    signals.push('重复或高度模板化文本较多');
  if (ages.length >= 10 && young / ages.length >= 0.5)
    signals.push('可核验作者中，新注册账号占比较高');
  if (timed >= 20 && burstRatio >= 0.5)
    signals.push('样本发布时间集中在同一分钟');
  return {
    posts: posts.length,
    authors: authors.size,
    duplicateRatio,
    accountAgeCoverage: ages.length,
    youngAccountRatio: ages.length ? young / ages.length : null,
    burstRatio,
    verdict: !sufficient
      ? '样本不足'
      : signals.length
        ? '存在可疑传播模式'
        : missingChecks.length
          ? '字段不足'
          : '当前样本未触发规则',
    signals,
    missingChecks,
    window: '最近 7 天，最多 100 条，按合约地址检索；非随机样本',
    limitations:
      '这些统计不能验证真人身份。新号、复读与集中发布也可能来自正常活动；无搜索结果不代表无人讨论。',
    examples: posts.slice(0, 12).map((p) => ({
      id: p.id,
      text: p.text,
      author: users.get(p.author_id)?.username || p.author_id,
      createdAt: p.created_at,
      url: `https://x.com/i/status/${p.id}`,
    })),
  };
}
export function evaluateRisk(candidate, data, sources = []) {
  const findings = [];
  const add = (id, group, severity, title, detail, source, value = null) =>
    findings.push({ id, group, severity, title, detail, source, value });
  const sec = data.security || {},
    gp = data.goplus || {},
    info = data.info || {},
    rug = data.rugcheck || {};
  const sol = candidate.chain === 'sol';
  const privileges = arr(sec.privileges)
    .filter((v) => typeof v === 'string')
    .slice(0, 40);
  const privilege = (name) => (privileges.includes(name) ? true : null);
  const sourceError = (name) =>
    sources.find(
      (s) =>
        s.name === name &&
        ['error', 'unconfigured', 'deferred'].includes(s.status),
    )?.error;
  const missingContract = (id, title) => {
    if (id === 'sell-all' && flag(gp.is_in_dex) === false)
      return 'GoPlus 未识别可检测交易池，未返回全部卖出限制结果；不能当作可卖';
    if (!sol && flag(gp.is_open_source) === false)
      return `GoPlus 未取得此币源码，未返回“${title}”检查结果；GMGN 也没有对应的明确结果。未列出权限标记不等于不存在权限`;
    if (!sol && flag(gp.is_proxy) === true)
      return `GoPlus 识别为代理，但未提供“${title}”结果；需要核验实现合约与当前状态`;
    return `${sourceError('GoPlus') ? `GoPlus：${sourceError('GoPlus')}；` : ''}${sourceError('GMGN 合约') ? `GMGN：${sourceError('GMGN 合约')}；` : ''}来源未返回“${title}”的明确字段，尚未完成此项核验`;
  };
  const knownInfo = typeof info.symbol === 'string' && info.symbol.length > 0;
  const check = (id, title, v, source, detail) =>
    add(
      id,
      'contract',
      v === null ? 'unknown' : v ? 'high' : 'pass',
      title,
      v === null ? missingContract(id, title) : detail,
      source,
      v,
    );
  if (sol) {
    const token = rug.token || {};
    const mint = combined(
      flag(gp.mintable?.status),
      Object.hasOwn(token, 'mintAuthority')
        ? token.mintAuthority !== null
        : null,
      knownInfo && flag(sec.renounced_mint) !== null
        ? !flag(sec.renounced_mint)
        : null,
    );
    const freeze = combined(
      flag(gp.freezable?.status),
      Object.hasOwn(token, 'freezeAuthority')
        ? token.freezeAuthority !== null
        : null,
      knownInfo && flag(sec.renounced_freeze_account) !== null
        ? !flag(sec.renounced_freeze_account)
        : null,
    );
    check(
      'mint',
      '增发权限',
      mint,
      'GoPlus / RugCheck / GMGN',
      mint ? '增发权限仍存在' : '该来源报告增发权限已撤销',
    );
    check(
      'freeze',
      '冻结权限',
      freeze,
      'GoPlus / RugCheck / GMGN',
      freeze ? '冻结权限仍存在，可影响转账或卖出' : '该来源报告冻结权限已撤销',
    );
    for (const [id, title, v] of [
      ['non-transferable', '禁止转账', flag(gp.non_transferable)],
      ['close', '可关闭 Mint', flag(gp.closable?.status)],
      [
        'mutable-balance',
        '余额修改权限',
        flag(gp.balance_mutable_authority?.status),
      ],
      ['fee-upgrade', '可修改转账费', flag(gp.transfer_fee_upgradable?.status)],
      [
        'hook-upgrade',
        '可升级转账钩子',
        flag(gp.transfer_hook_upgradable?.status),
      ],
    ])
      check(
        id,
        title,
        v,
        'GoPlus',
        v ? '来源检测到相应权限或限制' : '来源未检出此项',
      );
    if (number(gp.default_account_state) === 2)
      add(
        'default-frozen',
        'contract',
        'high',
        '默认账户冻结',
        'Token-2022 默认账户状态为冻结',
        'GoPlus',
      );
    const fee = number(gp.transfer_fee?.current_fee_rate?.fee_rate);
    if (fee !== null)
      add(
        'transfer-fee',
        'honeypot',
        fee > 1000 ? 'high' : 'info',
        'Solana 转账费',
        `${(fee / 100).toFixed(2)}%，来源单位为 bps；不等于买卖模拟税`,
        'GoPlus',
        fee,
      );
    for (const risk of arr(rug.risks).slice(0, 8))
      add(
        `rug-${findings.length}`,
        'contract',
        risk.level === 'danger' ? 'high' : 'medium',
        String(risk.name || 'RugCheck 风险'),
        String(risk.description || ''),
        'RugCheck',
      );
  } else {
    check(
      'mint',
      '可增发',
      flag(gp.is_mintable),
      'GoPlus',
      flag(gp.is_mintable) ? '合约存在增发能力' : '来源未检出增发能力',
    );
    check(
      'blacklist',
      '黑名单能力',
      combined(
        flag(gp.is_blacklisted),
        flag(sec.is_blacklist),
        flag(sec.blacklist),
      ),
      'GoPlus / GMGN',
      '该字段只描述来源检测到的黑名单功能',
    );
    const explorer = data.explorer || {};
    const runtimeProxy =
      data.contract?.address?.toLowerCase() === candidate.address?.toLowerCase()
        ? data.contract?.minimalProxy
        : null;
    const structure = explorer.proxyType
      ? {
          ...explorer,
          provider: 'Blockscout 合约结构',
          label: 'Blockscout 标记',
        }
      : runtimeProxy
        ? {
            proxyType: runtimeProxy.type,
            implementations: [{ address: runtimeProxy.implementation }],
            block: data.contract.block,
            runtime: runtimeProxy.runtime,
            provider: 'Robinhood RPC 运行时代码',
            label: '原 CA 运行时代码精确匹配',
          }
        : null;
    if (structure) {
      const clone = ['eip1167', 'minimal-clone-0age'].includes(
        structure.proxyType,
      );
      add(
        'proxy',
        'contract',
        clone ? 'info' : 'medium',
        '代理结构',
        `${structure.label} ${structure.proxyType}${clone ? ' 最小克隆；不能仅凭这个类型判定可升级，实现合约仍需核验' : '；具体升级能力和控制角色仍需核验'}。实现地址：${
          arr(structure.implementations)
            .map((i) => i.address)
            .join('、') || '未返回'
        }`,
        structure.provider,
        structure,
      );
    } else
      check(
        'proxy',
        '代理 / 可升级',
        flag(gp.is_proxy),
        'GoPlus',
        '来源报告代理检查结果；是否能够升级、由谁控制仍需单独核验',
      );
    for (const [id, title, key, tag] of [
      ['hidden-owner', '隐藏 Owner', 'hidden_owner', 'hidden_owner'],
      [
        'restore-owner',
        '可恢复所有权',
        'can_take_back_ownership',
        'take_back_ownership',
      ],
      ['change-balance', '可修改余额', 'owner_change_balance'],
      ['pause-transfer', '可暂停转账', 'transfer_pausable', 'pausable'],
      ['change-tax', '可修改税率', 'slippage_modifiable'],
      ['sell-all', '无法全部卖出', 'cannot_sell_all'],
    ])
      check(
        id,
        title,
        combined(flag(gp[key]), privilege(tag)),
        privilege(tag)
          ? `GMGN privileges.${tag}${flag(gp[key]) === false ? ' / GoPlus（结果冲突）' : ''}`
          : 'GoPlus',
        privilege(tag)
          ? `GMGN 返回 ${tag} 权限标记${flag(gp[key]) === false ? '；与 GoPlus 的未检出结果冲突，保留风险标记' : ''}；属于来源检测结果，未独立审计权限调用路径`
          : flag(gp[key])
            ? '来源检测到相应能力或限制'
            : '来源未检出此项',
      );
    if (privileges.length)
      add(
        'gmgn-privileges',
        'contract',
        'info',
        'GMGN 权限原始标记',
        `${privileges.join('、')}${privileges.includes('max_tx_amount') ? '；含交易数量限制标记' : ''}。未映射的标记保留原文，不猜测具体权限；空列表也不构成逐项通过`,
        'GMGN privileges',
        privileges,
      );
    const openObservations = [
      { source: 'GoPlus', value: flag(gp.is_open_source) },
      {
        source: 'GMGN',
        value: first(flag(sec.is_open_source), flag(sec.open_source)),
      },
      {
        source: 'Blockscout',
        value: explorer.sourceAvailable === true ? true : null,
      },
    ].filter((o) => o.value !== undefined && o.value !== null);
    const sourceConflict =
      openObservations.some((o) => o.value) &&
      openObservations.some((o) => !o.value);
    const open = sourceConflict ? undefined : openObservations[0]?.value;
    add(
      'source',
      'contract',
      sourceConflict
        ? 'medium'
        : open === undefined
          ? 'unknown'
          : open
            ? 'pass'
            : 'medium',
      '源码验证',
      sourceConflict
        ? `来源结果不一致：${openObservations.map((o) => `${o.source}=${o.value ? '已验证' : '未验证'}`).join('；')}，不能合并成单一通过或未验证`
        : open === undefined
          ? '未取得源码验证结果'
          : open
            ? '来源报告源码已验证；不等于代码已审计'
            : '源码未验证',
      'GoPlus / GMGN',
      openObservations,
    );
    if (sourceConflict)
      add(
        'source-conflict',
        'contract',
        'medium',
        '源码状态来源冲突',
        '保留各来源原始判断；索引、代理实现与验证时点可能不同，需要查看具体合约证据',
        'GoPlus / GMGN / Blockscout',
        openObservations,
      );
    const own = first(
      flag(sec.is_renounced),
      flag(sec.owner_renounced),
      flag(sec.renounced),
    );
    const chainState = data.contract;
    const rpcOwner =
      chainState?.codePresent === true &&
      chainState.address?.toLowerCase() === candidate.address?.toLowerCase() &&
      validAddress(candidate.chain, chainState.owner)
        ? chainState.owner
        : null;
    add(
      'owner',
      'contract',
      own === undefined
        ? rpcOwner
          ? 'info'
          : 'unknown'
        : own
          ? 'info'
          : 'medium',
      'Owner 权限',
      (own === undefined
        ? rpcOwner
          ? `链上 owner() 返回${/^0x0{40}$/i.test(rpcOwner) ? '零地址' : '非零地址'}，不能据此推断其他管理角色或权限已撤销`
          : `GMGN 未返回明确 owner 状态${chainState?.ownerError ? `；${chainState.ownerError}` : ''}`
        : own
          ? '来源报告 owner 已放弃；其他权限仍独立检查'
          : 'GMGN 报告 owner 尚未放弃') +
        (rpcOwner
          ? `；原代币 CA 在区块 ${chainState.block} 的 owner() = ${rpcOwner}`
          : ''),
      rpcOwner ? 'GMGN / Robinhood RPC eth_call' : 'GMGN',
      {
        gmgnRenounced: own ?? null,
        rpcOwner,
        block: chainState?.block ?? null,
      },
    );
    if (chainState?.codePresent === false)
      add(
        'code',
        'contract',
        'high',
        '链上未发现合约字节码',
        `RPC 在区块 ${chainState.block} 对原 CA 返回空代码，不能确认其为当前链上的有效代币合约`,
        'Robinhood RPC eth_getCode',
        chainState,
      );
    if (rpcOwner && own !== undefined && own !== /^0x0{40}$/i.test(rpcOwner))
      add(
        'owner-conflict',
        'contract',
        'medium',
        'Owner 状态来源不一致',
        'GMGN 放弃状态与原 CA 的 owner() 返回地址不一致；保留两个观察，不据此确认全部权限已撤销',
        'GMGN / Robinhood RPC',
        { gmgnRenounced: own, rpcOwner, block: chainState.block },
      );
  }
  const hp = data.honeypot || {};
  const danger =
    combined(
      flag(sec.is_honeypot),
      flag(sec.honeypot),
      flag(sec.can_not_sell),
    ) === true ||
    flag(gp.is_honeypot) === true ||
    flag(hp.honeypotResult?.isHoneypot) === true;
  const simulated =
    hp.simulationSuccess === true &&
    flag(hp.honeypotResult?.isHoneypot) === false;
  const reported =
    flag(gp.is_honeypot) === false ||
    (!sol && first(flag(sec.is_honeypot), flag(sec.honeypot)) === false);
  add(
    'sell',
    'honeypot',
    danger ? 'critical' : simulated || reported ? 'pass' : 'unknown',
    '貔貅 / 卖出限制',
    danger
      ? '至少一个来源报告无法卖出 / 貔貅风险，请查看原始证据'
      : simulated
        ? '本次来源模拟未检出貔貅；不保证实际交易和未来状态'
        : reported
          ? '来源未检出貔貅；未取得独立成功卖出模拟'
          : sol
            ? 'Solana 未执行真实卖出模拟；冻结、扩展和转账限制需分别核验'
            : hp.simulationSuccess === false
              ? '卖出模拟失败，不能解释为可卖'
              : `未取得可用卖出检测${flag(gp.is_in_dex) === false ? '；GoPlus 未识别可检测交易池' : ''}${candidate.chain === 'robinhood' ? '；当前 Robinhood 未接入独立卖出模拟' : ''}。can_sell/can_not_sell 均为 0 不代表模拟通过`,
    'GMGN / GoPlus / Honeypot.is',
  );
  const observations = { buy: [], sell: [] };
  for (const [provider, obj] of [
    ['GoPlus', gp],
    ['GMGN', sec],
  ])
    for (const side of ['buy', 'sell']) {
      const value = fraction(obj[`${side}_tax`]);
      if (value !== null) observations[side].push({ provider, value });
    }
  if (hp.simulationSuccess === true)
    for (const side of ['buy', 'sell']) {
      const v = number(hp.simulationResult?.[`${side}Tax`]);
      if (v !== null && v >= 0 && v <= 100)
        observations[side].push({ provider: 'Honeypot.is', value: v / 100 });
    }
  const buyTax = observations.buy.length
    ? Math.max(...observations.buy.map((o) => o.value))
    : undefined;
  const sellTax = observations.sell.length
    ? Math.max(...observations.sell.map((o) => o.value))
    : undefined;
  if (!sol && (buyTax !== undefined || sellTax !== undefined))
    add(
      'tax',
      'honeypot',
      (sellTax ?? 0) > 0.1 ? 'high' : (buyTax ?? 0) > 0.05 ? 'medium' : 'info',
      '代币买 / 卖税率',
      `各来源最高观察值：买 ${buyTax === undefined ? '未知' : pct(buyTax)} · 卖 ${sellTax === undefined ? '未知' : pct(sellTax)}；税率可能变化。网页“总税率”的完整交易费率当前未取得；这里的代币税不能代替总交易成本`,
      'GoPlus / GMGN / Honeypot.is',
      { buyTax, sellTax, observations },
    );
  if (
    !sol &&
    Object.values(observations).some(
      (list) =>
        list.length > 1 &&
        Math.max(...list.map((o) => o.value)) -
          Math.min(...list.map((o) => o.value)) >
          0.005,
    )
  )
    add(
      'tax-conflict',
      'honeypot',
      'medium',
      '税率来源冲突',
      JSON.stringify(observations) +
        '；池、时点与模拟条件可能不同，不能按较低税率判定',
      '多来源',
    );
  if (
    (flag(gp.is_honeypot) === true || flag(sec.is_honeypot) === true) &&
    simulated
  )
    add(
      'sell-conflict',
      'honeypot',
      'high',
      '卖出检测来源冲突',
      '存在风险告警，同时另一个来源模拟未触发；保留两者，需进一步核验',
      '多来源',
    );
  if (fraction(candidate.rugRatio) !== null && candidate.rugRatio >= 0.3)
    add(
      'rug-label',
      'honeypot',
      candidate.rugRatio >= 0.5 ? 'high' : 'medium',
      'GMGN Rug 风险标签',
      `来源标签 ${candidate.rugRatio}（0–1），不是统计概率，也不等于已经跑路`,
      'GMGN 热门榜',
      candidate.rugRatio,
    );
  const locks = [];
  const now = Date.now() / 1000;
  for (const holder of arr(gp.lp_holders)) {
    const share = fraction(holder.percent);
    if (share === null) continue;
    const active = arr(holder.locked_detail).filter(
      (d) => number(d.end_time) !== null && Number(d.end_time) > now,
    );
    if (flag(holder.is_locked) === true && active.length)
      locks.push({
        address: holder.address,
        holderShare: share,
        activeLockedShare: null,
        activeRecords: active.map((d) => ({
          amount: d.amount,
          endTime: d.end_time,
        })),
        expires: Math.min(...active.map((d) => Number(d.end_time))),
        source: 'GoPlus LP holders',
      });
  }
  const pools = arr(rug.markets).map((m) => ({
    address: m.pubkey || m.marketType,
    lockedPct: number(m.lp?.lpLockedPct),
    liquidity: number(m.lp?.quoteUSD),
    source: 'RugCheck',
  }));
  const burn = fraction(sec.burn_ratio);
  const lockSummary = sec.lock_summary || {};
  const locked = flag(lockSummary.is_locked),
    lockPercent = fraction(lockSummary.lock_percent),
    leftLockPercent = fraction(lockSummary.left_lock_percent);
  const poolType = info.pool?.exchange || '';
  const isV4 = /(?:uniswap_)?v4/i.test(poolType);
  // Preserve rows rather than sum them: categories/pools can overlap and V4
  // position ownership cannot be inferred from this aggregate response.
  const lockRows = arr(lockSummary.lock_detail)
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .slice(0, 20);
  const detailObservations = [
    ...new Map(
      lockRows.map((row) => [
        JSON.stringify(row, Object.keys(row).sort()),
        row,
      ]),
    ).values(),
  ].map((row) => ({
    share: fraction(row.percent),
    scope: typeof row.pool === 'string' ? row.pool : null,
    isBlackhole: flag(row.is_blackhole),
  }));
  const detailText = detailObservations
    .map(
      (row, i) =>
        `明细 ${i + 1}：${row.isBlackhole === true ? '黑洞' : row.isBlackhole === false ? '非黑洞' : '分类未知'}条目比例 ${precisePct(row.share)}`,
    )
    .join('；');
  if (
    locked !== null ||
    lockPercent !== null ||
    burn !== null ||
    detailObservations.length
  )
    add(
      'lp-summary',
      'liquidity',
      locked !== null ||
        lockPercent !== null ||
        burn !== null ||
        detailObservations.some((row) => row.share !== null)
        ? 'info'
        : 'unknown',
      'GMGN 烧池 / 锁仓明细（来源报告）',
      `${detailText ? `GMGN ${detailText}。` : ''}GMGN 标注${locked === false ? '未锁定' : locked === true ? '存在锁定' : '锁定状态未知'}；lock_percent ${lockPercent === null ? '未知' : pct(lockPercent)}${burn !== null ? `；burn_ratio ${pct(burn)}` : ''}。${detailObservations.length ? '明细与汇总可能口径不同，保留原值；不同条目不相加。' : ''}${isV4 ? '当前主池为 Uniswap V4；' : ''}尚缺头寸持有人、控制权与到期证据，不能当作全池已锁或全部可撤`,
      'GMGN security.lock_summary',
      {
        isLocked: locked,
        lockPercent,
        leftLockPercent,
        burnRatio: burn,
        poolType,
        poolId: info.pool?.pool_address || null,
        detailObservations,
        details: lockRows,
      },
    );
  add(
    'lp',
    'liquidity',
    locks.length || pools.some((p) => p.lockedPct !== null)
      ? 'info'
      : 'unknown',
    'LP 锁定 / 销毁证据',
    locks.length
      ? `有 ${locks.length} 条有效期内 LP 锁定记录，仅覆盖来源返回的 LP 持有人；不是全池保证`
      : pools.some((p) => p.lockedPct !== null)
        ? 'RugCheck 提供部分池的锁定比例；锁仓对象和到期时间仍需复核'
        : isV4
          ? '当前主池为 Uniswap V4；缺少流动性头寸的持有人、控制权与锁定期限证据。传统 LP 代币比例不能代替这些检查'
          : `未取得带锁仓对象与到期时间的完整 LP 证据${burn !== null ? `；GMGN 报告 burn_ratio ${pct(burn)}，不能据此推断全池已锁` : ''}`,
    'GoPlus / RugCheck / GMGN',
    { locks, pools, burnRatio: burn },
  );
  const liquidity = number(candidate.liquidity);
  add(
    'depth',
    'liquidity',
    liquidity === null
      ? 'unknown'
      : liquidity < 10000
        ? 'high'
        : liquidity < 50000
          ? 'medium'
          : 'info',
    '流动性深度',
    liquidity === null
      ? '未取得流动性'
      : `当前主池/榜单约 $${Math.round(liquidity).toLocaleString()}；流动性深度不等于锁仓`,
    candidate.source,
    liquidity,
  );
  const key = (a) => (sol ? String(a) : String(a).toLowerCase());
  const poolAddresses = new Set(arr(gp.dex).map((d) => key(d.pair)));
  if (info.pool?.pool_address) poolAddresses.add(key(info.pool.pool_address));
  for (const m of arr(rug.markets))
    if (m.pubkey) poolAddresses.add(key(m.pubkey));
  const burned = new Set([
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
  ]);
  let rawWallets = arr(data.holders?.list).map((h) => ({
    address: h.address,
    share: fraction(h.amount_percentage),
    tags: arr(h.tags).concat(arr(h.maker_token_tags)),
    funder: h.native_transfer?.address || null,
    isPool: h.addr_type === 2,
  }));
  let holderSource = 'GMGN';
  if (!rawWallets.some((w) => w.share !== null)) {
    rawWallets = arr(gp.holders).map((h) => ({
      address: h.account || h.address,
      share: fraction(h.percent),
      tags: [],
      funder: null,
      isPool: false,
    }));
    holderSource = 'GoPlus';
  }
  if (!rawWallets.some((w) => w.share !== null)) {
    rawWallets = arr(rug.topHolders).map((h) => ({
      address: h.owner || h.address,
      share: number(h.pct) !== null ? fraction(Number(h.pct) / 100) : null,
      tags: [],
      funder: null,
      isPool: false,
    }));
    holderSource = 'RugCheck';
  }
  const excluded = rawWallets.filter(
    (h) =>
      h.isPool ||
      poolAddresses.has(key(h.address)) ||
      burned.has(key(h.address)),
  );
  const grouped = new Map();
  for (const w of rawWallets) {
    if (!w.address || excluded.includes(w)) continue;
    const address = key(w.address);
    const prev = grouped.get(address);
    if (prev) {
      if (w.share !== null) prev.share = (prev.share ?? 0) + w.share;
    } else grouped.set(address, { ...w });
  }
  const wallets = [...grouped.values()].map((w) => ({
    ...w,
    share: fraction(w.share),
  }));
  wallets.sort((a, b) => (b.share ?? -1) - (a.share ?? -1));
  const measured = wallets.filter((w) => w.share !== null);
  const top10 = measured.length
    ? measured.slice(0, 10).reduce((n, h) => n + h.share, 0)
    : null;
  const funders = new Map();
  for (const w of wallets)
    if (w.funder) {
      const a = funders.get(w.funder) || [];
      a.push(w.address);
      funders.set(w.funder, a);
    }
  const clusters = [...funders]
    .filter(([, w]) => w.length > 1)
    .map(([address, w]) => ({ address, wallets: w }));
  add(
    'holders',
    'holders',
    top10 === null
      ? 'unknown'
      : top10 > 0.5
        ? 'high'
        : top10 > 0.3
          ? 'medium'
          : 'info',
    '钱包分布',
    top10 === null
      ? sourceError('GMGN 持有人')
        ? `未取得持仓样本：${sourceError('GMGN 持有人')}`
        : '未取得持仓样本'
      : `返回样本中前 ${Math.min(measured.length, 10)} 个地址合计 ${pct(top10)}；排除 ${excluded.length} 个已标注池/销毁地址。其余地址可能仍含合约，样本不是全量持有人`,
    holderSource,
    top10,
  );
  if (clusters.length)
    add(
      'funders',
      'holders',
      'medium',
      '共同出资线索',
      `${clusters.length} 组样本共享首次出资地址，可能是交易所或服务商，不能认定同一控制人`,
      'GMGN',
      clusters,
    );
  const stat = info.stat || {};
  const reportedTop10 = [
    ['info.stat.top_10_holder_rate', fraction(stat.top_10_holder_rate)],
    ['security.top_10_holder_rate', fraction(sec.top_10_holder_rate)],
  ]
    .filter(([, value]) => value !== null)
    .map(([field, value]) => ({ field, value }));
  if (reportedTop10.length) {
    const top10 = Math.max(...reportedTop10.map((o) => o.value));
    add(
      'holders-reported',
      'holders',
      top10 > 0.5 ? 'high' : top10 > 0.3 ? 'medium' : 'info',
      'GMGN Top 10 持仓',
      `GMGN 报告前 10 持仓 ${precisePct(top10)}${reportedTop10.some((o) => o.value !== top10) ? '（字段不一致，显示最高观察值）' : ''}。这是来源统计，与本机排除池地址后重算的有限样本分别展示`,
      'GMGN info.stat / security',
      { top10, observations: reportedTop10 },
    );
  }
  const entrapmentVolume = fraction(stat.top_entrapment_trader_percentage);
  const ratVolume = fraction(stat.top_rat_trader_percentage);
  const bundlerVolume = fraction(stat.top_bundler_trader_percentage);
  const profileAlerts = [];
  if (entrapmentVolume !== null && entrapmentVolume > 0.3)
    profileAlerts.push('诱捕标签成交量超过 30%');
  if (ratVolume !== null && ratVolume > 0.15)
    profileAlerts.push('老鼠仓标签成交量超过 15%');
  if ([entrapmentVolume, ratVolume, bundlerVolume].some((v) => v !== null))
    add(
      'trader-profile',
      'holders',
      profileAlerts.length ? 'medium' : 'info',
      'GMGN 风险标签交易画像',
      `来源标记的成交量占比：诱捕（网页“钓鱼钱包”）${precisePct(entrapmentVolume)}；老鼠仓 ${precisePct(ratVolume)}；捆绑交易 ${precisePct(bundlerVolume)}。这些是成交量比例，时间窗口未披露，不是持仓或人数占比。${profileAlerts.length ? `触发观察阈值：${profileAlerts.join('、')}；阈值只用于提醒复核。` : ''}标签不是对钱包身份或作恶的独立认定`,
      'GMGN info.stat.top_{entrapment,rat,bundler}_trader_percentage',
      {
        entrapmentVolume,
        ratVolume,
        bundlerVolume,
        unit: 'volume ratio',
        window: null,
      },
    );
  const botWalletRate = fraction(stat.bot_degen_rate);
  const freshWalletRate = fraction(stat.fresh_wallet_rate);
  if (botWalletRate !== null || freshWalletRate !== null)
    add(
      'wallet-profile',
      'holders',
      'info',
      'GMGN 钱包样本画像',
      `Bot 钱包比例 ${precisePct(botWalletRate)}（分母样本未披露）；持有人中新钱包比例 ${precisePct(freshWalletRate)}。直接展示来源比例，不用标签钱包个数重新推算；链上机器人标签不能判断 X 上讨论是否来自真人`,
      'GMGN info.stat.bot_degen_rate / fresh_wallet_rate',
      {
        botWalletRate,
        freshWalletRate,
        botDenominator: null,
        freshDenominator: 'holders',
      },
    );
  const creatorShare = fraction(stat.creator_hold_rate);
  const teamShare = fraction(stat.dev_team_hold_rate);
  const creatorStatus =
    typeof info.dev?.creator_token_status === 'string'
      ? info.dev.creator_token_status
      : null;
  if (creatorShare !== null || teamShare !== null || creatorStatus)
    add(
      'dev-current',
      'dev',
      creatorShare !== null && creatorShare > 0.05 ? 'medium' : 'info',
      '开发者当前持仓',
      `GMGN 报告创建者持仓 ${precisePct(creatorShare)}；团队持仓 ${precisePct(teamShare)}${creatorStatus === 'creator_close' ? '；创建者状态：已清仓' : creatorStatus ? `；创建者状态：${creatorStatus}` : ''}。${creatorShare !== null && creatorShare > 0.05 ? '创建者持仓超过 5% 观察阈值。' : ''}${creatorStatus === 'creator_close' && creatorShare > 0 ? '状态与非零持仓比例不一致，需复核。' : ''}零持仓仅反映来源识别的地址，不证明其他关联钱包不存在`,
      'GMGN info.stat.creator_hold_rate / dev_team_hold_rate / dev.creator_token_status',
      { creatorShare, teamShare, creatorStatus },
    );
  const dev = data.dev || {};
  const count =
    number(dev.inner_count) !== null && number(dev.open_count) !== null
      ? Number(dev.inner_count) + Number(dev.open_count)
      : null;
  const history = arr(dev.tokens)
    .slice(0, 30)
    .map((t) => ({
      address: t.token_address,
      symbol: t.symbol,
      marketCap: number(t.market_cap),
      ath: number(t.token_ath_mc),
      liquidity: number(t.pool_liquidity),
      graduated: flag(t.is_open),
    }));
  add(
    'dev',
    'dev',
    history.length ? 'info' : 'unknown',
    '开发者发币历史',
    history.length
      ? `返回 ${history.length} 个历史代币${count !== null ? `，来源统计共 ${count} 个` : ''}；历史回撤不等于开发者作恶，未还原其全部交易`
      : `未取得开发者历史${sourceError('GMGN 开发者') ? `：${sourceError('GMGN 开发者')}` : ''}；不能解释为无不良记录`,
    'GMGN',
    count,
  );
  const social = data.social ? analyzeSocial(data.social) : null;
  add(
    'social',
    'social',
    !social || ['样本不足', '字段不足'].includes(social.verdict)
      ? 'unknown'
      : social.signals.length
        ? 'medium'
        : 'info',
    'X 讨论质量',
    social
      ? `${social.posts} 条去重帖子 / ${social.authors} 个作者。${social.verdict}；不能确认真人身份`
      : sourceError('X')
        ? `X 未核验：${sourceError('X')}`
        : '未取得 X 原始帖子样本，讨论尚未核验',
    'X recent search',
  );
  // Fields the sources already returned but nothing had parsed. These reuse the
  // existing six groups, so the coverage denominator stays unchanged.
  findings.push(...buildProfileFindings(data, candidate));
  const coverage = [
    'contract',
    'honeypot',
    'liquidity',
    'holders',
    'dev',
    'social',
  ].filter((g) =>
    findings.some((f) => f.group === g && !['unknown'].includes(f.severity)),
  ).length;
  const verdict = findings.some((f) => f.severity === 'critical')
    ? '严重风险'
    : findings.some((f) => f.severity === 'high')
      ? '发现高风险'
      : findings.some((f) => f.severity === 'medium')
        ? '需要警惕'
        : findings.some((f) => f.severity === 'unknown')
          ? '证据不足'
          : '已查项未触发';
  // Positive evidence that this coin cannot be sold, which the panel uses to
  // drop it from the candidate list. Deliberately narrow: only a source that
  // *reported* it counts.
  // - `sell` is critical only when GoPlus, GMGN or Honeypot.is actually
  //   answered honeypot / can_not_sell. Its `unknown` state means no usable
  //   sell test was obtained at all — the common case, and the whole Robinhood
  //   chain — and hiding those would turn "nobody checked" into "it fails".
  // - `sell-all` carries the source's cannot_sell_all flag as its value, so a
  //   detected `true` is read from the value rather than inferred from grading.
  // Capabilities are not included: 可暂停转账 and 可修改税率 say the owner could
  // stop a sale later, not that one fails now. They stay on the row as marks.
  // This hides a coin; it never clears one. A list with these removed is still
  // a list whose sell status is mostly unknown.
  const unsellable = findings.some(
    (f) =>
      (f.id === 'sell' && f.severity === 'critical') ||
      (f.id === 'sell-all' && f.value === true),
  );
  // The account the source has linked to this coin, kept separate from the
  // dev-twitter finding on purpose: a first-time deployer has an account but no
  // launch history, so the link has to survive the finding not being raised. It
  // is a way out to the account, not evidence — nothing on the row is read from
  // it, and its presence says nothing about whether the account is real.
  const twitter = normalizeXAccount(info.link?.twitter_username);
  return {
    verdict,
    coverage,
    unsellable,
    twitter: twitter && { handle: twitter.handle, url: twitter.url },
    evidenceSummary: {
      total: findings.length,
      checked: findings.filter((f) => f.severity !== 'unknown').length,
      unknown: findings.filter((f) => f.severity === 'unknown').length,
    },
    findings,
    walletSummary: {
      top10,
      source: holderSource,
      excluded: excluded.length,
      wallets,
      clusters,
    },
    developer: {
      address: info.dev?.creator_address || null,
      total: count,
      history,
    },
    social,
  };
}
