# Agent Note: 付费时段内换模型会作废已买断的一小时(已拦)

Status: implemented

## Problem

一次真实部署(单账号,`slotLimit: 1`)里,**已付费时段内换模型必然把那一小时作废,
且不可挽回**.这不是"可能失败",是"一定失败".

实测时间线(同一账号,`Solar Mini 4` = `m-69307952f8`,`expiresAt 19:41:19`):

```
18:41:24  freebuff session active   instanceId=c71b3b8d  expiresAt=19:41:19
18:41:28  ← 请求成功返回
18:41:36  releasing session before re-admit   m-69307952f8 -> mimo/mimo-v2.5
18:41:36  DELETE /api/v1/freebuff/session
18:41:37  GET returned none; POSTing admission with claim
18:41:38  account session slot busy; not cooling   code=purchase_claim_released
```

第二次复现(19:05,切 `Space Bunny Alpha`)逐字节相同.关键补充——**等多久都接不回来**:

| 距 DELETE | 动作 | 结果 |
| --- | --- | --- |
| 0s | 重试原模型 | `purchase_claim_released` |
| 0s | 换另一模型 | `purchase_claim_released` |
| 45s | 换另一模型 | `purchase_claim_released` |
| 90s | 换另一模型 | `purchase_claim_released` |

直到 `expiresAt` 到期才恢复.所以[DELETE 之后 GET 会把会话还回来]这个直觉是**错的**.

叠加两个放大因素:

1. **面板不诚实**:整个窗口内账号 `status=ok` / `available=true` / `cooldownCode=None`,
   但每个模型都 429.排障只能翻日志.
2. **额度白花**:那一小时既不能用也拿不回来(`balance` 全程未动).

这一段与同文件 `_armIdleRelease` 的注释结论**直接相反**:那段基于 24 组实测得出
[已付费的一小时内继续用边际成本为 0,释放是纯亏].两条结论打架了很久.

## Decision

**付费时段内,且旧会话绑在别的模型上时:不释放,抛 `paid_window_model_mismatch`
让上层换号.**

判据收紧到**只拦模型不符**:`session.model && session.model !== model`.
[即将过期需要续期]是**同一模型**的 re-admit,会话本来就该换新的,绝不能拦——
拦了会让到期前无法续期,请求撞上已失效会话.

三处配套:

- **上层(`app-context.js`)**:新码进 `PAID_WINDOW_BOUND_CODES`,与槽位忙同类处置
  ——**跳过,不冷却**.账号是健康的,只是这一小时腾不出这个模型的槽位;冷却它
  等于把仍在生效的额度判死.
- **错误口径**:全部账号都命中该码时给**独立错误码**(不再混进笼统的
  `no_available_account`),并把[什么时候能恢复]说清楚 = 最早到期的那条会话,
  同时回 `boundModels` 让用户改用它们而不是干等.
- **面板诚实**:`session` 快照新增 `inPaidWindow`,前端在账号行标注
  [本小时仅限此模型]+ tooltip 说明到期时间与为什么不能换.

## Alternatives considered

- **什么都不做(维持无条件释放)** —— 最强理由是:行为是有意设计的(上游一次只
  服务一个模型,换模型必须先释放),且被既有测试钉住.**否决**:实测证明它在窗口内
  100% 作废且不可挽回,而 AGENTS.md 自己写着[付费时段内绝不为空闲而释放]——
  "空闲"与"切换"在账本上是同一件事(都是把已买的钱扔掉),没有理由区别对待.
- **切换失败后用 GET 把旧会话接回来** —— 直觉上很对.**否决**:实测无效(上表
  0s/45s/90s),保留这段代码只会让人误以为可回滚.
- **把 `purchase_claim_released` 之后的账号标成冷却** —— 能让面板变"诚实".
  **否决**:它会把一个**健康且仍在服务旧模型**的账号钉死,且该 code 已被
  `SLOT_BUSY_CODES` 明确判定为"资源竞争不是账号故障".面板诚实要靠**如实描述状态**,
  不能靠把健康账号判死来凑.
- **窗口内禁止换模型但不换号(直接 429 给用户)** —— 少一次选号开销.**否决**:
  池内常有别的空闲账号能接这个模型,直接 429 是白白放弃一条可用路径.

### 为什么改了那个"同一小时内跨模型可用"的既有断言

`test/smoke.mjs` 里有一处连续请求 `openai/gpt-5.6-luna` 与 `openai/gpt-5.6-luna-es`,
断言两次都 200 —— 即"同一小时内跨模型可用"曾是被钉住的既有行为.

它与生产实测**直接冲突**,两者不可能同时为真.查证后确认是 **mock 上游无条件放行
admission**:生产里上游会回 `purchase_claim_released`,mock 不会.所以那段测试
验证的是 mock 的行为,不是上游的行为.

处理:保住用例**真正的意图**(luna 系强制 base3 agentId),把"连发两个模型"改成
显式释放后再发 —— 模拟真实成立的"时段结束/用户关闭后再换模型"路径.另有两处
同类依赖(调度策略用例,lead 阈值用例)同样改为在真实前提上验证.

## Consequences

- 单账号部署在付费时段内换模型会**明确 429 并说明原因与恢复时刻**,而不是
  静默作废一小时(此前是后者,且面板显示正常).
- 多账号部署基本无感:上层自动跳过该账号去选下一个.
- 面板新增 `session.inPaidWindow` 字段与一行标注(仅展示,不参与调度判据).
- 新增错误码 `paid_window_model_mismatch`(HTTP 429);调度层内部用它做跳过判据.
- 行为变化仅发生在**付费时段内 + 模型不符**这一交集;同模型续期,时段结束后的
  换模型,空闲释放全部照旧.

## Evidence

- 复现 1(18:41)与复现 2(19:05):窗口内换模型 → DELETE → 409
  `purchase_claim_released`,此后直到到期全部模型 429.
- 接不回来:0s / 45s / 90s 三次重试(换回原模型,换另一模型)全部失败.
- 修后实测:构造剩余 50 分钟的 active 会话,调 `ensureSession(别的模型)` →
  抛 `paid_window_model_mismatch`,**上游调用序列为空**(零 DELETE).
- 修后同模型请求:零上游调用(纯复用热路径).
- 修后释放再换:`POST` 正常发出.
- 回归测试:`test/smoke.mjs` 新增[付费时段内换模型不得释放]用例,钉住
  零 DELETE,句柄保留,同模型零调用,释放后可 admit.
- 相关既有决策:[2026-09-14-paid-hour-hold.md](../architecture/2026-09-14-paid-hour-hold.md),
  [2026-10-03-model-name-fallback-and-slot-no-cooldown.md](2026-10-03-model-name-fallback-and-slot-no-cooldown.md).
- 上游报告:issue #24;PR #25 只清理了重复释放的死代码,未改本行为.
