# Meme 扫链风险数据源核验

核验日期：2026-09-06。范围是公开只读 API；下文的适配器结构与评估规则是本项目建议，不是数据商的保证。接口测试未交易、未签名，也未提交 token 举报。

## 可直接实现的接口

| 来源 | GET endpoint | 链和认证 | 建议职责 |
| --- | --- | --- | --- |
| GoPlus EVM | `https://api.gopluslabs.io/api/v1/token_security/{chain_id}?contract_addresses={address}` | 主网 chain ID；公开请求可无 token，可配置 Bearer access token | 权限、交易限制、持有人、LP 证据 |
| GoPlus Solana | `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses={mint}` | Solana SPL / Token-2022；公开请求可无 token | mint/freeze/extension 权限与持仓 |
| Honeypot.is | `https://api.honeypot.is/v2/IsHoneypot?address={address}&chainID={id}` | Ethereum 1、BSC 56、Base 8453；目前无需 key，可预留 `X-API-KEY` | 买卖模拟、税率、失败原因 |
| RugCheck | `https://api.rugcheck.xyz/v1/tokens/{mint}/report` | Solana mint；GET 报告可匿名 | 第二来源风险、LP、持仓与权限 |
| DexScreener | `https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}` | `solana`、`ethereum`、`bsc`、`base` 等名称；公开无需 key | 各池流动性、交易量、池龄、项目链接 |

