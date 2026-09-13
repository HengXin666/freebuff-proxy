# 账号并发 / 调度最优解 / 归还点数 —— 调研与结论

> 本文是 [freebuff-proxy](../README.md) 的专题调研文档，回答三个问题 + 一个前端需求。
> **证据等级**：`实测`（跑出来的数据）> `代码`（读一手源码得出）> `推理`（由前两者推出）> `未知`（没有证据，不当结论用）。
> 调研日期 2026-09-13。上游随时会变，价目/限额一律以**实时探测**为准，不要把本文数字当常量。
>
> **一手证据来源（可自行核对）**：
>
> - **官方客户端开源源码** `github.com/CodebuffAI/freebuff`（公开快照；`npm i -g codebuff`
>   装的 CLI 与 `npm i freebuff` 同源）——本文关于**计费语义**的结论来自它，但**它描述的是 `session_units` 那本账**（见 §3.1）；
> - **本仓库代码**（`src/`、`bin/`）与 **`test/repro-*.mjs`** 复现脚本；
> - **线上服务只读探测**：`GET /v1/freebuff/status`（管理员 key，不做任何写操作）；
> - **rotator 独立账本**：`freebuff-rotator/rotator/LEDGER.md` + `state/ledger.json`。
>
> ⚠️ **本文第 3 节经过两次公开自我纠错，现已结案（2026-09-13）**。
> 最终结论：**上游有两套账——`session_units` 早退会按比例退还，`Freebucks` 不退**。
> 之前两版结论（「永远不退」/「官方会退、0 是我们 bug」）都是**把两套账混为一谈**造成的误判。
> 决定性实验与策略变更见 §3.1、§3.4。

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
- **换号 = 新买一条计费会话**：admit 按整小时**实扣** Freebucks，且**早退不退**（§3.1），过早换号 = 白花钱；
- 所以"把请求集中到尽量少的账号、用尽才换"在**点数口径**上是对的。

### 2.3 代价（就是你遇到的）

1. **高并发被串行化**：上限 2 而有 4 路在途 → 后 2 路在同一账号干等。
   它们虽未产生上游 compute，但对**客户端就是"卡了"**（首字节延迟 ≈ 前一条流的剩余时间）。
2. **冷账号基本用不上**：除非排队超时（120s / 45s 预算），否则第 2、3 个号永远不动。
3. **空闲释放放大了这个效应**：`idle_release_sec` 默认 60s 会频繁早退会话（**而早退不退 Freebucks，见 §3.1/§3.4**；已改为默认 600s），
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

## 3. 归还（关闭会话 / 早退 DELETE）到底退不退 Freebucks？—— ✅ 已结案

### 3.1 结论（2026-09-13，决定性实验完成）

> **不会退还 Freebucks。** 早退 DELETE 会**重算并退还 session units**（每日模型额度），
> 但 **Freebucks 的整小时预扣一分都不退**。
>
> **所以「靠早退省点数」这条路不通——策略必须按这个结论改（见 §3.4）。**

#### 根因：上游有**两套独立的账**

之前两个版本结论打架，根因是**把两套账混为一谈**：

| | **session units** | **Freebucks** |
| --- | --- | --- |
| 字段 | `rateLimitsByModel[m].recentCount` | `freebucks.daily` / `freebucks.balance` |
| 池标识 | `pool: limited` / `poolLabel: Daily` | `pool: freebucks` |
| 本账号额度 | limit **6**（可为小数） | limit **25** + balance |
| admit 预扣 | **+1.0**（整条会话单位） | **整小时单价**（`freebucks.prices[m]`） |
| 早退是否退 | **✅ 按实际占用比例重算退还** | **❌ 不退** |

官方注释里那句 *"the server re-stamps session_units to the fraction actually elapsed …
so this REFUNDS the unused window"*（`common/src/constants/freebuff-models.ts:2592`）
说的是**左列**（session units）。
而我们（以及多数第三方代理）一直盯的是**右列**（Freebucks），
所以「官方说会退 / 我们观测全是 0」两边都没说错，只是**说的不是同一种钱**。

#### 决定性实验（实测，受控单变量）

账号 `loliyoknvrgq`（token `945e36bd-…`），模型 `upstage/solar-pro4`（价目表 **5 FB/h**）：

