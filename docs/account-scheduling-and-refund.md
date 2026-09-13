# 账号并发 / 调度最优解 / 归还点数 —— 调研与结论

> 本文是 [freebuff-proxy](../README.md) 的专题调研文档，回答三个问题 + 一个前端需求。
> **证据等级**：`实测`（跑出来的数据）> `代码`（读一手源码得出）> `推理`（由前两者推出）> `未知`（没有证据，不当结论用）。
> 调研日期 2026-09-13。上游随时会变，价目/限额一律以**实时探测**为准，不要把本文数字当常量。
>
> **一手证据来源（可自行核对）**：
>
> - **官方客户端开源源码** `github.com/CodebuffAI/freebuff`（公开快照；`npm i -g codebuff`
>   装的 CLI 与 `npm i freebuff` 同源）——本文关于**退款/计费语义**的结论主要来自它；
> - **本仓库代码**（`src/`、`bin/`）与 **`test/repro-*.mjs`** 复现脚本；
> - **线上服务只读探测**：`GET /v1/freebuff/status`（管理员 key，不做任何写操作）；
> - **rotator 独立账本**：`freebuff-rotator/rotator/LEDGER.md` + `state/ledger.json`。
>
> ⚠️ **本文第 3 节有一次公开的自我纠错**：早先结论「早退永远不退点数」是**错的**，
> 被官方源码推翻；现行结论与证据见 §3.1。

---

## 0. 先回答"设了并发 2、开了 4 个在途，为什么只看到一个账号在跑"

**这是当前设计的预期行为，不是 bug。** 但你的直觉（"并发满了就该开第二个账号"）对应的是**另一种**调度策略，
项目里**曾经有过**，后来被撤掉了（见 §2.4）。实测复现：

```bash
node test/repro-concurrency.mjs sticky 3 2 16   # 3 个账号、每账号上限 2、16 个并发请求
```
```
账号分配: { 'acc-a@example.com': 16 }      ← 16 个请求全在 A 账号
每账号流峰值(mock 观测): { 'token-a': 2 }  ← 上游只同时看到 2 路流
总耗时: 12917 ms; 上游 admit 次数: 1; chat 次数: 16
结论: 用了 1/3 个账号; 单账号流峰值是否超上限: 否
```

同一条命令把上限改成 8（`sticky 3 8 16`）：峰值变成 8、总耗时 3376ms、**仍然只用 1 个账号**。

两个叠加原因：

1. **控件名字在骗人**：前端「账号调度 → 每账号并发」设的是**单账号同时转发几路流**——
   一个**溢出阈值**，不是"系统总并发"，也不是"达到就换号"的开关。
2. **调度器被设计成"能不换号就不换号"**（粘性优先 / drain, not rotate，见 §2）：
   账号没满员时新请求**就在这个账号上排队**，排队超时（冷账号默认 120s、热会话 75s）才溢出到下一个。

> 你看到的「在途请求 4/32」是**全局闸门**，与账号数无关。而且那 4 条里不少只是
> **在账号 lock 上排队**（还没开始上游 compute），所以"4 个在途、只有 1 个活跃会话"并不矛盾。

---

## 1. 一个 freebuff 账号，并发最多能到多少？

### 1.1 上游侧：**没有可观测的并发上限**

| 观测 | 等级 | 说明 |
| --- | --- | --- |
| 同一 `instanceId` 支持并发 chat | `实测` | mock 与真实上游都验证过；`src/app-context.js` ChatMutex 注释："实测同一 instanceId 支持并发 chat" |
| 一个账号同时只能有 **1 条 session**（多客户端互顶） | `实测` | 同账号换客户端 re-admit → 旧客户端收到 `superseded` / `waiting_room`；`SessionManager.refresh()` 在有在途请求时**直接跳过**轮询 GET，否则会干扰活跃会话 |
| 并发**条数**上限（429 / 专属错误码） | `未知` | 全仓库没有一处记录过"并发 N 条被上游拒绝"。`free_mode_capacity_deferred`（"Free mode is briefly at capacity"）是**免费模式容量排队**，不是"你这个号并发超了"——实测同 session 立即重试就恢复，项目因此**明确不为它冷却换号** |
| 并发**速率**上限（风控/封号阈值） | `未知，且危险` | 没有实证。但账号池里大量账号已被封（见 §3.3），历史上"轮换健康账号"被当作账号农场特征（ADR-0012）。所以"往上加并发"是**未知风险**，不是免费午餐 |

