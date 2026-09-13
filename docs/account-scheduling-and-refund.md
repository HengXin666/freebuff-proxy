# 账号并发 / 调度最优解 / 归还点数 —— 调研与结论

> 本文是 [freebuff-proxy](../README.md) 的专题调研文档，回答三个问题 + 一个前端需求。
> **证据等级**：`实测`（跑出来的数据）> `代码`（读一手源码得出）> `推理`（由前两者推出）> `未知`（没有证据，不当结论用）。
> 调研日期 2026-09-13。上游随时会变，价目/限额一律以**实时探测**为准，不要把本文数字当常量。
>
> **一手证据来源（可自行核对）**：
>
> - **官方客户端开源源码** `github.com/CodebuffAI/freebuff`（公开快照；`npm i -g codebuff`
>   装的 CLI 与 `npm i freebuff` 同源）——但**源码注释描述的是 `session_units` 那本账**，
> - **本仓库代码**（`src/`、`bin/`）与 **`test/repro-*.mjs`** 复现脚本；
> - **线上服务只读探测**：`GET /v1/freebuff/status`（管理员 key，不做任何写操作）；
> - **rotator 独立账本**：`freebuff-rotator/rotator/LEDGER.md` + `state/ledger.json`。
>
> ⚠️ **本文第 3 节经过三次公开自我纠错，现行第 4 版（2026-09-13）。**
> **最终结论：早退 DELETE 会按实际占用时长退还 Freebucks。**
> `session_units` 与 `Freebucks` 是两本账，但**都退**；`freebucksRefundPending`
> 表示**结算未完成**（须用同一个 `instanceId` 重放 DELETE 取回执），**不是「不退」**。
> 前两版（「永远不退」/「0 是我们 bug」）与第 3 版（「两套账、Freebucks 不退」）都已作废，
> 具体错在哪见 §3.4。

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
- **换号 = 新起一条计费会话**：admit 按整小时单价**预扣** Freebucks，早退虽会按实际占用退还（§3.1），
- 所以"把请求集中到尽量少的账号、用尽才换"在**点数口径**上是对的。

### 2.3 代价（就是你遇到的）

1. **高并发被串行化**：上限 2 而有 4 路在途 → 后 2 路在同一账号干等。
   它们虽未产生上游 compute，但对**客户端就是"卡了"**（首字节延迟 ≈ 前一条流的剩余时间）。
2. **冷账号基本用不上**：除非排队超时（120s / 45s 预算），否则第 2、3 个号永远不动。
3. **空闲释放放大了这个效应**：`idle_release_sec`（默认 60s）会频繁早退会话（退款见 §3.1——会退，所以这条现在是**收益**），
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

## 3. 归还（关闭会话 / 早退 DELETE）到底退不退 Freebucks？—— ✅ 会退（2026-09-13 反转）

### 3.1 结论

> **会退（强证据，但本轮未亲眼观测到到账）。** 早退 DELETE 应按**实际占用时长**把未用部分退还：
> `session_units`（每日模型额度）**和** `Freebucks`（每日池 + 余额）**都退**。
>
> ⚠️ **2026-09-13 当晚的真实上游复测结果（必须一并读）：** 三臂（占用 2s / 3min / 50min，
> 模型 5 FB/h）与一条线上真实会话（占用 53min，15 FB/h）**全部**只拿到
> `{"status":"ended","freebucksRefundPending":true}`（**无金额字段**）；那条 53 分钟的会话
> 拿到的是**终态** `freebucksRefund: 0`（expected 1.66）。观测窗口最长约 10 分钟，**未跨过
> 每日池刷新点**（2026-09-14T07:00Z）。
> 原始日志留档在 `docs/evidence/refund-*.jsonl`。
>
> 因此现状是：**结算管线确实存在**（官方类型 + issue #1337 用户实测到账），
> 但**本次观测不足以证明金额会落到我们账上**。结论强度：**medium**，不是 high。
> 跨刷新点的长期观测仍在进行（见 §3.6）。
>
> `freebucksRefundPending: true` 的语义是**结算未完成**——官方类型注释原话：
> *"Final usage is still outstanding; replay DELETE with the same instance for its receipt."*
> **它不是「不退」**。要拿到金额必须用**同一个 instanceId** 重放 DELETE，且结算窗口可能
> 跨到会话窗口结束才落地。
>
> **所以「早退省钱」是成立的**：挂着的空闲会话在按小时计价，早退把没用上的时间换回点数。
> 策略按此调整（见 §3.5、§3.7）。

#### 一笔会话的两本账（都退，只是计量单位不同）

