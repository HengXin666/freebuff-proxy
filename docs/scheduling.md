# 多账号池与热 session 优先调度

> 本文是 [freebuff-proxy](../README.md) 的详细文档之一。粘性优先（drain, not rotate）调度、Freebucks 额度口径、额度保护、工具签名兼容。
> 快速上手 / 一键部署请看 [主页 README](../README.md)。
## 多账号池与热 session 优先调度

### 账号池自动切号

- 在 `/data/credentials/` 放入多个账号（通过控制台逐个添加或导入）。
- 每次请求按可用性选号：`rate_limited` / `spend_limited` / `ip_capped` / `free_mode_rate_limited` / `banned` 整号冷却并自动换下一个；`model_unavailable` 只冷却该账号上的该模型。
- **chat/completions 阶段上游报错自动换号**：429 限流（如 `free_mode_rate_limited`）、5xx、
  403 账号级封禁都会按上游 `Retry-After` 冷却当前账号并**换号重试**（最多试到账号数，封顶 5 次），
  而不是把错误直接甩给下游；4xx 客户端错误（400/401/404/422）不换号。
- **换号不再"每个账号都买一条计费会话"**（2026-09 Freebucks 改版）：上游按模型单价（N/h）
  × **会话实际占用时长**结算（admit 预占整小时、提前 DELETE 退未用时长），因此单个下游
  请求最多新建 `limits.max_new_sessions_per_request`（默认 2）条会话——复用热 session 和
  被上游拒绝的 admit 都不占预算；换号前失败账号的会话会立即早退 DELETE（结束会话、避免占槽与漏扣；退款能否到账见下文实测脚注），网络类瞬时
  故障先在同一账号上重试一次（复用热 session，不新建）。**请求彻底失败时也会早退释放**，
  不让会话空挂计时。详见下方「额度保护（Freebucks 计费，控制台可调）」。
- 冷却信息（状态、剩余时间、原因）在控制台「总览」实时可见，可手动「解除冷却」。

### 热 session 优先调度

Freebuff 免费会话是**无状态**的：上游每次请求都会收到**全量消息历史**（客户端自己携带），
不存在"服务端记住某个 conversation"的概念；但 admit 会占用按时长结算的免费次数，因此代理按
**最少新建 session**的目标调度：

- **粘性优先（drain, not rotate）**：选号顺序 = 同模型热 session → 已用过的账号（最近用过的
  优先）→ **从未用过的账号（排最后，只有已用账号都不可用、或满员排队超时才启用）**。
  上游把"轮换健康账号"直接当账号农场特征（参考项目 ADR-0012: *cycling healthy keys looks
  like account farming*），而 Freebucks 又是 admit 一次扣一次——所以代理**绝不主动把并发
  平摊到多个账号**：宁可把请求集中在一个账号上，用尽（限流/额度耗尽/冷却）才换下一个；
- **最少新建 session**：创建 session 就从 admit 起按时长计费，因此同模型活跃 session 始终优先复用；
  `conversation_id` / `thread_id` / `user` / `client_id` 不参与选号；
- **每账号并发上限的含义取决于「调度模式」**（控制台「账号调度」，默认 **2**，可调 1..16）：
  - `sticky`（**默认**，粘性优先）：上限是**溢出阈值**——单账号在途流数达到上限后，
    新请求先在该账号上**有界排队**（热会话等 `stream_idle_timeout_sec + 15s`、
    冷账号等 `limits.account_chat_wait_ms`，超时返回 `account_busy` 并换下一个账号），
    **不为了并发去启用从未用过的账号**。
  - `spread`（并发优先）：上限是**换号阈值**——账号满员就立刻换到下一个有空闲槽位的
    账号（最多先等 `accountOverflowWaitMs`，默认 15s；已用账号仍优先于未用账号）。
    4 路并发 + 上限 2 → **两个账号各 2 路**，不会全挤在一个号上干等。

  > **为什么会有两种模式**：`sticky` 在 Freebucks 口径上最优（换号 = 新买一条计费会话），
  > 但高并发时新请求会被串行化、表现为"卡"；`spread` 用"可能多预占几条会话"换"不排队"。
  > 详细调研、实测数据与取舍见 [account-scheduling-and-refund.md](./account-scheduling-and-refund.md)。

  总览里每个账号显示 `并发(在途/上限)` 实时监控；