### 1.2 本项目建议值

`accountMaxConcurrency` 默认 **2**，可调 **1..16**。

- **交互式（人用，1~2 路）**：1 或 2。换号最少、最省点数、风控面最小。
- **批量脚本（要吞吐）**：4~8。用 mock 确认峰值 = 设定值、且没有 429。
- **不建议 >8**：没有证据能成，但有理由怀疑"同一账号并行几十路"是异常特征。

### 1.3 真正的限制是**点数**，不是并发

上游 2026-09 改成 **Freebucks**：每模型有单价（FB/小时），session 从 admit 起**按实际占用时长**结算，
每日池 100，太平洋午夜重置。**线上实时价目**（`实测`，2026-09-13 从 `/v1/freebuff/status` 的 `freebucks.prices` 读取）：

```
z-ai/glm-5.3-flash                5
crof/kimi-k3-eco                  5
upstage/solar-pro4                5
mimo/mimo-v2.5                   10
deepseek/deepseek-v4-flash       15   ← 主力模型
meta/muse-spark-1.2-contributor  15
meta/muse-spark-1.3-contributor  15
openai/gpt-5.6-luna(-es)         20
google/gemini-3.8-flash          50
```

> ⚠️ 价目**变动过**：`rotator/LEDGER.md` 2026-09-13 早些时候实测 flash = **25**，线上同时段是 **15**；
> 另有记录曾为 15。**不要把任何一次快照当常量**，一律读实时值。

**算账**：池子 100、flash 单价 15/h → 一个账号一天约 **6.7 个会话小时**。
短会话下这点额度其实很经用——**实测**：`mink110x` 一天跑了 **385 个请求**只花掉 **30 FB**，
`oryx906i` **293 个请求**只花 **30 FB**，而池子是 100。

---

## 2. 调度机制怎么才是最优解？

### 2.1 现状（v1.12.1，粘性优先 / drain, not rotate）

选号排序（`AccountRuntimes.candidateKeys`，`src/app-context.js`）：

1. **tier**：同模型热 session（复用零成本） > 冷账号 > 活跃 session 绑在别的模型上；
2. **used**：已用过的账号 > **从未用过的账号**（未用号排最后）；
3. **busy**：有空闲槽位的 > 满员的；
4. **lastUsedAt 倒序**：继续用最近用过的那个；
5. 在途少 > 额度耗尽 > 余额不足 > 轮询打破平局。

排队与溢出（`src/proxy.js`）：

- 选号后**必须再拿账号 chat 锁**（`runtimes.acquireChat`），容量 = `accountMaxConcurrency`；
- 满员时**有界排队**：热 session 等 `streamIdleTimeoutSec + 15s`，冷账号等 `accountChatWaitMs`（默认 120s）；
- **只有排队超时**才把账号加进 `skipKeys`，下一轮才真正换号；整个调度阶段另有总预算
  `schedulingBudgetMs`（默认 45s，防 Cloudflare 100s 524）。

### 2.2 为什么这么设计（不是拍脑袋）

- 上游把"轮换健康账号"当**账号农场特征**（ADR-0012：*cycling healthy keys looks like account farming*）；
- **换号 = 新买一条计费会话**：admit 按整小时**预占**，过早换号 = 重复预占（§3.1 的机制）；
- 所以"把请求集中到尽量少的账号、用尽才换"在**点数口径**上是对的。

### 2.3 代价（就是你遇到的）

1. **高并发被串行化**：上限 2 而有 4 路在途 → 后 2 路在同一账号干等。
   它们虽未产生上游 compute，但对**客户端就是"卡了"**（首字节延迟 ≈ 前一条流的剩余时间）。
2. **冷账号基本用不上**：除非排队超时（120s / 45s 预算），否则第 2、3 个号永远不动。
3. **空闲释放放大了这个效应**：`idle_release_sec` 默认 60s 会频繁早退会话，
   老会话更容易在"重建窗口"里命中排队 → 抢锁更激烈、尾延迟更差。

### 2.4 历史：项目**曾经**有你要的那个模式