| 步骤 | session units | Freebucks daily | Freebucks balance |
| --- | --- | --- | --- |
| T0 基线（无会话） | 0.2 | 20 / 25 | 5 |
| T1 POST admit → 200 active | — | — | — |
| T2 admit 后 | **1.2** | **25 / 25** | **0** |
| **Δ 预扣** | **+1.0** | **+5** | **−5** |
| T3 持有 **180s**（= 0.05 h） | | | |
| T4 DELETE | status=ended，freebucksRefundPending=true ← **无金额** | | |
| T5 每 3s 重放 DELETE ×100（共 **555s ≈ 9.2 分钟**） | 次次 pending，**金额字段始终没出现** | | |
| T6 终态 | **0.3** | **25 / 25** | **0** |
| **净结果** | **退还 0.9**（留存 0.1 ≈ 实际占用 0.05 h） | **退还 0** | **退还 0** |

**另两组独立复核**：

1. 同账号、模型 `deepseek/deepseek-v4-flash`：重放 **200 次、历时 1195s（≈20 分钟）**，
   仍是 `freebucksRefundPending: true`、**金额字段始终没出现**；
   同期 session units 从 1.2 回落到 0.3（**退了**）。
2. 线上真实 orphan `39ad4544-ec43-4101-aeca-2969d3a87ce5`（账号 `mink110x`）：
   **首次** DELETE 就拿到终态 `status=ended, freebucksRefund=0` —— **明确退 0**；
   20 分钟后再问，仍是 `freebucksRefund: 0`。

> 官方客户端在 pending 期间「**每 3s 无限重放**」——我们照做了，**20 分钟也没等到金额**。
> 所以旧版把 0 归因为「我们 5.5s 窗口太短、问得太早」这个解释**已被证伪**：
> pending 是**长期的**，不是「还没算完」。

#### 三种回执，Freebucks 含义都是「退 0」

| 回执 | 含义 |
| --- | --- |
| status=ended + freebucksRefund=0 | 已结算，**退 0** |
| status=ended + freebucksRefundPending=true | 长期未结算；实测 ≥20 分钟仍无金额 |
| status=ended（无字段） | 按参考实现 af898dc 语义 = **退 0** |

**没有任何一种能把 Freebucks 退回来**，两个方向都不该再指望。

### 3.2 为什么 Freebucks 不退（推理）

Freebucks 的预扣是按「**买下这一小时的会话**」计价（价目表单位 = FB/小时），
不是按「实际使用时长」计价；`session_units` 才是**按占用时长**记账的那本账
（所以它可以是 0.1 / 1.3 这类小数，官方 `format-session-units.ts` 也明说
"a long agent run can consume 1.3 sessions"）。

推论：**上游把「结束会话」在 rate-limit 账上做了比例重算，
但在 billing 账上没有对应退款分录**——`freebucksRefund` 实际恒为 0。

这**不需要假设上游有 bug**：可以理解成「你买了 1 小时，用 3 分钟是你自己的事」。
无论动机如何，**可操作的事实只有一个：早退不退点数。**

### 3.3 公开纠错：本文前两版结论都是错的

诚实记录这次调研的翻车过程，避免重蹈：

| 版本 | 当时的结论 | 为什么错 |
| --- | --- | --- |
| 第 1 版 | 「早退**永远不退**点数」 | 只有「观测全是 0」一个论据，且把「没轮询到」当成了「不存在」 |
| 第 2 版 | 「官方设计**确实会退**，0 是**我们工程 bug**（5.5s 窗口太短）」 | 把官方注释里的 `session_units` 当成了 Freebucks；「问得太早」已被 §3.1 的 20 分钟重放证伪 |
| **第 3 版（现行）** | **session units 退，Freebucks 不退；两套账** | 受控实验同时测两个计数器，一次分清 |

> 教训：**当「官方文档/源码」与「线上观测」冲突时，先确认两者说的是不是同一个字段、
> 同一本账**，再怀疑任何一方。这次差一点把「字段语义不同」误判成「我们代码有 bug」。

### 3.4 策略变更（**本次调研的真正产出**）

既然早退不退 Freebucks，而 Freebucks 才是稀缺资源（每日 25），那么：

**1. 「早退省钱」这条逻辑从设计里删掉。**
`session.idle_release_sec` 的收益不再是「拿回未用时长」，只剩「释放上游会话槽位」。

**2. 省钱只靠一件事：少开会话（admit 次数 = 花钱次数）。**
每次 admit 都是**实付整小时单价**，与之后用 3 秒还是 59 分钟**无关**。
优化目标因此从「及时释放」变成「**尽量复用同一条热会话**」：