- **会话临近过期提前切换（按模型分层）**：剩余时间低于提前量阈值的会话不再承接新请求，
  re-admit 换全新会话——避免请求发到马上过期的会话上、中途卡住（响应明显变慢/挂起）。
  提前量按计费方式分层：
  - **免费模型**：`session.free_model_re_admit_lead_sec`（默认 60s = **1 分钟**）——
    会话剩余不足 1 分钟即**不再调度到该会话**，提前 re-admit 换新会话（2026-09 Freebucks
    按占用时长结算，提前 re-admit 只是把剩余时长换成新计费行，所以只留最小切换余量）；
  - **付费模型**：`session.re_admit_lead_sec`（默认 60s）——付费会话每次 admit 都计费，
    尽量用到接近过期再切换。
  **切换是平滑的**：旧会话若正被在途 SSE 流使用，会先等在途流结束后才释放重建，
  绝不把正在传输的连接掐断；流式 idle 超时按会话剩余时间收敛，过期后上游若不再吐数据
  会更快被掐断；会话切换等待在途请求也有上界（`2×stream_idle_timeout_sec + 60s`），
  在途流因网络波动长时间不结束时放弃该账号换下一个，避免新请求无限干等；
- **代理切换不断流**：前端「代理设置」保存全局代理池/账号出口变更后**立即生效**——
  新请求走新出口；旧 runtime 的 session 在后台等所有在途 SSE 结束后再优雅释放，正在
  传输的流不受影响。排队等锁期间发生切换的请求会自动无冷却重新选号（走新出口），
  不会撞上已失效的旧会话；
- 冷启动的选号与 admit 已原子化（`_acquireMutex` 串行化选号 + admit）：同一账号的并发请求只 admit 一次、共享该账号 session；
- 没有同模型热 session 时，优先选择**没有活跃 session 的账号**，而不是替换别的模型的热 session
  （同一账号上反复 release/admit 每次都要新买一条计费会话）；
- 多个同层级账号只在平局时轮询（已用过的账号之间按"最近用过的优先"保持粘性）；**冷却中的账号跳过**；
- 上游报错（gate 错误如 `session_expired` / `superseded`）自动同号 re-admit 重试一次；
  429 限流 / 5xx / 403 账号级封禁则冷却当前账号并换下一个账号重试，4xx 客户端错误（400/401/404/422）不换号。
  换号次数受"单请求新会话预算"约束（见「额度保护」）。

控制台「总览」顶部显示各账号实际请求占比、活跃 session 与冷却状态。

### 查看额度（Freebucks + rateLimitsByModel）

上游 2026-09 起把免费额度改成 **Freebucks** 计量，两种计费方式并存：

- **Freebucks 计量模型**（上游 `freebucks.prices` 里有价格的模型）：每个模型有单价
  （N Freebucks/小时），session 从 admit 起**按实际占用时长结算**——admit 时按整小时
  预占该模型单价，**提前 DELETE 按未用时长退回**（响应里的 `freebucksRefund`）；每日池在
  **太平洋午夜**重置。`freebucks.balance`（可花费余额）/ `daily.remaining`（今日池剩余）
  除以单价就是"还能用多久"（控制台直接折算成分钟）。
- **未计量模型**（`prices` 里没有该模型）：仍按 **模型 × 每日** 限次
  （上游 `rateLimitsByModel`，如 `limit: 6 / recentCount: 已用 / resetAt: 重置时间`）。

> ⚠️ 2026-08-09 实时探测：`deepseek/deepseek-v4-flash` 与
> `mimo/mimo-v2.5` 已重新出现在上游 `rateLimitsByModel` 中（当时为 6 次/天）。
> 代理不对它们做不限量豁免，始终以上游实时返回的限额为准。