| 提交 | 版本 | 做了什么 |
| --- | --- | --- |
| `086f4a2` | 1.5.2 | 加 `spreadFreeModels`（默认开）：**免费模型暴力分散到不同账号**，控制台可关 |
| `bc300fc` | 1.10.0 | "负载均衡重构（**平摊账号数**）" |
| `2914229` | 1.11.0 | "**粘性调度（最少换号）** + Freebucks 额度保护"——把平摊改成粘性 |

**"并发满了就开新号"和"最少换号"是两种模式，项目两个都做过，现在只剩后者。**

### 2.5 建议：做成**两种模式（默认粘性）**，而不是改掉粘性

理由：粘性在**点数**上仍最优；但"提交延迟"是真实痛点，而且免费模型本来就有
`free_model_re_admit_lead_sec = 60s` 的会话剩余阈值——**会话本来就会频繁重建**，
"为了复用热会话而排队"这个理由在免费模型上被大幅削弱。

**新增配置（控制台「账号调度」）**：

```json
{ "accountSchedulingMode": "sticky", "accountOverflowWaitMs": 15000 }
```

- `accountSchedulingMode`：
  - `sticky`（默认，= 现状）：满员先排队，超时才换号；
  - `spread`：**排序时把"有空闲槽位"的账号提前**，只在**所有账号都满员**时才排队；
    **保留**"已用账号 > 未用账号"（不平摊到全新号，降低农场特征）；
    但**当已用账号全部满员且还有未用账号时，允许启用一个未用账号**——这正是"申请新号"的语义。
- `accountOverflowWaitMs`：溢出前最长排队（sticky 保留大值；spread 用小值，如 15s）。

**与模式无关、保持不变**：冷却 / 余额不足 / 新会话预算闸门照旧；`maxNewSessionsPerRequest`（默认 2）照旧；
会话**无状态**（每次带全量历史），分散到多账号**不影响对话正确性**。

### 2.6 收益 / 代价（预期）

| | sticky（现状） | spread（建议新增） |
| --- | --- | --- |
| 冷启动首字节 | 排队等待（最长 120s / 预算 45s） | 立即有号 |
| 并发吞吐 | 单账号上限前后串行 | 线性铺开 |
| Freebucks 预占 | 最少 | 可能多预占（N 路铺 M 个号 → 最多 M 条会话） |
| 账号农场特征 | 最低 | 略高（仍是"已用账号优先"） |

---

## 3. 归还（关闭会话 / 早退 DELETE）到底退不退 Freebucks？

### 3.1 结论（2026-09-13 修订 — 旧结论已被推翻）

> ⚠️ **本节早先的结论「早退永远不退 Freebucks」过强，已被官方源码推翻。**
> 正确表述是：**官方设计上「提前结束 = 按实际占用时长重新结算 = 退还未用时长」**
> （下面有官方源码原文），**但我们的观测里从来没有收到过非 0 退款**。
> 所以矛盾在**「上游结算没按时落地」或「我们的轮询窗口太短」**，
> 而**不是**「上游根本不退」——后者是被证伪的。

#### 官方口径（`代码`，一手，可自行核对）

证据来自**官方客户端开源源码**：`github.com/CodebuffAI/freebuff`
（公开快照，commit 信息 `Sync public snapshot from freebuff-private`；
`npm i -g codebuff` 装的 CLI 与 `freebuff` 包同源）。

| 位置 | 原文 / 事实 |
| --- | --- |
| `common/src/constants/freebuff-models.ts:2592` | **“Ending early is not a forfeit: the server re-stamps `session_units` to the fraction actually elapsed (`buildAdmitStampStatement`), so this REFUNDS the unused window and the next send re-admits on the same instance id.”** |
| `common/src/types/freebuff-session.ts:840` | `freebucksRefund?: number` —— *“Final early-end refund receipt, **including zero**; retries return the same amount.”* |
| `common/src/types/freebuff-session.ts:842` | `freebucksRefundPending?: boolean` —— *“Final usage is still outstanding; replay DELETE with the same instance for its receipt.”* |
| `common/src/constants/freebuff-models.ts:2581` | `FREEBUFF_SESSION_GRACE_MS = 30 * 60 * 1000`（**30 分钟**宽限窗） |
| `cli/src/hooks/use-freebuff-session.ts:465` | 官方客户端在 pending 期间**每 3 秒无限重放** `refreshRefund()`，直到拿到终态 |