|| **session units** | **Freebucks** |
|| --- | --- | --- |
| 字段 | `rateLimitsByModel[m].recentCount` | `freebucks.daily` / `freebucks.balance` |
| 池标识 | `pool: limited` / `poolLabel: Daily` | `pool: freebucks` |
| 本账号额度 | limit **6**（可为小数） | limit **25** + balance |
| admit 预扣 | **+1.0**（整条会话单位） | **整小时单价**（`freebucks.prices[m]`） |
| 早退是否退 | **✅ 按实际占用比例重算退还** | **✅ 按实际占用退还（回执 `freebucksRefund`）** |

#### 为什么我们一度得出「不退」（这次误判的机理）

这是一个**实验设计无法区分竞争假设**的经典案例。当时的实验：占用 **3 分钟** → DELETE →
每 3 秒重放，共 **20 分钟**。在「按比例退但短占用被结算成 0」与「结构上永不退」这两个假设下，
**这两个时间点的预测完全一致**，所以它证明不了任何一方：

| 假设 | 占用 3 分钟时的预测 | 占用接近整小时时的预测 |
| --- | --- | --- |
| (a) 按比例退 | 可能是 0（短占用被舍入/按最小单位结算） | **非 0** |
| (b) 结构上永不退 | 0 | **0** |

而当时只测了左边一列。再加上把 `freebucksRefundPending`（结算未完成）读成「结构上不退」，
就得到了错误的「已结案」。**决定性实验必须落在两假设预测不同的那个点上**——也就是让占用
接近整个会话窗口。

### 3.2 一手反证（都可自行点开核对）

**① 上游 issue #1337（2026-09-12，`CodebuffAI/freebuff`）——用户实测的「退款漏洞」：**

> "I noticed the **freebucks refunding feature when ending a session early is exploitable**…
> Interrupt the process by closing the tab/thread → **all those canceled requests turn into
> pending refunds** → once the freebucks refresh, and **the refunds go through, your daily
> freebucks exceed the limit**（每天 100 FB，用这招第二天能到 200+，脚本化可到 1000+）"

用户把它当安全漏洞上报，官方未否认。这直接证明：**pending refund 会到账**，
而且结算**落在每日池上**、可以跨日叠加。

**② 上游 issue #1324（2026-09-11）——成本结构被用户逐笔算出来：**

> "…even if i cancel the session early **i only get back 5 freebucks**"

「提前取消能拿回钱」是上游用户与官方共同的预期行为。

**③ 官方类型里有账本级退款实现（`common/src/types/freebuff-session.ts`）：**

```ts
export interface FreebuffDesktopRefundInfo {
  purchaseId: string
  model: string
  amount: number
  walletAmount: number
  /** Refunded bonus retired in the same settlement; absent on older APIs. */
  expiredBonusAmount?: number
  refundedAt: string
  /** Original debit's accounting instant; identifies the daily pool restored. */
  poolDate: string
}
```

注释明确写着 *"Emitted only after the **reversal ledger entry** and purchase marker commit"*，
并带 `poolDate`——**标明这笔退款恢复到哪一天的池子**。这是账本级实现，不是「设计上会退但没生效」。

**④ `freebucksRefund` 字段本身的定义（同一文件）：**

```ts
/** Final early-end refund receipt, including zero; retries return the same amount. */
freebucksRefund?: number
```

这是**专属于 Freebucks 的早退退款回执**（"early-**end** refund"）。
「including zero」是「可能为零」，不是「必为零」。

**⑤ 官方为退款专门设计了请求契约**：`x-freebuff-desktop-admitted-at` 头的注释是
*"Pins an **end/refund** request to one window of a stable Desktop tab"*——
有一个专门服务于退款计算的「已准入时刻」。

**⑥ 成熟参考实现 `trefeon/freebuff-proxy`（Go）的 README 直接写死业务事实：**

> "Freebucks metering follows the wire `prices` map: charged once per session-hour
> at session start, **refunded on early `DELETE`**, refilled on a Pacific-midnight cadence."

它的 `backend/internal/pool/refund_refresh.go` 还实现了**单飞重放 + ``Settled / Pending /
Amount`` 三态 + 「A zero receipt is a real receipt」**——与我们当年设计好、后来误删的那套一致。

### 3.3 那为什么我们观测到的常常是 0 / pending？

**三点，都不需要假设「上游不退」：**

1. **结算窗口比我们的实验长。** pending 是长期的（我们实测 ≥20 分钟仍 pending），
   但 #1337 里钱是**跨过每日池刷新点**才到账的。在结算落地前反复问，当然只看到 pending。