| 措施 | 效果 |
| --- | --- |
| 粘性调度（默认 drain, not rotate） | ✅ 保持——它正是「少开会话」 |
| 同模型热会话优先复用 | ✅ 保持 |
| `limits.max_new_sessions_per_request` 默认 2 | ✅ 保持，甚至可收紧到 1 |
| 空闲自动释放（`idle_release_sec`） | ✅ **已按此结论调整为默认 600s**——释放后再来请求就要**再买一小时** |
| spread（并发优先）模式 | ⚠️ 会让更多账号各买一小时，**按此结论更不划算**（默认关闭是对的） |

**3. 「释放→重建」抖动（✅ 已修）。**
旧默认 `idle_release_sec = 60` + `free_model_re_admit_lead_sec = 60`：
空闲 60 秒就删会话，下次请求重新 admit = **又扣一整小时**。
在旧（退款）假设下这近乎免费，**在新结论下是纯亏损**。已把默认值上调到 600s（见 §3.4.1）。

**4. 不要为了「拿退款」多做 admit/DELETE。** 旧结论下这是尝试，新结论下是**确定性亏损**。

建议值（交互式场景）：

| 设置 | 现在 | 建议 | 理由 |
| --- | --- | --- | --- |
| `session.idle_release_sec` | 60 → **600（已改）** | 300 ~ 1800（控制台会按账号池实时推荐） | 早退不退钱，频繁释放 = 反复买新会话 |
| `session.free_model_re_admit_lead_sec` | 60 | 保持 60 | 避免请求打到即将过期的会话上（必要） |
| `limits.max_new_sessions_per_request` | 2 | **1 ~ 2** | 每次换号都是新买一小时 |
| `accountMaxConcurrency` | 2 | 1~4 按场景 | 见 §1.2；同一 instance 并发 chat 不额外扣费 |

#### 3.4.1 为什么是 600s，以及控制台怎么替你算（v1.13.1 已实现）

**为什么不能是 60s。** `60s` 在旧（会退款的）假设下近乎免费，在新结论下是**纯亏损**：
空闲一分钟就删会话，下个请求重新 admit = **又扣一整小时**。一个交互式对话里
「喝口水再回来」是常态，60s 会把它切成两条计费行。

**但也不能无脑调很大。** 释放本身仍有价值——一个账号同时只能有一条 session，且 session
**绑定模型**。模型种类越多、账号越少，槽位越紧张；释放太慢会导致换模型时要干等。
所以最优点取决于**你的账号池长什么样**，不是固定数字。控制台因此按**模型/账号比**实时算：

| 账号池状态 | 推荐 | 直觉 |
| --- | --- | --- |
| 无活跃会话 | 600s | 无从判断，用默认值 |
| 活跃模型数 ÷ 账号数 **≥ 0.8** | **300s** | 几乎每个号都在被不同模型抢，槽位紧 → 释放要快（代价：admit 次数上升） |
| 活跃模型数 ÷ 账号数 **≤ 0.5** | **1800s** | 模型集中在少数号上，热会话复用充分 → 少释放 = 少 admit = 省钱 |
| 其余 | 600s | 平衡点 |

界面上显示「推荐值」区块，管理员可点「采用推荐值 Ns」一键生效；保存后原地重算。
这也是**默认值选 600s** 的原因：它在大多数池型下都接近最优，且不会像 60s 那样明显亏。

**护栏（防回归）**：`test/smoke.mjs` 断言 `idleReleaseSec` 默认值 **不得低于 300s**，
并有 `REFUND-COPY` 回归——控制台/配置/文档里再出现「早退退款 / 退未用时长」即测试失败。
这两条是为了防止后来的改动把已被实验证伪的说法又写回去。

### 3.5 收尾：仍未完全确定的部分（诚实标注）

1. **Freebucks 是否在极长占用（接近整小时）后按比例退？**
   本次只测到 3 分钟占用 + 20 分钟重放。要 100% 封死需补一组「占用 30 分钟」对照，
   但**对策略已无影响**：无论长占用退不退，把 `idle_release_sec` 调大都仍然正确
   （它减少的是**新建会话次数**，不依赖退款）。
2. **pending 是否会跨天/跨账期突然结算？** 无证据；即便结算也改变不了「短期退不回来」的运维事实。
3. **不同模型/账号批次是否有差异？** 已测 3 个模型（solar-pro4 / flash / 线上 orphan 的 flash）
   与 3 个账号，**行为完全一致**。

> 结论：**§3 的悬案可以关了。** 剩下 1~2 只是边界补测，不影响任何决策。


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
- **保留热会话**：`session.idle_release_sec` 已从 60s 调到 600s（见 §3.4），
  少一次"释放→重建"，[4] 那条 1.8s 就不会天天出现。
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

## 7. 退款调研结案后：待办（下一版）