> 结论：`ended` + **有** `freebucksRefund` = 实退（可为 0）；`freebucksRefundPending: true` = **未结算**，
> 必须继续用**同一个 instanceId** 重放。这与我们的实现口径一致。
> **注意：这不是"公告"，是官方源码。** 我没有找到专门讲退款的公开公告页 ——
> 对行为规格而言，源码比公告更硬（可核对、可复现），但它描述的是**设计意图**，
> 不保证线上每次都按它执行。

#### 我们的接口没坏（`代码`）

`src/upstream/client.js:5` 的 `FREEBUFF_INSTANCE_HEADER = 'x-freebuff-instance-id'`
与官方 `common/src/constants/freebuff-models.ts:2503` **逐字一致**；DELETE 带 instanceId、
pending 时用**同一 instanceId** 重放，也都和官方 `cli/src/utils/freebuff-session-api.ts:116` 同构。
**所以"接口坏了"可以排除。**

#### 那为什么我们一次非 0 退款都没见到？

| 来源 | 证据 |
| --- | --- |
| **线上账本**（`实测`） | 10 个账号 `refundTotal = 0`、`refundExpectedTotal = 0`、`refundPendingCount = 0`、`refunds = []`。`oryx906i` 641 请求 / `mink110x` 385 请求，一条非 0 流水都没有 |
| **rotator 账本**（`实测`） | `mink110x` refund_count 7 / refunded_total 0 / last_refund 0；`oryx906i`、`loliyoknvrgq`、`mink460t` 各 1 次、**全是 0** |
| **受控实验**（`实测`） | DELETE 后重放到 **67s** 仍 `freebucksRefundPending: true`，**连金额字段都没出现** |

**最可能的工程原因（`推理`，待验证）：我们的轮询窗口比官方短两个数量级。**

- 官方：pending 期间**每 3s 无限重放**，只要拿到终态为止（可跨分钟乃至更久）；
- 我们：`_releaseUnlocked` 只重放 **2 次（+1.5s、+4s ≈ 5.5s）** 就放弃；
  之后**原先**仅在**进程下次启动**扫 orphan 时再试（`session-handles.cleanupOrphans`）。
  服务长期不重启 ⇒ 这笔结算**再也没有人去要**。
  **（修复方案已设计，但按用户要求推迟到下一版，见 §3.6。本版未包含。）**

> 换句话说：**上游说"还没结算完，待会拿同一个 id 来取"**，
> 而我们**问了 5.5 秒就走了，此后再没回来问过**。
> 这足以解释"从没见过退款"，且**不需要**假设上游不退款。

#### 仍未确定的部分（诚实标注）

1. **pending 究竟多久才结算**（官方 3s 轮询暗示"可能很久"，30 分钟宽限窗是另一个线索）；
2. **结算出来到底是不是 0** —— 官方说"按实际占用比例退"，但要验证；
3. 受控实验里 12s 就 DELETE，此时可能**还没跨过上游的结算粒度**。

**决定性实验（尚未做，需要真实账号 + 消耗额度）：** admint 后**等满一段时间**（如 30 分钟）再 DELETE，
并按官方节奏**每 3s 重放 DELETE 至少 30 分钟**，观察 `daily.spent` / `balance` 是否回落。
跑完这一步之前，**不要**再把"退款"当作可依赖的省钱手段，
但也**不要**再说"上游永不退款"。

### 3.2 计费机制

上游的计费模型（`rotator/LEDGER.md` §2 + `src/session-manager.js` 注释）：

- 单价 **FB/小时**；`POST /session`（admit）**按整小时预扣**该模型单价；
- 提前 `DELETE` 时，理论上应把**未使用的那部分时长**按比例退回（`freebucksRefund`，可为小数）；
- **推论（退款审计判据）**：所有模型单价都是 **5 的倍数**（见 §1.3 价目），
  纯按小时结算只会产生 **5 的倍数**；所以**任何"每日已用"的非 5 倍数增量，只可能来自按分钟折算的退款**。
  -> `daily.spent` 只观察到**单调上升**（0 -> 25 -> 60 -> 75 -> 90），**从未回退**，也从未出现非 5 倍数。
  -> ⚠️ 这条推论的**前提有误**：它假设"退款必然产生非 5 倍数"。但若上游按 `session_units`
     重算后**退款正好=0**（占用时长取整到 0），`spent` 同样不会回退、也不会出现非 5 倍数。
     所以"单调上升"**只能**证明"没有非 0 退款"，**不能**证明"上游不支持退款"。