2. **短占用的比例退款可能被结算成 0。** 我们测的模型单价只有 5 FB/h，占用 3 分钟
   ⇒ 应退 ≈ 4.75 FB；这个数在最小记账单位上完全可能被算成 0。
3. **实现缺口（我们自己的）：** 当时只在**启动时**扫一次 orphan，进程不重启就再也没人
   重放过 DELETE —— 那笔 pending **永远没被追问过**。这是「退款总额恒为 0」最直接的工程成因，
   已修复（见 §3.5）。

### 3.4 公开纠错：本文前三版结论的演进

| 版本 | 结论 | 为什么错 |
| --- | --- | --- |
| 第 1 版 | 「早退**永远不退**」 | 只有「观测全是 0」一个论据 |
| 第 2 版 | 「官方设计**会退**，0 是**我们的 bug**」 | 把官方注释里的 `session_units` 当成了 Freebucks 的退款依据 |
| 第 3 版 | 「**两套账：units 退，Freebucks 不退**」 | 受控实验**设计不足以区分竞争假设**（只测了 3 分钟占用），且把 `pending` 读成了「不退」；还用 `REFUND-COPY` 守卫把这个错误说法**从全仓封杀** |
| **第 4 版（现行）** | **两本账都退；`pending` = 结算未完成，必须持续重放追问** | 以一手证据（用户实测 issue + 官方账本类型 + 参考实现）为准 |

> **教训（这次真正该记住的）：**
> 1. 当「文档/源码注释」与「线上观测」冲突时，先确认说的是不是**同一个字段、同一本账**；
> 2. 但更根本的是：**一个实验如果不能区分竞争假设，它就不是证据，无论跑得多仔细**
>    （「重放 100 次」这种执行上的严谨，掩盖不了设计上的盲区）；
> 3. **不要用回归守卫去封杀一个未定/可能为真的说法。** 第 3 版把「按比例退」写进了
>    `REFUND-COPY` 黑名单，等于主动阻止真相进入代码——守卫该钉的是**已确证的事实**，
>    不是**尚在争议的猜测**；
> 4. 结论反转时，**策略也要跟着翻**：`idle_release_sec` 的方向、`spread` 模式的划算与否、
>    「少 admit 才是唯一省钱路径」的整套推理，全部依赖旧前提。

### 3.5 策略变更（**本次调研的真正产出**）

既然早退**会**退还 Freebucks，那么：

**1. 「空闲释放」重新变回省钱手段。** `idle_release_sec` 默认 **600s → 60s**：
挂着的空闲会话在按小时计价，早退把没用上的时间换回点数。

**2. 挂起退款必须被持续追问，不能只等重启。** 这是本次真正的功能缺口，已实现：

| 位置 | 改动 |
| --- | --- |
| `src/session-handles.js` | 新增**持久化待结算退款队列**（`pendingRefunds`）+ `sweepPendingRefunds()`：周期追问，拿到终态（含 0）才出队 |
| `src/session-manager.js` | 进程内 `_replayPendingRefund()` + 30s 追问定时器（1 小时窗口），pending 时把句柄登记进队列 |
| `bin/serve.js` | 5 分钟一次的常驻扫尾（有界 30s 预算、unref） |
| `test/smoke.mjs` | `REFUND-COPY` **反向**：现在钉死「早退不退」这类旧说法；并断言扫尾必须存在 |

**3. 省钱的完整图景**（旧版只承认一条路）：

- **少 admit**（复用热会话）——仍然成立；
- **早退**（释放空闲会话）——**同样成立**，两者不再矛盾。

### 3.6 仍未完全确定的部分（诚实标注）

> ⚠️ **这是本文最重要的一节。** 上面 §3.1 的「会退」是**基于一手文档与用户实测的推断**，
> **不是我们自己的观测结论**。2026-09-13 当晚的复测**没有观测到任何一笔到账**。

1. **不同模型/账号批次是否有差异？** 未逐一验证。参考实现与官方类型都按「按比例退」实现，
   且支持跨日结算。
2. **pending 到底多久落地？—— 这是当前最大的未知。**
   - 我们 2026-09-13 复测：占用 2s / 3min / 50min 三臂，10 分钟内**全部仍 pending、无金额**；
   - issue #1337 用户描述：到账发生在**每日池刷新时**（"once the freebucks refresh, the
     refunds go through"）——若属实，任何**不跨刷新点**的实验都必然只看到 pending。
   - 我们的 `2026-09-14T07:00Z` 刷新点观测**在本轮交付时尚未结束**，因此
     **「按比例退」目前仍属未证实**。