- 控制台「总览」每个账号有两列额度：
  **额度（今日）** = 未计量模型的 `已用/上限` 与重置时间（`已用满` 红色、`≤2` 黄色、
  正常绿色，且 `recentCount` 按时长结算**是小数**，控制台保留两位不四舍五入）；
  **Freebucks** = 余额 `N FB` / 当前模型单价 `N/h` / **折算可用时长**（如 ≈`30 分钟`）
  / 今日池 `剩余/上限`，悬停可看钱包余额、计费方式与最近一次早退退款金额。
- 两个来源都在 **admit 时自动抓取**（上游仅在 session 响应里返回）；活跃 session 每 30s
  轮询刷新，session 结束后保留最后一次缓存值直到下次 admit。
- 想主动刷新余额：账号行的「检测」按钮或 `POST /api/accounts/probe` 做**只读探测**
  （GET session，不创建会话、不扣额度）。
- `rateLimitsByModel.recentCount` 可能是小数：admit 时先预占 1 小时额度，提前释放后按
  实际占用时长结算。因此**复用热 session + 空闲早退**比平均铺开账号更省额度。
- 同样可通过 `GET /v1/freebuff/status` 或 `GET /v1/freebuff/accounts` 拿到每个账号的
  `quota` 与 `freebucks`。

### 额度保护（Freebucks 计费，控制台可调）

`freebucks` 块是额度的唯一真源：

```json
{"balance":25,"daily":{"limit":25,"spent":0,"remaining":25,"resetAt":"..."},
 "wallet":{"balance":0,"monthlyBonus":0},"prices":{"deepseek/deepseek-v4-flash":2},
 "quotaExempt":false}
```

"账号空挂后台" = 白扣占用时长（issue #7），所以代理做了五件事：

- **空闲自动释放（默认 60s，可调 5s..24h）**：会话在途请求归零后开始计时，空闲超过该时长
  立即早退 `DELETE`——必须带 `x-freebuff-instance-id`，否则上游 400 `instance_required`，
  会话既删不掉也拿不到退款。交互式对话的停顿能复用同一会话，长时间没人用就立刻释放（退款能否到账见下方实测脚注）。
  `0` = 关闭（旧行为：留到过期，整小时照扣）。后台轮询不会顺延这个计时。
- **单请求新会话预算（默认 2）**：一个下游请求最多新建 2 条计费会话（首个账号 + 一次
  换号兜底）；复用热 session 不消耗预算，被上游拒绝的 admit（`rate_limited` 等）也不消耗
  （只有真的新建了会话才扣）。旧行为在报错时把"账号数 +1"个账号挨个 admit 一遍，
  几个账号一起在后台白扣时长。
- **两条封号判定都拦（`balance` 与每日池）**：上游对"额度不够"的封号判定有
  **两条**——① Freebucks 跑完了（今日池 `daily.remaining <= 0`）；② 本次请求所需
  Freebucks 高于剩余余额（`balance < prices[模型]`）。命中**任一条**就可能直接封号，
  所以两条都要拦。**此前只判了 ②**，于是"池子跑完、但 balance 还留着数字"的账号会被放行，
  照样送去撞封禁——现已修复，`reason` 会标明是 `daily_exhausted` 还是
  `balance_shortfall`（日志同样区分）。`quotaExempt` 账号不受池/余额限制；
  `daily.limit = 0` 表示"没有池子"而非"池子跑完"，不会误拦；每日池 `resetAt` 已过
  则视为本地数字过期，放行一次真实 admit 用上游最新余额重新校准。
  **同号重试（`forceReadmit`）也走同一道闸门**——它会先 DELETE 再 admit，等于新买一条计费
  会话，不过闸就等于拿真钱去撞"余额不够"的封号判定。