### 3.3 受控实验：67 秒内未结算（`实测`）

> 注意：下面的实验**只能**得出"重放到 67s 仍是 pending"，**不能**得出"永不退款"——
> 官方客户端在 pending 时会**每 3s 无限重放**，我们这个实验的重放窗口远短于官方。

用户批准后用真实账号 `mink110x` 做的完整实验（`rotator/LEDGER.md`，直接打上游
`/api/v1/freebuff/session`，模型 `z-ai/glm-5.3-flash`，当时单价 5）：

| 步骤 | 结果 |
| --- | --- |
| 基线 `GET` | `balance 5 / daily {limit:25, spent:20, remaining:5}` |
| `POST` admit | 200，`balance 0 / spent 25 / remaining 0` —— 预扣 5 |
| 等 **12s** 后 `DELETE` | `{"status":"ended","freebucksRefundPending":true}` —— **没有金额** |
| 重放 DELETE ×5 | 累计等到 **67s**，五次**全是** `freebucksRefundPending: true` |
| 最终 `GET` | `balance 0 / spent 25 / remaining 0` —— **一分钱都没退** |

早期另有三条真实 DELETE 回执，全是 `{"status":"ended","instanceId":"..."}`、**没有 `freebucksRefund` 字段**。

### 3.4 退款审计口径（**这条务必分清**）

- `{"status":"ended"}` + **无** `freebucksRefund` = **退款 0**（不是"未知"）—— 参考实现 af898dc 语义；
- `freebucksRefundPending: true` = **未结算**，**不能当"退 0"读**——把挂起读成 0 会让挂起永久搁浅。
  项目里 `session-manager.js` **有界重放 3 次**（1.5s -> 4s），仍 pending 就**保留 instanceId**
  落盘成 `orphan`，交给下次释放 / 下次启动扫尾继续要。

### 3.5 为什么会这样（`推理`，两个候选解释）

**解释 A：结算没被等到（工程问题，可修）。**
上游返回 `freebucksRefundPending: true` 的含义就是"还没结算完，拿同一个 instanceId 再来取"。
官方客户端**每 3s 无限重放**直到拿到终态；我们只重放 2 次（≈5.5s）就停手，
**且之后仅在进程重启时才会再试**。生产服务长期不重启 ⇒ 这些 pending 结算**再没人去取**。
这单独就能解释"从没见过非 0 退款"，且不需要假设上游不退款。**这是当前最可疑的一条。**

**解释 B：结算确实算成 0（账期粒度）。**
我们的用法（60s 空闲释放 + 60s re-admit lead）让**绝大多数会话在 1~5 分钟内结束**；
若上游按某个粗粒度（如整 5 分钟 / 整点）计入 `session_units`，几秒~几分钟的占用取整后 = 0。
12 秒的受控实验与此一致。

两者**不互斥**，且都能解释现有观测。**要区分只能做 §3.7 的决定性实验。**

### 3.6 策略该怎么办？

**建议：在 §3.7 的决定性实验跑完前，"早退退款"**不能**作为可依赖的省钱手段；但早退本身保留。**

1. **省钱主要靠"少开会话"，不是"早退"**：
   现状 `maxNewSessionsPerRequest=2` + 粘性调度 + 60s 空闲释放 = **一天 380+ 个请求只花 30 FB / 100**
   （实测）。**这一条与退款是否成功无关**——少开会话本身就省，是当前唯一被验证的省钱手段。
2. **早退不是零成本**：DELETE 后要重建 session（重新 admit = 重新预扣整小时），
   而 `free_model_re_admit_lead_sec = 60s` 本就会在剩余 <60s 时重建——**多余释放制造多余 admit**，
   并让"排队等热会话"变多（§2.3 第 3 条），尾延迟更差。
3. **但不要关掉它**：DELETE 确认会话结束**本身有价值**（不占上游会话槽位、不留 orphan），
   官方源码明确它"refunds the unused window"；关掉后会话会挂到过期、整小时照扣，那是**确定性**浪费。