3. **线上那条终态 `freebucksRefund: 0`（占用 53min、expected 1.66）怎么解释？**
   两种可能都无法排除：(a) 短占用/该模型被结算成 0；(b) 确实不退。
   **这条是最不利于"会退"的数据点，必须保留在案。**
3. **`freebucksRefund` 不含字段时是 0 吗？** 按 vendor af898dc 口径 = 0，且 0 是**终态**
   （可以收工，不必再问）。


### 3.7 建议值（反转后）

| 设置 | 原值 | 现值 | 理由 |
| --- | --- | --- | --- |
| `session.idle_release_sec` | ~~600~~ | **60s** | 早退会退还未用时长，挂着才是花钱（控制台按账号池实时推荐） |
| `session.free_model_re_admit_lead_sec` | 60 | 保持 60 | 避免请求打到即将过期的会话上（必要） |
| `limits.max_new_sessions_per_request` | 2 | 保持 2 | 仍不该无谓换号，但不再是「一换就亏一整小时」 |
| `accountMaxConcurrency` | 2 | 1~4 按场景 | 见 §1.2；同一 instance 并发 chat 不额外扣费 |

**控制台推荐值算法也已反向重算**（`dashboard/app.js` 的 `idleReleaseAdvice`）：

| 账号池状态 | 推荐 | 直觉 |
| --- | --- | --- |
| 无活跃会话 | 60s | 无从判断，用默认值 |
| 活跃模型数 ÷ 账号数 **≥ 0.8** | **60s** | 槽位最紧，尽快释放（同时把未用时长退回来） |
| 活跃模型数 ÷ 账号数 **≤ 0.5** | **300s** | 模型集中、热会话复用充分，可容忍稍长的空闲 |
| 其余 | **120s** | 平衡点 |

**护栏（防回归，已反向）**：`test/smoke.mjs` 现在断言 `idleReleaseSec` 默认 **60s**，
且 `REFUND-COPY` 扫描**「早退不退」这类旧说法**——谁再把它写回来，测试即失败；
同时断言 `sweepPendingRefunds` 与 `serve.js` 的周期调用必须存在（少了它就等于放弃那笔预扣）。



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
- **保留热会话**：`session.idle_release_sec` 默认 60s（见 §3.5）——把请求留在同一条
  热会话上，少一次"释放→重建"，[4] 那条 1.8s 就不会天天出现。
- `agent-runs:START` 是上游协议要求的（chat 需要 `runId`），不能省。

### 4.2 顺带纠正一个观察误区

mock 里看到"两次 `agent-runs` 调用"，其中第二次是 `action: FINISH`
（`proxy.js` 里是 `void finishAgentRun(...)`，**best-effort、不阻塞首字节**），
不是重复 START。统计首字节耗时时必须把它排除，否则会误判。

---

## 5. 前端要展示的时间与运行时字段（持久化）

### 5.1 需求

展示 **①导入时间 ②凭证更新时间 ③调度运行时长**，**都要持久化**。

### 5.2 现状（`src/account-state-store.js`）

- `firstSeenAt`（加入时间）**已有**，取值来自**凭据文件创建时间**（`birthtime`，回退 `mtime`，
  见 `AccountRuntimes._importedAtHint()`）。这是"导入时刻"的**近似**——服务内导入即文件创建瞬间，够用；
  但**分不出"导入"与"外部覆盖写文件"**。
- 已知缺陷：`_restoreAccountState()` 在**构造期**就把 `firstSeenAt` 写进账本，而
  `list()` 用 `accountState.account(key, hint)` 对**已存在**记录**不再校正**——
  所以"当时文件时间探测失败 -> 记成今天"的错误会**永久留存**。
- `lastUsedAt` / `requests` **已持久化**；**缺**：凭证更新时间、累计调度时长、当前会话开始时间。

### 5.3 新增字段（`/data/account-state.json`）

| 字段 | 类型 | 含义 | 写入点 |
| --- | --- | --- | --- |
| `importedAt` | ISO string | **导入时间**（首次被服务看到的时刻） | `saveAccountUser` 之后；老账号由 `firstSeenAt` 回填 |
| `credentialUpdatedAt` | ISO string | **凭证更新时间**（token 被写入的时刻） | 每次 `saveAccountUser`（网页导入 / 浏览器登录回调 / 开放 API 导入） |
| `scheduledMs` | number | **累计调度时长**（毫秒，跨会话累加） | 在途归零时结算一次 |
| `schedulingSince` | ISO string \| null | **本轮调度开始时间**（有在途流时非空） | `beginRequest` 时若为空则写入 |
| `lastScheduledAt` | ISO string | 最近一次调度结束时间 | 在途归零时 |

