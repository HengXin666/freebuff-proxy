# Agent Note: 付费时段内换模型会整段作废（实测），行为待维护者裁决

Status: implemented

## Problem

一次真实部署（单账号、`slotLimit: 1`）里，**已付费时段内换模型必然把那一小时作废，
且不可挽回**。这不是"可能失败"，是"一定失败"。

实测时间线（同一账号 `Solar Mini 4` = `m-69307952f8`，`expiresAt 19:41:19`）：

```
18:41:24  freebuff session active   instanceId=c71b3b8d  expiresAt=19:41:19
18:41:28  ← 请求成功返回
18:41:36  releasing session before re-admit   m-69307952f8 -> mimo/mimo-v2.5
18:41:36  DELETE /api/v1/freebuff/session
18:41:37  GET returned none; POSTing admission with claim
18:41:38  account session slot busy; not cooling   code=purchase_claim_released
```

第二次复现（19:05，同样是窗口内切 `Solar Mini 4` -> `Space Bunny Alpha`）逐字节相同。
关键补充实测——**等多久都接不回来**：

| 距 DELETE | 动作 | 结果 |
| --- | --- | --- |
| 0s | 重试原模型 | `purchase_claim_released` |
| 0s | 换另一模型 | `purchase_claim_released` |
| 45s | 换另一模型 | `purchase_claim_released` |
| 90s | 换另一模型 | `purchase_claim_released` |

直到 `expiresAt` 到期才恢复。所以「DELETE 之后 GET 会把会话还回来、可以接回去」
这个直觉是**错的**：18:55 那次成功恢复，实际已经过了 14 分钟、接近窗口尾部，
不能当成"可回滚"的依据。

叠加两个放大因素：

1. **面板不诚实**：整个窗口内账号 `status=ok` / `available=true` / `cooldownCode=None`，
   但每个模型都 429。排障只能翻日志。
2. **额度白花**：那已买断的一小时既不能用也拿不回来（`balance` 全程未动，
   `daily.spent=0`，说明是"买了却用不了"，不是被扣）。

## Decision

**本次只做两件确定正确的事，不改换模型的行为。**

1. **删掉 `ensureSession` 里重复的第二处 `_releaseUnlocked()`**。同一动作写了两遍：
   第一处释放后 `hasLiveSlot()` 恒为 false，第二处条件恒假（死代码）。它当下不会
   多发一次 DELETE，但**没有守卫**——将来有人给第一处加"付费时段不释放"的守卫，
   这里会静默绕过。留着比删掉危险。
2. **把上述实测与冲突写进 issue #24，交维护者裁决**，不单方面改语义。

### 为什么不在本 PR 里禁止窗口内换模型

试过，并被现有测试明确否掉：`test/smoke.mjs` 里有一处连续请求
`openai/gpt-5.6-luna` 与 `openai/gpt-5.6-luna-es`，断言两次都 200——即
**"同一小时内跨模型可用"是当前被测试钉住的既有行为**。加上这个守卫会让它 429。

也就是说，实测（窗口内切换不可恢复）与既有断言（同一小时内跨模型可用）**直接冲突**。
两者不可能同时为真：要么 mock 放行了生产里做不到的事，要么生产里存在我没测到的
可恢复路径。这个取舍属于产品语义（宁可 429 也不作废已付费时段？还是允许跨模型
并承担作废风险？），不该由一个 bug-fix PR 单方面替维护者定。

### 试过并放弃的两个修法

- **切换失败后用 GET 把旧会话接回来**：直觉上很对，实测**无效**（见上表 0s/45s/90s）。
  保留这段代码没有任何真实收益，只会让人误以为可回滚。已放弃。
- **admit 时拒绝"绑着别的模型"的 active 会话**：看似能防串模型，实测是**错的**——
  `GET /session` 不带 model hint，回执里的模型由服务端指派，而本项目**明确要求下游
  用回执值而不是客户端请求值**（见 `test/smoke.mjs` 中"chat 的 model 必须用会话回执里
  服务端指派的值"）。加上这个守卫直接打挂两处既有测试。已放弃。

## Alternatives considered

- **什么都不做** —— 最强理由是：行为是维护者有意设计的（上游一次只服务一个模型，
  换模型必须先释放），且已被测试钉住；我不掌握上游 claim 语义的完整真相，
  贸然改动可能引入比现状更糟的失败模式。**否决**：本 PR 至少交付了死代码清理
  与可复现的实测证据，让维护者能在有数据的前提下决策；纯什么都不做等于把
  "面板说 ok、实际全模型 429"这个坑留在原地。
- **窗口内禁止换模型（付费时段不释放）** —— 最强理由是：实测证明窗口内切换
  100% 作废，禁止它零损失，且符合 AGENTS.md「付费时段内绝不为空闲而释放」的
  同一条原则（只是从"空闲"延伸到"切换"）。**否决**：与既有测试钉住的
  "同一小时内跨模型可用"直接冲突，属产品语义裁决，不该由本 PR 代决。
- **切换失败后台异步接回** —— 最强理由是不阻塞用户请求。**否决**：实测 GET 在
  DELETE 后立刻回 none，异步接回在窗口内大概率同样接不回，属于"写了但不生效"的复杂度。
- **把 `purchase_claim_released` 之后的账号标成冷却** —— 最强理由是能让面板变诚实。
  **否决**：它会让一个**健康且仍在服务旧模型**的账号被钉死，且该 code 已被
  `SLOT_BUSY_CODES` 明确判定为"资源竞争不是账号故障"。

## Consequences

- 换模型行为、admit 语义、额度结算**均未改变**；`npm test` 与 `npm run typecheck` 全绿。
- 消除一处无守卫的重复释放路径，为后续"付费时段不释放"的守卫留出干净的落点。
- 面板仍可能在"窗口内切换失败"时显示 `ok / available` —— **本次刻意未修**，
  因为修它要么改语义、要么新增账号状态字段，属于 issue #24 里请维护者一起定的事。
- 运维侧当前唯一可靠的做法：**一个已付费时段内只请求同一个模型**。

## Evidence

- 复现 1（18:41）：`Solar Mini 4` 成功 → 切 `mimo/mimo-v2.5` → DELETE → 409
  `purchase_claim_released`，此后 14 分钟内全部模型 429。
- 复现 2（19:05）：同构复现，窗口内切 `Space Bunny Alpha` 失败。
- 接不回来：0s / 45s / 90s 三次重试（换回原模型、换另一模型）全部 `purchase_claim_released`。
- 额度无损：`balance=25`、`daily.spent=0`、`admitCount` 全程未因失败而增加。
- 面板说谎：窗口内 `status=ok` / `available=true` / `cooldownCode=None` 但全模型 429。
- 相关既有决策：`.agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md`
  （一次 admit 买断一小时、付费时段内绝不为空闲而释放）、
  `.agents/notes/implemented/bug-fix/2026-10-03-model-name-fallback-and-slot-no-cooldown.md`
  （`purchase_claim_released` 属槽位竞争、不冷却账号）。
- 上游报告：issue #24。