**调参建议**：

| 设置 | 现在 | 建议 | 理由 |
| --- | --- | --- | --- |
| `session.idle_release_sec` | 60 | 交互式 **180~300**；批量可保持 60 | 减少"释放->重建"抖动；几秒的占用反正退不回来 |
| `session.free_model_re_admit_lead_sec` | 60 | 保持 60 | 避免请求打到马上过期的会话上 |
| `limits.max_new_sessions_per_request` | 2 | 保持 2 | 换号成本 = 新买一条计费行 |
| `accountMaxConcurrency` | 2 | 按场景 1~4 | 见 §1.2 |

**不要做**：为了"多拿退款"而增加 admit/DELETE 次数——在验证清楚之前，那只会多买会话。

**方案（针对解释 A，已设计、⚠️ 推迟到下一版，本版未实现）**：把 pending 结算改成**周期性重试**。

> 用户 2026-09-13 决定：**先发版调度 + 时间字段功能**(v1.13.0)，
> **退款这条放到下一个版本**。所以下面列的是**待办设计**，不是已交付状态。

- `app-context.startOrphanSweeper({ intervalMs })`：每 60s 重放一次 pending 结算，
  直到拿到终态（无 orphan 时零成本空转）；
- `bin/serve.js` 启动时挂上、`shutdown` 时停掉（用返回的 stop 函数）；
- 回归测试 (7.6)：**等一个真实定时器 tick**（不是手动调函数）验证会自动取回结算；
  已反向验证"把定时器改成空转就 fail"，所以它真的能挡住这个 bug。

这是**纯收益**改动：不增加任何 admit/DELETE，只是把已经在 pending 的结算要回来。
（若结果是"退回 0"，也能一次性拿到**确定结论**，把 §3.7 的悬案关掉。）

### 3.7 仍未定论（不要当结论）

1. **`freebucksRefundPending` 会不会最终结算？** 目前只能证明"67 秒内不会"，
   **不能**证明"永远不会"——官方每 3s 无限重放，我们只重放 ≈5.5s。
   项目已把它落盘成 orphan，但**只在启动时重放**（周期重放见 §3.6，待下一版）。
   所以生产环境的长期 pending 目前仍基本等于"没人再去取"。
   等周期重放上线并跑一段时间后**仍然全是 0**，那才是"真的退不回来"的强证据；
   在那之前，orphan 更像是"我们没去要"。
2. **是否存在"退得回来"的条件**（特定模型 / 更长占用 / 特定时段）？没有证据。

   **决定性实验协议（尚未做）**：
   1. `GET` 记录基线 `balance` / `daily.spent`；
   2. `POST` admit；
   3. **等满 30 分钟**（对齐官方 `FREEBUFF_SESSION_GRACE_MS`）再 `DELETE`；
   4. 照官方节奏**每 3s 重放 DELETE，持续至少 30 分钟**（而不是我们的 5.5s）；
   5. 结束后 `GET` 对比 `daily.spent` 是否回落、回执是否出现 `freebucksRefund`。

   预期：若回执最终出现金额 >0 ⇒ 解释 A 成立（我们之前是**问得太早**）；
   若终态回执金额 = 0 ⇒ 解释 B 成立（确实按账期取整成 0）。**两种结果都能结案。**
3. 参考实现 trefeon/freebuff-proxy 的测试夹具有**分数退款**（1.5 ×3、2.5 ×1），
   说明上游**有能力**按比例退——所以"一直退 0"更像**我们的会话没跨过结算窗口**，
   而不是"上游不支持小数"。这也是 §3.7.2 那个实验值得做的原因。

---

## 4. 首字节耗时剖析（"首次耗时有点久"到底是哪一段）

复现脚本：`node test/repro-firstbyte.mjs 580 sticky`（580ms = 实测到 `codebuff.com` 的单次 RTT：
`curl` 实测 connect 0.18s / TLS 0.35s / TTFB **0.578s**）。

**优化前**（每格是"首字节前调用了几次上游"）：