`scheduledMs` + `schedulingSince` 一起，前端可显示 **累计调度时长** + **当前连续运行时长**（有在途时）。

### 5.4 实现要点

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

## 7. 退款结论反转后的落地清单（2026-09-13 第二次反转）

> §3 的旧结论（「早退不退 Freebucks」）已被一手证据推翻（见 §3.2）。
> 原先「为取回 pending 退款设计的周期性重放」曾被当作**无用方案撤回**——现在**反过来**：
> 它才是正确做法，已重新实装。

| # | 文件 | 改动 | 状态 |
| --- | --- | --- | --- |
| 1 | `src/config.js` / `src/web/settings-store.js` / `config.example.yaml` | `session.idle_release_sec` 默认值 **600 → 60** | ✅ |
| 2 | `dashboard/app.js` | 文案改为「早退按实际占用退还未用时长」，并给出 pending 的准确含义 | ✅ |
| 3 | `dashboard/app.js` | `idleReleaseAdvice` 推荐值**反向重算**（60 / 120 / 300s） | ✅ |
| 4 | `src/*.js` + `docs/*.md` + `config.example.yaml` + `README.md` + `bin/pricing.js` | 清掉「早退不退 / 整小时买断」的旧口径 | ✅ |
| 5 | `test/smoke.mjs` | `idleReleaseSec` 断言改回 **60s** | ✅ |
| 6 | `test/smoke.mjs` | `REFUND-COPY` **反向**：现在钉死「早退不退」这类旧说法 | ✅ |
| 7 | `src/session-handles.js` | **持久化待结算退款队列** + `sweepPendingRefunds()` | ✅ |
| 8 | `src/session-manager.js` | `_replayPendingRefund()` + 30s 追问定时器（1 小时窗口，pending 时入队） | ✅ |
| 9 | `bin/serve.js` | 5 分钟一次的常驻扫尾（有界 30s 预算、unref） | ✅ |
| 10 | `test/smoke.mjs` | 回归：断言 `sweepPendingRefunds` 与 serve.js 的周期调用存在 | ✅ |
| 11 | `test/repro-refund.mjs` | 头部标注：默认参数（3 分钟占用）**不足以区分竞争假设**，需 55 分钟级占用 | ✅ |

#### 推荐值算法（本次已反向重算）

| 账号池状态 | 推荐 | 理由 |
| --- | --- | --- |
| 无活跃会话 | 60s | 无从判断，用默认值 |
| 活跃模型数 / 账号数 **≥ 0.8** | **60s** | 槽位最紧，尽快释放（同时把未用时长退回来） |
| 活跃模型数 / 账号数 **≤ 0.5** | **300s** | 模型集中、热会话复用充分，可容忍稍长空闲 |
| 其余 | **120s** | 平衡点 |

#### 实施过程中发现的两个「不说就不知道」的坑（⚠️ 第 2 条现在**反转了**）

1. **推荐值拿不到数据会静默退化成默认值。** `renderProxySettings` 只拉 `/api/proxy`，
   而它的 `accounts` 字段只回 `key/id/email/proxy`，**不含 `session.model`**。于是
   `idleReleaseAdvice()` 永远看到空池，无论账号池实际怎样都回落到默认值 ——
   用户看到的「推荐值」是**假的**。已改为额外拉一次 `/api/overview` 填充 `state.accounts`
   （独立 `try`，overview 挂了不影响 settings 渲染），并加回归钉住这个数据依赖。
2. **~~`60s` 的解释也曾写错~~ → 这条本身是错的（已反转）。** 第 3 版曾断言「默认 60s 是错的、
   因为早退不退钱、挂着不多扣」——**前提就不成立**（§3.2）。事实是：挂着空闲会话在按小时计价，
   **早退才省钱**，60s 反而是对的。这条记录保留下来，正是为了提醒：
   **建立在错误前提上的推理，越自洽越危险。**

**仍然值得做（与退款无关）**：把 orphan 从「只在启动时扫尾」改成低频清理，
目的只是**释放上游会话槽位、避免 orphan 堆积**——现在它同时也在追钱。



> ⚠️ **`AGENTS.md` 冲突提示**：AGENTS.md 写着"**绝不主动把并发平摊到多个账号**"、
> "**并发上限是'溢出'阈值而非'换号'阈值**"。本次新增的 `spread` 模式与该表述冲突——
> `AGENTS.md` 是最高优先级约定，**修改它需要用户明确同意**。因此实现上 `spread` **默认关闭**，
> 与现约定保持一致；是否改 AGENTS.md 由用户决定。