官方依据：[GoPlus EVM 请求](https://docs.gopluslabs.io/reference/tokensecurityusingget_1)、[Solana 请求](https://docs.gopluslabs.io/reference/solanatokensecurityusingget)、[Honeypot 请求](https://docs.honeypot.is/ishoneypot)、[支持链](https://docs.honeypot.is/chains)、[认证](https://docs.honeypot.is/authentication)、[RugCheck 当前 OpenAPI](https://api.rugcheck.xyz/swagger/doc.json)、[DexScreener API](https://docs.dexscreener.com/api/reference)。

GoPlus 当前链表也包含 Robinhood `4663`。这只能证明 GoPlus 支持该 chain ID，不能由此推断 robinhoodtrenches.com 的网络或站内 token 全部属于该链；网站适配器必须独立确认。[GoPlus 链表](https://docs.gopluslabs.io/reference/response-details-9)

## 字段与不能丢失的语义

### GoPlus

- 成功至少要求 HTTP 成功、`code === 1` 且 `result` 中存在所请求地址。EVM response key 用小写地址；Solana 保留大小写。空 result 不是安全结果。
- 权限读取 `is_open_source`、`is_proxy`、`owner_address`、`is_mintable`、`hidden_owner`、`can_take_back_ownership`、`owner_change_balance`、`transfer_pausable`、`is_blacklisted`、`slippage_modifiable`；交易读取 `is_honeypot`、`cannot_buy`、`cannot_sell_all`、`buy_tax`、`sell_tax`。字符串 `"0"` 必须解析为 false，缺失、null、空字符串必须保留 unknown。
- EVM `buy_tax` / `sell_tax`、`holders[].percent`、`lp_holders[].percent` 为 0–1；转换成 UI 百分比时乘 100。保留 `dex[].pair`、`liquidity_type`、`pool_fee`。`pool_fee` 与 token 税分别呈现。
- `holders` / `lp_holders` 仅是前 10；`is_locked` 包含数据商识别的锁仓地址和销毁地址。`locked_detail[].end_time`、`amount` 是期限证据；没有明细不能凭锁标记承诺长期锁定。V3 NFT 持仓必须看有效流动性与 position，不能套 V2 LP 数量算法。

字段依据：[GoPlus EVM 字段](https://docs.gopluslabs.io/reference/response-details)。锁仓覆盖范围另见 [Supported Locker](https://docs.gopluslabs.io/reference/supported-locker)。

Solana 使用 `mintable.status`、`freezable.status`、`closable.status`、`balance_mutable_authority.status`、`transfer_fee_upgradable.status`、`transfer_hook_upgradable.status`；并读取 `non_transferable`、`default_account_state`、`transfer_hook`。`transfer_fee.current_fee_rate.fee_rate` 是基点，200 表示 2%，不能按 EVM 比率换算。`scheduled_fee_rate` 是尚待 epoch 生效的费率。实测持有人同时有 owner `account` 与 `token_account`，聚合钱包时应优先用前者。Solana `lp_holders` 的文档范围是最大的 SOL/USDC/USDT 主币池，不能代表全部池。[Solana 字段](https://docs.gopluslabs.io/reference/response-detail-1)

### Honeypot.is

`simulationSuccess` 与 `honeypotResult.isHoneypot` 分开记录。前者失败时可能仍有持有人分析生成的结果；没有 `honeypotResult` 只能是 unknown。显示 `simulationError` 和 `honeypotReason`。`simulationResult.buyTax/sellTax` 是百分比数值；`holderAnalysis.holders` 是被分析的样本数，真正 holder 总数在 `token.totalHolders`。保留 pairAddress，明确模拟针对哪个池。优先使用 `summary.flags`，根级 `flags` 已弃用；`contractCode` 可能是缓存。

限制与字段依据：[模拟语义](https://docs.honeypot.is/ishoneypot)、[风险 flags](https://docs.honeypot.is/summary_flags)、[错误响应](https://docs.honeypot.is/errors)。不要默认开启 `forceSimulateLiquidity`：虚构池条件下的模拟不能证明现实可成交。

### RugCheck

官方 schema 中 report GET 没有认证 requirement；同路径 POST 是举报功能，不能调用。`refresh=true` 需要付费 API key。`/v1/tokens/{mint}/lockers` 独立接口需要 `Authorization` JWT；MVP 优先使用匿名报告已有字段。全报告支持 400、429；summary 还定义 404。

2026-09-06 实测字段：权限地址在 `token.mintAuthority` 和 `token.freezeAuthority`；同名顶层字段可能是原始账户对象。`topHolders[].address` 是 token account，`owner` 才是钱包；`pct` 为 0–100。`markets[].lp.lpLockedPct` 为百分比，`lpLockedUSD` 为金额；`lockers` 是映射，含 `unlockDate`、`type`、`uri`。保留 `score`、`score_normalised` 和原始 `risks`，不要擅自把原始 score 当作 0–100。OpenAPI 未给全报告 response 完整 schema，因此这些字段仅是实测确认，解析须防缺失。

官方 API：[Swagger](https://api.rugcheck.xyz/swagger/index.html)、[JSON schema](https://api.rugcheck.xyz/swagger/doc.json)。

### DexScreener

读取 `liquidity.usd`、`volume.h24`、`txns.h24`、`pairCreatedAt`、`baseToken` / `quoteToken`、`info.socials`、`info.websites`。返回是 pool 数组，严格核对 chain 和地址后选流动性最大的池；同币多池分开展示。返回的 social link 是项目资料，不能用于判定讨论真实度。

发现候选可以读取 `/token-profiles/latest/v1` 和 `/token-boosts/latest/v1`；后者是付费推广，UI 需标注来源。批量报价用 `/tokens/v1/{chainId}/{tokenAddresses}`，最多 30 个地址。行情/池接口为 300 requests/min，profiles/boosts 为 60 requests/min。[API 文档](https://docs.dexscreener.com/api/reference)

## 现场读请求记录

请求头使用 `User-Agent: MemeScanner-Research/0.1`、`Accept: application/json`；不含密钥。默认沙箱禁止外网 DNS，获得只读网络执行批准后完成验证。

| 接口 / 样本 | 结果 | 对实现的意义 |
| --- | --- | --- |
| GoPlus EVM / PEPE `0x6982508145454ce325ddbe47a25d4ec3d2311933` | HTTP 200、code 1 | 权限、holders、LP、dex 字段存在；同时出现 V2/V3/V4 池 |
| Honeypot.is / 同 PEPE | HTTP 200、完整模拟响应 | Python 默认 UA 曾 403，明确 Accept/UA 后成功；403 应显示来源不可用 |
| DexScreener / 同 PEPE | HTTP 200、30 个 pool | 同币多池是真实情况；不能重复计算资产身份 |
| GoPlus Solana / USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | HTTP 200、code 1 | mint/freeze 可用；holders 及 dex 可用；LP holders 可为空 |
| RugCheck / 上述 USDC | HTTP 200、风险空数组、holder/market 数据为空或 0 | `risks: []` 不代表检查完整；必须统计覆盖率 |
| RugCheck / 官方 GoPlus Solana 样例 `HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3` | HTTP 200、holder/market/locker 字段存在 | 验证 pct、owner、lpLockedPct、unlockDate；detectedAt 是旧日期，不能当最新 fetch 时间 |
| GoPlus / 一个不能识别的 Solana 地址 | HTTP 200、code 7012、result null | HTTP 200 仍可能是业务失败 |
| RugCheck / 同不能识别地址 | HTTP 400、`error: not found` | 支持未收录/不存在状态，不能补造报告 |

临时原始样本位于 `/private/tmp/meme-research-*.json`；这些是接口形状验证样本，不作为产品默认行情或买卖建议。

## 建议最小适配器协议

每个 provider 返回以下字段即可，避免在采集层生成“安全分”：

```text
ProviderResult {
  provider, chain, tokenAddress,
  status: ok | partial | no_data | unsupported | auth_required |
          rate_limited | timeout | error,
  fetchedAt, sourceObservedAt?, url, latencyMs,
  data, raw?, error: { code?, message? }?
}

Evidence {
  id, category: permissions | sellability | liquidity | holders,
  provider, field, value, unit?, scope: { chain, address, pool? },
  state: observed | unknown | conflict,
  fetchedAt, sourceObservedAt?, sourceUrl,
  severity: info | medium | high | critical,
  explanation
}
```

建议：所有百分比内部统一为 0–100，但保存 raw unit；地址验证与链选择在入口进行；未知不等于 0；金额原值字符串保留；单 provider 失败不拖垮整次扫描；超时 10–15 秒、少量带 jitter 重试、429 读取 Retry-After。GoPlus 免费文档限流为 30/min，应做全局队列并缓存 30–60 秒，给扫描显示缓存年龄。[GoPlus 限流](https://docs.gopluslabs.io/reference/support)

## 决策显示的误判防线

以下是基于上述接口范围的产品判断：

1. 卖出模拟通过只说明一次观察结果；权限后续修改、地址定向限制、池选择与交易量都可能改变结果。
2. “LP 已锁”必须带池、比例、来源与期限；仅最大池或前 10 LP 的结果应标“覆盖有限”。unknown 不应画成绿色。
3. 持仓集中度同时显示原始 Top 10 与排除已识别池/销毁/交易所后的已识别钱包集中度。标签缺失不能把合约自动当庄，也不能把多个地址当独立的人。
4. 多来源矛盾应显示 conflict 和证据，不能通过平均分抹平貔貅告警。
5. 社交质量是独立维度。高讨论量、DEX boost、买量不抵消合约或卖出风险。
6. 权限风险、证据覆盖率、流动性状态分开展示；用户自己决定买不买，工具不生成自动交易。