| 场景 | 首字节 | 首字节前的上游串行调用 |
| --- | --- | --- |
| [1] 首次（冷启动） | **3053 ms** | session:GET → session:GET → session:POST → agent-runs:START → chat:POST |
| [2] 紧接着第二次 | 1320 ms | agent-runs:START → chat:POST |
| [3] 第三次（热） | 1185 ms | agent-runs:START → chat:POST |
| [4] 空闲释放后第一条 | 2471 ms | session:GET → session:POST → agent-runs:START → chat:POST |

**优化后**：

| 场景 | 首字节 | 变化 |
| --- | --- | --- |
| [1] 首次（冷启动） | **1927 ms** | **−1126 ms（−37%）** |
| [2]/[3] 热 | ~1290 ms | 不变 |
| [4] 空闲释放后第一条 | **1868 ms** | **−603 ms（−24%）** |

两处修复（都在**冷路径**上，热路径本来就只有 START + chat 两个 RTT）：

1. **去掉 admit 前多余的 `session:GET`**（`session-manager.ensureSession`）：
   上游同一个账号同一时间只能有一个客户端在线，而本进程的会话状态由 session-manager
   单点持有、admit/释放/轮询同用一把锁——那次 GET 只在"本进程之外有人用同一个号"时
   才有意义。模型不符的兜底本来就存在：admit 会返回 `model_locked`，`_admitUnlocked`
   内部会释放并重试一次。**省 1 个 RTT。**
2. **模型白名单校验不再无条件预热上游探测**（`proxy.handleChatCompletions`）：
   原来每条请求都先 `await probeUpstreamSessionCached()`（60s 缓存，但**首条必付**）
   才做本地判定。改为**先用本地三张表**（catalog / 前端自定义 / 隐藏）判定——它们覆盖
   绝大多数请求——命中就直接放行、探测改为后台预热不阻塞；只有本地都不认识的模型
   才 `await` 那次探测。**省 1 个 RTT（首条）。**

### 4.1 剩下这些时间是花在哪的（都是**必要**的上游往返）

冷路径 3 个 RTT、热路径 2 个 RTT，且全部发生在**上游首字节之前**：
`session:POST`（admit，建计费会话）→ `agent-runs:START`（注册 run）→ `chat:POST`（真正生成）。
按 580ms RTT 算，热路径 ~1.2s 是"上游本身就要串行做两次往返"，不是代理的额外开销。

要再快只能从**产品**上取舍，而不是改调度：

- **`requestJitterMs`（默认 200ms）**：每条 chat 前随机等 `[0,200)ms` 打散节奏（防风控指纹），
  平均白付 100ms。嫌慢可以调小或设 0（代价是节奏更机械）。
- **保留热会话**：把 `session.idle_release_sec` 从 60s 调大（见 §3.6），
  少一次"释放→重建"，[4] 那条 1.8s 就不会天天出现。
- `agent-runs:START` 是上游协议要求的（chat 需要 `runId`），不能省。

### 4.2 顺带纠正一个观察误区

mock 里看到"两次 `agent-runs` 调用"，其中第二次是 `action: FINISH`
（`proxy.js` 里是 `void finishAgentRun(...)`，**best-effort、不阻塞首字节**），
不是重复 START。统计首字节耗时时必须把它排除，否则会误判。

---

## 5. 前端要展示的时间与运行时字段（持久化）

### 4.1 需求

展示 **①导入时间 ②凭证更新时间 ③调度运行时长**，**都要持久化**。

### 4.2 现状（`src/account-state-store.js`）

- `firstSeenAt`（加入时间）**已有**，取值来自**凭据文件创建时间**（`birthtime`，回退 `mtime`，
  见 `AccountRuntimes._importedAtHint()`）。这是"导入时刻"的**近似**——服务内导入即文件创建瞬间，够用；
  但**分不出"导入"与"外部覆盖写文件"**。
- 已知缺陷：`_restoreAccountState()` 在**构造期**就把 `firstSeenAt` 写进账本，而
  `list()` 用 `accountState.account(key, hint)` 对**已存在**记录**不再校正**——
  所以"当时文件时间探测失败 -> 记成今天"的错误会**永久留存**。
- `lastUsedAt` / `requests` **已持久化**；**缺**：凭证更新时间、累计调度时长、当前会话开始时间。

### 4.3 新增字段（`/data/account-state.json`）