> §3 的决定性实验已于 2026-09-13 跑完并结案：**早退不退 Freebucks**。
> 这直接**取消了**原先为「取回 pending 退款」设计的整套改动（周期性重放 DELETE）——
> 既然退不回来，再重放也没有意义。**该方案作废**，不再列入下版。

| # | 文件 | 待办 | 状态 |
| --- | --- | --- | --- |
| 1 | `src/config.js` / `src/web/settings-store.js` / `config.example.yaml` | `session.idle_release_sec` 默认值 **60 → 600** | ✅ 已完成 |
| 2 | `dashboard/app.js` | 设置页文案去掉「早退拿回未用时长」的错误暗示；改为「早退**不退点数**，花钱次数 = admit 次数」 | ✅ 已完成 |
| 3 | `dashboard/app.js` | 新增「推荐值」区块：按账号池**实时**模型分布算出建议值，管理员可一键采用 | ✅ 已完成 |
| 4 | `src/*.js` + `docs/*.md` + `config.example.yaml` | 清掉源码/文档里所有「早退退 Freebucks」的错误注释 | ✅ 已完成 |
| 5 | `test/smoke.mjs` | 默认值断言 60 → 600，并加**下限 300s 护栏**（防止有人再调回 60s） | ✅ 已完成 |
| 6 | `test/smoke.mjs` | 新增 `REFUND-COPY` 回归：控制台/配置/文档再出现「早退退款」措辞即失败 | ✅ 已完成 |
| 7 | `dashboard/app.js` | 修 `renderProxySettings` 未拉 `/api/overview` 导致推荐值恒为默认值的 bug | ✅ 已完成 |
| 8 | `test/smoke.mjs` | 回归：断言空闲释放阈值提高后**不会**产生额外的 admit 次数 | ⏳ 下版 |

> 实施提交：`94bbfc0`（默认值 + 推荐值 + 文案清理）、`bb0219b`（推荐值数据依赖修复）。

#### 实施过程中发现的两个「不说就不知道」的坑

1. **推荐值拿不到数据会静默退化成默认值。** `renderProxySettings` 只拉 `/api/proxy`，
   而它的 `accounts` 字段只回 `key/id/email/proxy`，**不含 `session.model`**。于是
   `idleReleaseAdvice()` 永远看到空池，无论账号池实际怎样都回落到 600s ——
   用户看到的「推荐值」是**假的**。已改为额外拉一次 `/api/overview` 填充 `state.accounts`
   （独立 `try`，overview 挂了不影响 settings 渲染），并加回归钉住这个数据依赖。
2. **`60s` 的解释也曾写错。** 旧注释说「默认 60s 是因为上游按占用时长结算，会话多挂一秒
   就多扣一秒」——这在 Freebucks 账上**不成立**（早退不退、多挂不多扣）。已全部改写为
   「admit 一次 = 实付整小时」。

#### 推荐值的算法（本次新增，替代「拍脑袋给个数」）

早退不退钱 ⇒ 释放**有代价**；但一个账号同时只能有一条 session 且 session **绑定模型**
⇒ 模型越多、账号越少，槽位越紧张，越需要及时释放。所以推荐值看**模型/账号比**：

| 账号池状态 | 推荐 | 理由 |
| --- | --- | --- |
| 无活跃会话 | 600s | 无从判断，用默认值 |
| 活跃模型数 / 账号数 **≥ 0.8** | **300s** | 槽位很紧，换模型要尽快拿到 slot（代价：admit 次数上升） |
| 活跃模型数 / 账号数 **≤ 0.5** | **1800s** | 模型集中，热会话复用充分 → 少释放 = 少 admit = 省钱 |
| 其余 | 600s | 平衡点 |

**已作废（原 §3.6 解释 A 方案）**：`startOrphanSweeper()` 周期重放 pending 退款、
`bin/serve.js` 挂载、`test/smoke.mjs` 真实 tick 回归。
这些改动曾实现并通过测试，随后按要求撤回；**现在确认不需要再实现**。

**仍然值得做（与退款无关）**：把 orphan 从「只在启动时扫尾」改成低频清理，
目的只是**释放上游会话槽位、避免 orphan 堆积**，不是为了要钱。

> ⚠️ **`AGENTS.md` 冲突提示**：AGENTS.md 写着"**绝不主动把并发平摊到多个账号**"、
> "**并发上限是'溢出'阈值而非'换号'阈值**"。本次新增的 `spread` 模式与该表述冲突——
> `AGENTS.md` 是最高优先级约定，**修改它需要用户明确同意**。因此实现上 `spread` **默认关闭**，
> 与现约定保持一致；是否改 AGENTS.md 由用户决定。
