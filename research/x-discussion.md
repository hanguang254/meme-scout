# X 讨论证据接入调研

核对日期：2026-09-06。范围：官方文档调研与实现建议；未用真实密钥调用接口，未验证当前账户的权限、额度或参数兼容性。

建议首版用 X Recent Search 获取可计算的帖子样本，xAI X Search 作为可选的带来源语境补充。产品结论应使用“讨论样本不足”“出现复读/账号集中信号”“本次样本未触发这些规则”，不要输出“真人概率”“真实用户比例”或“无讨论所以安全”。下文的异常计算方法、样本门槛和产品状态均为本项目建议，不是 X 官方机器人鉴定规则。

## 1. X 官方结构化数据

- 请求：`GET https://api.x.com/2/tweets/search/recent`，查询最近 7 天。
- 准备：开发者账号、获批 App、App 的 Bearer Token。此任务可用 app-only 认证只读公共信息；无需用户发帖权限。令牌来自 Developer Console 的 Keys and tokens，只留在本机后端环境变量。
- 认证头：`Authorization: Bearer <X_BEARER_TOKEN>`。
- X API 当前采用预充值按使用付费，具体端点费率以控制台为准；不要把“all developers”解释为免费可用。

来源：[Recent Search Quickstart](https://docs.x.com/x-api/posts/search/quickstart/recent-search)、[App-only authentication](https://docs.x.com/fundamentals/authentication/oauth-2-0/application-only)、[X API pricing](https://docs.x.com/x-api/getting-started/pricing)。

建议请求配置：

| 参数 | 建议值/用途 |
| --- | --- |
| `query` | 首先查精确 CA：`"<contract-address>" -is:retweet`；名称/符号另作补充查询，避免同名币混入 |
| `start_time`, `end_time` | 固定 UTC 查询边界；默认近 24 小时，用户可扩至 7 天；分页过程保持相同边界 |
| `max_results` | 100；官方范围为 10–100，默认 10 |
| `sort_order` | `recency`；不要以相关性排序后的样本直接推导时间分布 |
| `next_token` | 原样使用返回的分页令牌；到预设页数上限时显式标记截断 |
| `expansions` | `author_id`，取得作者对象 |
| `user.fields` | `id,username,created_at,public_metrics,description`；首版只依赖账号创建时间与作者 ID 做确定性计算 |
| 帖子字段 | 需要 ID、正文、作者 ID、发布时间、互动计数；保留编辑历史、引用/转发关系作为去重和解释信息 |

官方参考：[Search recent Posts](https://docs.x.com/x-api/posts/search-recent-posts)、[Pagination](https://docs.x.com/x-api/posts/search/integrate/paginate)。普通自助访问的查询长度按 512 字符控制；Enterprise 为 4096。查询操作符可组合，但符号匹配不能证明帖子讨论的是输入 CA。[Build a query](https://docs.x.com/x-api/posts/search/integrate/build-a-query)

**文档兼容性待真实请求验证：**官方 Quickstart/Integration Guide 仍使用 `tweet.fields=created_at,public_metrics,author_id`、`referenced_tweets`、`edit_history_tweet_ids`；本次实时打开的 API Reference 已显示 `post.fields`、`referenced_posts`、`edit_history_post_ids`，请求路径仍是 `/2/tweets/search/recent`。因此不要把任一套命名当成已实测事实。适配层宜可选择命名版本，并且仅在服务器明确报参数/字段无效时尝试另一套；不能把缺失作者/时间字段当成统计 0。解析层可识别这两套响应别名。首个成功真实请求应保存脱敏字段结构作为验证记录。[Quickstart](https://docs.x.com/x-api/posts/search/quickstart/recent-search)、[当前 API Reference](https://docs.x.com/x-api/posts/search-recent-posts)

当前限额表列 Recent Search app-only 450 次/15 分钟，但实际账户额度、计费和响应限流头仍须独立处理。遇到 429 按返回重置时间退避；不要自动高频重试。[Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)

## 2. 最小可实现的证据统计

建议初始上限 2 页 × 100 条，缓存 5 分钟。它是成本和交互延迟控制，不代表统计学充分样本。先合并跨页与跨查询的相同帖子 ID；有编辑历史时，把同一编辑链视为一个帖子。作者使用 `author_id` 去重，不能用昵称或用户名去重，也不能称为去重“真人”。

每次结果至少记录：provider、查询原文、chain/CA、requestedStart/End、fetchedAt、实际最早/最晚帖时间、原始条数、去重条数、去重作者数、页数、是否存在未取的 next_token、作者资料覆盖数、时间字段覆盖数、字段错误。固定时间窗口内只取最近两页时，标注“最多 200 条最近样本，已截断”，不能称为该窗口全部讨论。

| 指标 | 算法与必要分母 | 解释边界 |
| --- | --- | --- |
| 去重作者数 | 含有效 author_id 的去重账号数；另列 author_id 缺失帖数 | 多个账号不等于多个独立自然人 |
| 作者集中度 | 最多发帖作者/前 3 作者的帖子数 ÷ 有作者字段的样本帖子数 | 可能是刷屏，也可能是项目官方连续公告 |
| 文本复读率 | 正文标准化后聚类；每组第二条及以后数量之和 ÷ 可用正文数。标准化规则版本化，保留原文及示例链接 | 去掉 URL、CA、符号后的空文本不能误判为高相似“实质内容”；自然转述、相同新闻标题也会重复 |
| 近似文案 | 仅将达到明确相似阈值的跨作者文案列为候选组，展示 2–3 条原文链接 | 阈值是启发式规则，不证明协同操纵 |
| 新号占比 | 在样本发帖时账号年龄不足 30 天的去重作者数 ÷ 有合法 created_at 的去重作者数；显示阈值与缺失数 | 新账号不等于机器人；老账号也可能被买卖或接管 |
| 时间扎堆 | 可用时间帖按 5 分钟桶汇总；峰值桶条数 ÷ 有时间字段的帖子数，同时展示实际采样跨度 | 新币开盘、新闻和截断样本本身会扎堆；跨度不足 15 分钟时仅显示分布，别自动判异常 |
| 引用/互动 | 展示 API 原始公开计数与引用链接 | 点赞、转发和认证状态均不是身份真实性证明 |

初始建议在去重样本少于 20 条或去重作者少于 10 个时显示“样本不足”；这是产品保守门槛，并非已校准的统计阈值。即使满足门槛，也只展示各异常信号，不把它们加权转换为机器人概率或买卖建议。账号年龄字段覆盖不足时显示“账号年龄数据不足”，而不是低新号占比。

查询分层建议：CA 查询为强关联样本；ticker/name/官网域名查询为候选样本，只有正文、落地链接或经核对的项目上下文能建立 CA 关联时才纳入。保留来源层级，不能因同名热词的大量讨论给输入币加分。精确 CA 也可能被营销机器人贴入无关内容，因此它仅是匹配证据。

可选后续增加 `GET /2/tweets/counts/recent` 做 minute/hour 计数，改善只抓 200 条时的量能视图；它不返回作者，不能用于估算真人数量。官方说明 counts 与 search 因过滤差异可能不完全一致，不可直接以二者之比宣称采样覆盖率。[Post Counts](https://docs.x.com/x-api/posts/counts/introduction)

## 3. xAI Responses + X Search 可选语境补充

官方接口为 `POST https://api.x.ai/v1/responses`，认证头 `Authorization: Bearer <XAI_API_KEY>`；请求包含 `model`、`input`、`tools`。工具配置 `type: "x_search"`，可带 `from_date`/`to_date`（ISO8601 日期，首尾日期均包含）；支持 allowed/excluded X handles，各最多 20 个，二者不能同时设置。当前官方示例用 `grok-4.6`，模型应可配置，并以账号实际可用模型为准。[X Search](https://docs.x.ai/developers/tools/x-search)

该功能用于查项目叙事、争议、宣布事项及相关帖链接。提示词应包含 chain、完整 CA、精确时间范围，并明确：不要把同名项目混为一谈；每项结论附具体帖子 URL；无法确认对应 CA、作者身份或覆盖度时写未知；不可编造帖子数、作者数、账号年龄、真人概率。日期工具过滤无法表达小时窗口时，需在文本中写明精确时间并标记小时边界未保证。

从响应 `output` 中找到 `type=message` 的 `content`，读取 `type=output_text` 的文字与 `annotations`。引用常见结构为 `type=url_citation`、`url`、`start_index`、`end_index`、`title`；SDK 的 `response.citations` 提供搜索过程中遇到的 URL。Responses 的行内引用默认开启，但官方明确不保证每个回答都给引用。应优先用结构化引用去重展示，并保留正文；不能把 sources 数当成帖子样本总数。[Citations](https://docs.x.ai/developers/tools/citations)

推论：xAI 是由模型规划的搜索与总结接口，其引用清单不证明穷尽检索，也不提供稳定可复算的总体分母。只有 xAI 接入时，可显示“已取得带来源的讨论线索，结构化统计未接入”；不要把模型输出的一张帖子表默认为 X API 原始记录。无引用的论断标记“未取得可核对来源”。

成本由模型 token 和工具调用共同组成；当前 X Search 工具价 $5/1000 次调用，一个 Responses 请求可能调用多次工具，不能当成每次查询固定 $0.005。默认不要启用图片/视频理解，以免无关成本；模型/工具费用以官方控制台为准。[xAI pricing](https://docs.x.ai/developers/pricing)

## 4. 必须区分的结果状态

| 状态 | 建议文案 |
| --- | --- |
| 没有密钥 | X 讨论数据未接入 |
| 401/403 或权限错误 | X 数据认证/权限异常 |
| 额度/计费错误 | X 数据额度不可用 |
| 429/超时/上游失败 | X 数据暂时不可用；保留上次结果并标明时间 |
| 成功但精确 CA 0 条 | 在指定查询和时间窗口内未检索到匹配帖子；证据不足 |
| 成功但字段缺失 | 已取得部分数据，缺失项不能计算 |
| 达分页上限 | 最近 N 条截断样本，不能代表窗口总体 |
| 有样本但异常规则未触发 | 本次样本未触发所列异常规则；不证明账号为真人或代币安全 |
| 触发异常信号 | 展示指标、分母、阈值、窗口与示例帖子，使用“复核线索”措辞 |

本功能只处理公开讨论证据，不执行交易或在 X 发布内容。面板 API 不应把 Bearer Token 或 xAI key 返回浏览器；日志只记录 provider、HTTP 状态、延迟与脱敏错误。