| 字段 | 类型 | 含义 | 写入点 |
| --- | --- | --- | --- |
| `importedAt` | ISO string | **导入时间**（首次被服务看到的时刻） | `saveAccountUser` 之后；老账号由 `firstSeenAt` 回填 |
| `credentialUpdatedAt` | ISO string | **凭证更新时间**（token 被写入的时刻） | 每次 `saveAccountUser`（网页导入 / 浏览器登录回调 / 开放 API 导入） |
| `scheduledMs` | number | **累计调度时长**（毫秒，跨会话累加） | 在途归零时结算一次 |
| `schedulingSince` | ISO string \| null | **本轮调度开始时间**（有在途流时非空） | `beginRequest` 时若为空则写入 |
| `lastScheduledAt` | ISO string | 最近一次调度结束时间 | 在途归零时 |

`scheduledMs` + `schedulingSince` 一起，前端可显示 **累计调度时长** + **当前连续运行时长**（有在途时）。

### 4.4 实现要点

- 结算放在 `SessionManager`：`_inFlight` 从 >0 -> 0 的那一刻（`endRequest` / `dropChatHold`），
  经 `onStateChange` 上报（复用现有**去抖落盘**通道，**不阻塞转发**）。
- 重启后 `scheduledMs` 从账本回灌；`schedulingSince` **跨进程无意义**（在途流已没了），
  启动时**清空**，避免显示一个假的"运行了 3 天"。
- 前端账号表新增「时间」列（`导入 … / 更新 … / 调度累计 …`，悬停看完整时间）。

---

## 6. 落地清单

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `docs/scheduling.md` | 修正"并发上限"措辞（它是**溢出阈值**）+ 指向本文 |
| 2 | `src/web/settings-store.js` | 新增 `accountSchedulingMode`（默认 `sticky`）、`accountOverflowWaitMs` |
| 3 | `src/app-context.js` | `candidateKeys` 支持 spread 排序；`list()` 暴露新时间字段；`importedAt` 校正 |
| 4 | `src/session-manager.js` | 调度时长统计（`schedulingSince` / `scheduledMs`） |
| 5 | `src/web/api.js` | `GET/POST /api/settings` 支持新字段；导入时记 `credentialUpdatedAt` |
| 6 | `src/proxy.js` | 开放 API 导入路径同样记 `credentialUpdatedAt` |
| 7 | `dashboard/app.js` | 账号表新增「时间」列 + 调度模式切换控件 |
| 8 | `test/smoke.mjs` | spread 模式回归（满员换号）+ 时间字段持久化断言 |
| 9 | `src/session-manager.js` | 去掉 admit 前多余的 `session:GET`（§4，首字节 −580ms） |
| 10 | `src/proxy.js` | 模型白名单改为"先本地判定、未知才探测"（§4，首字节再 −580ms） |
| 11 | `test/repro-firstbyte.mjs` | 首字节耗时剖析脚本（可复现 §4 的表） |
| 12 | `package.json` | `npm version minor` → **v1.13.0 本次发布** |

**⏭ 明确推迟到下一版（用户 2026-09-13 决定）**：

| # | 文件 | 待办（设计已完成，代码已撤回） |
| --- | --- | --- |
| A | `src/app-context.js` | `startOrphanSweeper()`：周期性重放 pending 退款结算（§3.6 解释 A） |
| B | `bin/serve.js` | 启动挂上 / `shutdown` 停掉周期退款扫尾 |
| C | `test/smoke.mjs` | 回归：等**真实 tick** 验证结算被自动取回（当时已反向验证会 fail） |
| D | 真实账号 | §3.7 决定性实验：admit → 等 30 分钟 → DELETE → 每 3s 重放 30 分钟 |

> 注：A–C 曾在本版实现并通过测试，但为遵守"先发调度功能、退款下一版"的要求
> **已从工作区撤回**，`git diff` 中不含这些改动。设计要点保留在上面 §3.6，下版可直接照做。

> ⚠️ **`AGENTS.md` 冲突提示**：AGENTS.md 写着"**绝不主动把并发平摊到多个账号**"、
> "**并发上限是'溢出'阈值而非'换号'阈值**"。本次新增的 `spread` 模式与该表述冲突——
> `AGENTS.md` 是最高优先级约定，**修改它需要用户明确同意**。因此实现上 `spread` **默认关闭**，
> 与现约定保持一致；是否改 AGENTS.md 由用户决定。