- **换号即释放**：账号级故障换号前，先把失败账号的会话早退 DELETE（结束会话、不让它继续
  在后台计时；退款能否到账见下方实测脚注）。
  > ⚠️ **"提前归还"的退款**至今**一次都没观测到**：截至 2026-09-13，线上代理账本与
  > rotator 独立账本的退款总额**都是 0**（`mink110x` 410 次 admit/release → 退款 0；
  > `oryx906i` 641 个请求 → 退款 0）。受控实验（admit 后 12s DELETE、重放 5 次等到 67s）
  > 也一直是 `freebucksRefundPending`，**没等到金额**。
  >
  > **但这不等于"上游不退款"**——官方客户端源码写明早退会按实际占用时长重算并
  > *"REFUNDS the unused window"*，且官方在 pending 期间**每 3 秒无限重放**，
  > 而我们只重放 ≈5.5s 就停手、之后仅靠进程重启扫尾。所以更像是
  > **"我们问得太早、且没再去问"**，而不是上游拒绝退。
  >
  > 因此：**省钱当前主要靠"少开会话"，不能靠"早退"**；早退仍保留（确认会话结束、
  > 不留 orphan、本来也是官方推荐用法），但**不要为了多拿退款去增加 admit/DELETE 次数**。
  > 完整证据链、官方源码出处与决定性实验协议见
  > [account-scheduling-and-refund.md](./account-scheduling-and-refund.md) §3。
  > 完整证据链与调参建议见 [account-scheduling-and-refund.md](./account-scheduling-and-refund.md)。
- **全部账号都买不起时给独立错误码**：`429 freebucks_exhausted`（而非笼统的
  `no_available_account`）——两者处境完全不同：前者等每日池刷新即可，后者要加号或等冷却。
  调用方与控制台据此区分，不必去猜。

两项都可在控制台「**额度保护**」卡片实时调整（持久化 `/data/settings.json`，无需重启）。

### 账号状态账本（`/data/account-state.json`）

账号的"人生履历"过去全在内存里，**一次重启就全丢**，于是重启后控制台分不出
"从未用过的干净号"和"已经被打废的号"，粘性调度还会把打过废的号当新号重新启用一遍；
更糟的是 `freebucks` 归零会让上面那道"买不起就别 admit"的闸门直接失忆放行——
重启后的第一个请求就会去撞一个已知余额不足的账号。

现在这些状态全部落盘（原子 tmp+rename、`0o600`、写盘去抖合并，不阻塞转发）：

- `firstSeenAt`（加入时间，取凭据文件创建时间）/ `bannedAt`（封禁时间）；
- `requests`（选号成功次数）/ `lastUsedAt`；
- `cooldowns`（账号级 + 模型级；**过期的冷启动时直接丢弃**，否则重启会把号永久锁死）；
- `freebucks` / `quota` / `lastProbe`（让额度闸门与"为什么刷新失败"跨重启存活）；
- `refunds`：**退款流水**（最近 100 条），每条记 `refund`（上游实退）、`expected`
  （按实际占用时长应付的金额）、`price`、`holdMs`（实际占用毫秒）与 `instanceId`；
- **时间轴**（控制台账号表「时间」列）：
  - `importedAt`（**导入时间**；老账号由 `firstSeenAt` 回填）、
  - `credentialUpdatedAt`（**凭证更新时间**，即 token 最后一次被写入：网页导入 /
    浏览器登录回调 / 开放 API 导入都会记）、
  - `scheduledMs`（**累计调度时长**）+ `schedulingSince` / `lastScheduledAt`
    （本轮起算点 / 上次结束时间）。`scheduledMs` 与 `requests` 是两个口径：
    前者是"真正占用了多久"，后者是"被选中几次"——长对话 1 次可能顶短批量几百次。

退款流水是为了能真正**对账**：原先只有一个内存里的 `lastRefund`"最新值"，既看不到历史、
重启就丢，"退款到底成没成功 / 金额对不对"根本无法回答。有了 `refund` 与 `expected` 两栏，
"实退 ≠ 应付"的差额（例如结算被挂在整点或 5 的倍数上）可以直接指出来，而不是只能怀疑
"退款是不是失败了"。控制台的 `refundTotal` / `refundExpectedTotal` / `refundPendingCount`
给出累计口径。

账号被删除时记录一并清掉，文件不会随删号无限增长。

### 工具签名兼容

控制台「总览 → 免费额度策略」提供「工具签名兼容」开关，默认开启。开启时，代理会在非空
`tools` 列表末尾补充 Freebuff 官方工具名 `end_turn`，避免工具请求被识别为外来工具集；关闭时
原样转发客户端工具列表。切换后立即生效并持久化到 `/data/settings.json`，无需重启。
