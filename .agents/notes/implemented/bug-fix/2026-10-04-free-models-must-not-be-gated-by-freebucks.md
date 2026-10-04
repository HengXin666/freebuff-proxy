# Agent Note: 免费模型(price === 0)不受 Freebucks 闸门约束

Status: implemented

## Problem

用户报(原话):

> 另外目前有些会话它的购买是免费的,而你这个筛选判断就把免费的给它排除了,
> 我都不知道怎么想的.你就硬说他是没有余额,就不参与判断了,怎么能够这样?

上游价格表里确实有**明确标价 0 的免费模型**(实测):

```
upstage/solar-mini4        = 0
stealth/space-bunny-alpha  = 0
```

而 `freebucksFor()` 的两道闸门对 `price: 0` 一视同仁:

```
dailyExhausted  = dailyLimit > 0 && dailyRemaining <= 0
shortOnBalance  = Number(fb.balance) < price
affordable      = exempt || (!dailyExhausted && !shortOnBalance && !monthlySpent)
```

实测(`balance: 0` / `daily.remaining: 0`):

```
免费模型 (price 0)   affordable = false   reason = daily_exhausted   ← 
付费模型 (price 10)  affordable = false   reason = daily_exhausted   ←  正确
```

**免费模型不花钱,却被"没钱"判死** —— 用户明明能用,被我方闸门挡住.
而且这个判据**同时污染两处**:选号闸门(拒绝)与选号排序(排到最后).

## Decision

`freebucksFor()` 引入 `isFreeModel = price === 0`,并让它短路**两道钱的闸门**:

```
dailyExhausted = !isFreeModel && (...)
shortOnBalance = !isFreeModel && Number(fb.balance) < price
monthlySpent   = !isFreeModel && fb.monthly != null && ...
```

 **只豁免"钱",不豁免"次数"**:`sessionUnitsFor()`(每模型每日会话次数,
`rateLimitsByModel`)是上游的**独立额度** —— 实测两个免费模型同样是 `2.5/6`,
所以它们仍然受它约束.修复后实测:

```
免费模型 (price 0)   affordable = true    reason = null
免费模型 次数跑满     exhausted = true     ← 仍受约束
付费模型 (price 10)  affordable = false   reason = daily_exhausted
```

## Alternatives considered

- **什么都不做** —— 就是本 bug:免费模型被"没钱"挡住,用户能用却用不了.
- **把 `price == null`(缺价)与 `price === 0` 合并处理** —— 两者语义不同:
  `price == null` 是"上游没给价"的**未知态**(已有 `unmetered` 分支放行并明确标注),
  `price === 0` 是"上游明确标价 0"的**已知免费态**.合并会让未知态丢失可观测性.
- **免费模型连会话次数闸门也豁免** —— 错,且已被实测证伪:这两个免费模型在
  `rateLimitsByModel` 里同样有 `limit: 6`,上游就是要按次数管它们.
- **在调用方(app-context)过滤免费模型** —— 那会形成第二份判据.
  本判据的**真源唯一**:全仓只有 `freebucksFor()` 内部做这个比较,
  选号闸门与选号排序都复用它的返回值(`affordable`),所以一处修,两处好.

## Consequences

- **免费模型在余额为 0 的账号上也参与调度** —— 这正是预期行为.
- **计数语义不变**:`dailyRemaining` 等字段照常返回,只是不再影响 `affordable`.
- **`apContext.candidateKeys` 的排序自动跟着修好**(它读 `fbInfo.affordable`,
  不是自己算)—— 已实测确认.

## Evidence

- 上游真实价格表(直连 `GET /session` 只读):`upstage/solar-mini4: 0`,
  `stealth/space-bunny-alpha: 0`.
- 上游真实次数额度:`rateLimitsByModel` 里这两个免费模型都是 `recentCount: 2.5 /
  limit: 6`(证明它们确实受次数约束).
- 修复前后实测对比(见上).
- 新增测试(`test/smoke.mjs`):免费模型必须放行 + 付费模型仍拒绝 +
  免费模型的次数闸门仍生效(三条断言 + 两条对照).
- **反向探针实证可证伪**:把 `const isFreeModel = price === 0` 改成 `false`
  → 断言红(`免费模型（price 0）必须放行 —— 它不花钱`).
- 门禁:`npm test` 全绿;typecheck 过.
