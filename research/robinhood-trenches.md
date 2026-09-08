# Robinhood Trenches 接入调研

核验时间：2026-09-06 00:39–00:42 UTC。页面、前端 JS、全部下列 REST 请求均直接获取；不使用登录、不连接钱包、不提交交易。

## 网站定位与已验证能力

- [官网](https://robinhoodtrenches.com/) 自述为非官方、只读的 fomo.family 交易员监控站，不隶属 Robinhood Markets 或 fomo.family。该站没有在已检查的页面中提供正式开发者文档、API key 管理、版本承诺、收费/速率限制说明。
- 支持 Robinhood Chain，`/api/status` 实测 `chain="robinhood"`、`chain_id=4663`、`wallets=147`。追踪数量动态变化，不应使用启动动画硬编码的 108。
- Live tape：跟踪钱包的买卖、USD 金额、数量、成交价、交易员、关注数、合约地址、交易哈希。可区分真实现金腿定价与估算、伪买卖/空投/转账等标记。
- Closed trades：完全平仓的一轮持仓，而不是每笔卖单；成本、回收、收益、收益率、持仓时间。
- Traders：已实现/未实现/总收益、胜率、成交数、最好/最差交易；详情含持仓、历史、收益曲线、平均持仓时长、profit factor。
- Tokens being bought：哪些代币被追踪钱包买入、仍持有、净流入、首位买家、池子流动性。
- Who followed who：首位买入的钱包、随后买入的其他钱包、时间差。它表示买入先后关系，不证明因果或操纵关系。
- Fresh pools：近期首次被追踪钱包买入的代币，以及首次买入时的池龄。不是全链新合约/新池完整枚举。

## 接口来源与实际验证

全部接口来自站点自身加载的 [app.js?v=20f18e8924](https://robinhoodtrenches.com/app.js?v=20f18e8924)，不是推测的端点。JS 的 `api()` 使用同源 `fetch('/api'+path+'?'+URLSearchParams)`，不附加认证头。

下列 9 个 GET 均通过 Scrapling 得到 HTTP 200 且实际解析 JSON。请求未提供 cookies 或 Authorization。`status` 另用 curl 独立验证为 HTTP 200、`content-type: application/json`、`cache-control: public, max-age=3`；未见公开限流响应头。

| 已实际请求的 URL | 返回类型和关键字段 |
| --- | --- |
| [status](https://robinhoodtrenches.com/api/status) | object：`ok, chain, chain_id, wallets, uptime, source, lag_seconds, last_block, indexer_age, trades, first_ts, last_ts, server_ts, latency:{n,median,p90,since}, viewers` |
| [tape](https://robinhoodtrenches.com/api/tape?limit=2&stocks=false) | array：`id, ts, tx, side, usd, amount, price, new_position, is_stock, block, priced, quote_token, two_sided, funding, handle, display_name, followers, wallet, token, symbol, name, mark, liquidity, pair_url, flags` |
| [tokens](https://robinhoodtrenches.com/api/tokens?window=24h&stocks=false&limit=2) | array：`token,symbol,name,is_stock,traders,buyers,holders,usd_in,usd_out,net_usd,first_ts,last_ts,mark,liquidity,change24,volume24,pair_url,pair_created_at,first_buyer:{ts,price,handle,followers},since_first_buy_pct` |
| [traders](https://robinhoodtrenches.com/api/traders?window=24h&stocks=false) | array：`address,handle,display_name,followers,profile_url,volume,fills,buys,sells,last_ts,realized_pnl,closed_trades,wins,best_trade,worst_trade,open_bags,open_cost,open_value,unrealized_pnl,net_pnl,win_rate,state,active` |
| [overview](https://robinhoodtrenches.com/api/overview?window=24h&stocks=false) | object：`window,fills,buys,sells,active_traders,tokens,volume,bought,sold,realized_pnl,unrealized_pnl,net_pnl,open_bags,open_cost,open_value,unpriced_bags,closed_trades,win_rate,last_5m,biggest_win,biggest_buy` |
| [closed](https://robinhoodtrenches.com/api/closed?window=24h&stocks=false&limit=1) | array：`wallet,token,opened_ts,closed_ts,cost_sold,proceeds_usd,pnl_usd,buys,sells,handle,followers,profile_url,symbol,is_stock,pnl_pct,hold_seconds` |
| [flow](https://robinhoodtrenches.com/api/flow?window=24h&stocks=false&limit=1) | array：`token,symbol,name,is_stock,lead:{ts,usd,price,handle,followers,profile_url,wallet},followers,follower_count,mark,pair_url,since_lead_pct,total_usd` |
| [radar](https://robinhoodtrenches.com/api/radar?minutes=120&limit=1) | array：`token,symbol,name,is_stock,first_ts,buyers,usd_in,mark,liquidity,pair_created_at,pair_url,change24,pool_age,age_at_first_buy,fresh,first_buyer:{handle,followers,ts}` |
| [trader detail](https://robinhoodtrenches.com/api/trader/unipcs?window=24h&stocks=false) | object：`address,handle,display_name,followers,num_trades,volume_usd,joined,solana_address,profile_url,streak,bags,history,curve,stats` |

前端允许 `window=1h/24h/7d/30d/all`。本次已实测 24h 和 1h，不应把其余参数值或最大 limit 上限称为已验证。前端 tape fallback 使用 `since_id`，本次未单独验证增量语义。

交易员详情 `stats` 实测字段：`window,closed_trades,win_rate,realized_pnl,best_trade,worst_trade,avg_hold_seconds,profit_factor,open_bags,unrealized_pnl,net_pnl`。`bags` 含 `amount,cost_usd,avg_price,opened_ts,last_buy_ts,mark,value,priced,pnl,pnl_pct,age_seconds` 及代币/市场字段；`history` 含成本、收入、收益和持仓起止；`curve` 的 `{ts,pnl}` 形状由前端明确读取。

## WebSocket 与刷新方式

- 前端明确使用 `wss://robinhoodtrenches.com/ws`；消息格式 `{type:"fills",data:[...]}` 与 `{type:"hello",data:status}`，每 20 秒发送字符串 `p` 保活。
- 实际用 Node WebSocket 尝试两次，均触发空 error，未完成可验证的握手或收到消息。原因未定位。只能声称此地址在站点前端存在，不能声称本环境实连成功。
- 前端表格每 30 秒刷新；WS 无法连接时，tape 每 5 秒读取，重连加入 2–6 秒随机延迟。这是实现观察，不是对外速率额度承诺。
- 建议首版采用带超时、错误状态与至少 30 秒缓存的 REST 适配器；429/5xx 退避，不做高频全量爬取。

## 必须保留的数据边界

1. `buyers/holders/traders` 仅为该站追踪的钱包子集，绝不能写成全链总持有人/Top10 占比，也不能代替 GMGN 的 holder 分布。
2. 该站未提供已验证的合约 owner/mint/freeze/blacklist 权限、LP 锁仓期限、锁仓合约、貔貅模拟或开发者发币历史 API。开发者历史应由 GMGN wallet/token 接口或浏览器/RPC 补充。
3. `flags` 在前端支持 `not a real buy/sell (transferred/airdropped/spoofed/planted/gifted)`、`sold a free bag`、`no market`、`untradeable`、spam 等提示；本次获取的两笔 tape 样本 `flags=[]`，这些非空取值来自官方前端而非现场样本。需要保留原始 flags，不把空数组解释成合约安全。
4. `priced="cash_leg"` 表示读到现金腿；其他定价方式前端显示约数。`usd=null` 不是 0。样本实际出现 `mark,liquidity,pair_url,pair_created_at` 为 null。
5. `trader/unipcs?...stocks=false` 的 `history` 实际仍含 `is_stock:1`；详情历史不能假定已经严格受 stocks/window 过滤。客户端需按自身范围二次过滤或明确标注。
6. 当前指数只覆盖 `first_ts` 以来的历史，P/L/胜率不代表钱包终身收益，不覆盖站点未追踪的其他钱包或链。
7. `followers` 是站点对用户的关注数数据，不能证明 X 真人粉丝或有机讨论。站点不返回推文正文、作者创建时间、互动样本或机器人评分。

## 建议接入流程

候选发现（radar/tokens/tape）→ 合约地址与 chain=robinhood 固定匹配 → GMGN/其他受支持安全源查权限、貔貅与持有人 → LP 证据补充 → 开发者/关联钱包历史 → RHT 交易员交易序列和退出行为 → X 原始讨论采样与可解释的重复/时间集中/账户多样性指标 → 人工决定。

将 RHT 定位为“资金行为线索”数据源，保留每项来源 URL、抓取时间、追踪范围与缺失字段；未知安全项保持 `unknown`。对未被 GMGN skills 当前版本支持的 Robinhood Chain，不可静默降级成 Ethereum，也不可声称所有安全维度已覆盖。

## 自动发现热门币与低市值币（追加核验 00:45–00:47 UTC）

用户核心需求是自动扫描网站候选，不是手工粘贴合约。建议每 30–60 秒读取 `tokens?window=1h&stocks=false&limit=60`、`radar?minutes=120&limit=40`，合并地址去重，再补市值/安全信息；1h 窗口发现近期热度，24h 作为上下文。此次实际请求 [tokens 1h 前10](https://robinhoodtrenches.com/api/tokens?window=1h&stocks=false&limit=10) 为 HTTP 200，buyers 顺序为 `7,7,5,3,3,3,2,2,2,2`。目前仅观察到按 buyers 降序、并列似按 usd_in 排名，未核实服务端排序承诺；前端没有传 sort/min_mcap/max_mcap 参数。应本地明确排序，金额、流动性和市值阈值由配置决定。

**市值补充：DEX Screener 已实测可覆盖 Robinhood。**

- [官方 API 文档](https://docs.dexscreener.com/api/reference) 的 `/tokens/v1/{chainId}/{tokenAddresses}` 明确支持逗号分隔最多 30 个地址、速率 300 requests/minute。文档经 Scrapling 200 获取并读取到以上说明。
- 实际请求 [两地址批量查询](https://api.dexscreener.com/tokens/v1/robinhood/0x7df5daaf80e65dfcc7a1435d9b52bcf2b5753fbe,0xa3602804e096cb73bd8344afc1ff3f3390b899c5) 得到 HTTP 200 和长度为 2 的 JSON 数组，无认证。
- [latest token 查询](https://api.dexscreener.com/latest/dex/tokens/0x7df5daaf80e65dfcc7a1435d9b52bcf2b5753fbe) 也实际成功，返回 `{schemaVersion:"1.0.0", pairs:[...]}`，这个样本有 30 个池。不同池报告的价格/市值可显著不同，不能任选一个薄池判断“低市值”；优先使用同 chainId、同 baseToken.address 且流动性最大的池，显示池来源。
- DEX 字段：`marketCap` 与 `fdv` 分开保留，不互相静默冒充；`volume.h1/h24/m5`、`txns.h1/m5`、`priceChange.h1`、`liquidity.usd`、`pairCreatedAt`（毫秒）、`info.socials`。没有全链 holder 数或 LP 锁定证明。
- RHT 的 `first_ts/pair_created_at` 是秒，DEX 的 `pairCreatedAt` 是毫秒。RHT 的 `volume24` 与主池 `volume.h24` 本次实际不同，可能是跨池汇总口径，不要混成同一字段。
- RHT 1h 样本出现 `buyers=7,holders=9`，表明“当前持仓追踪钱包”和“窗口内新买入钱包”不是同一时段计数。UI 应写成“1h 买入钱包 / 当前仍持有的追踪钱包”。

批量 DEX 样本（动态市场快照，只用于验证字段，不作为买入推荐）：

```json
{
  "chainId": "robinhood",
  "baseToken": {"address":"0x7df5daAF80e65dFcc7a1435d9b52bcf2B5753fbE","name":"Unipcs","symbol":"UNIPCS"},
  "marketCap": 6520015,
  "fdv": 6520015,
  "liquidity": {"usd":235825.28,"base":18084719,"quote":47.3959},
  "volume": {"h24":7361913.56,"h6":7361913.56,"h1":2165673.6,"m5":34142.18},
  "pairAddress":"0x47631aedb7cc03d2f0d2452dd94fee1f1a149a3792fe9a2b413d4394a1a0f2a4"
}
```

候选可以分别保留“追踪钱包热门”与“低市值热门”两个筛选视图：前者按 buyers/净流入/最近买入排列；后者只纳入已获得 marketCap 的候选，再按用户上限过滤并按热度排列。市值未知、无市场或所有钱包买入都可疑的条目保留为需要核查，不以 0 市值进入低市值榜。热度排名与安全检查应分别展示，不能用热度抵消权限、LP 或貔貅风险。
