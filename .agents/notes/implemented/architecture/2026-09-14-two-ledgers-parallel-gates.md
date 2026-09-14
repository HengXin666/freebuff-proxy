# Agent Note: session_units 与 Freebucks 是**两道并行闸门**（不是两本可替代的账）

Status: implemented

## Problem

「早退 DELETE 退不退」这条线上，我们先后得出过**两个都错**的结论，而两个错误同源：把
`session_units` 与 Freebucks 当成**同一笔钱的两个视角**（「两本账」），于是要么说「都退」，
要么说「都不退」——从没验证过它们是不是**各自独立扣费**。

第 3 版把 `session_units` 的退款注释当成 Freebucks 会退的依据（张冠李戴）；第 4 版纠正为
「两本账都退」，但**仍然没有实测过 Freebucks 侧是否真的到账**。后果：

- 闸门只按 Freebucks 判（`freebucksFor`），`session_units` 这道时长闸门在调度里**完全没有**——
  一个 units 已用尽（`6/6`）但 Freebucks 尚有余量的账号仍会被选中去 admit，撞上游 `rate_limited`。
- 对账字段 `expected` 用 `freebucks.prices[model]` 算，对**没有 units 行**的模型算出的
  「应退」金额永远兑不了现——因为那本账根本不按 Freebucks 结算。

## Decision

**两本账是并行的两道闸门，都真实扣费；调度必须两道都过。**

一手实测（`docs/evidence/ledger-session-units-vs-freebucks.json`，账号 `gh9227684@loliko.top`，
经 `127.0.0.1:2334` 出口直连 `codebuff.com`）：

| 模型 | 初始 | admit 后 | 早退 DELETE 后 |
| --- | --- | --- | --- |
| `upstage/solar-pro4` | FB 5（池 5/25）、units 0.1/6 | **FB 0（池 0/25）、units 1.1/6** | units **0.2/6**（立即按比例退还 0.9）；FB 回 `freebucksRefundPending: true` |
| `z-ai/glm-5.3-flash`（无 units 行） | FB 10 | **FB 5**（units 无行） | FB 5，`pending` |

一条会话**两本账同时各扣一次**（units +1.0、Freebucks −单价），这是关键事实。推论：

1. **Freebucks 才是上游的拒付判据**：`deepseek/deepseek-v4-flash` 在 units `0.1/6` **完全没超标**
   的情况下仍被 `rate_limited`，回执里写的是 `pool: freebucks`、`limit: 25`、`recentCount: 20`、
   `freebucksShortfall: {price: 25, balance: 5}`。所以 Freebucks 闸门**不能删**。
2. **`session_units` 才是会立即兑现的那本账**：早退后 units 当场按比例回填（小数，无取整），
   而 Freebucks 侧只回 `pending` —— 我们**从未观测到它的金额落地**。

落地：

- `SessionManager.sessionUnitsFor(model)`：读 `quota.byModel[model]`，返回
  `{known, used, limit, remaining, exhausted, pool, poolLabel, resetAt}`；**fail-open**
  （无行 / `limit<=0` / 非有限数 → `known:false`，不拦截）。
- 选号新增 units 闸门与排序维度 `unitsOut`；`reacquireAfterGate` 的同号重试（会新买会话）同样先过两道闸。
- 耗尽错误码新增 `units_exhausted`；两者都命中时仍报 `freebucks_exhausted` 保持兼容。
- 对账新增 `expectedUnits = 1 − max(0.1, 占用小时数)`（上游 0.1 小时最小时长下限），
  累计进 `refundUnitsExpectedTotal`。
- 释放时若回执带 `rateLimitsByModel`，就地刷新 units（`extractQuota`）。

推论 2（units 才是当场兑现的那本账）直接推出了释放策略：
见 [2026-09-14-paid-hour-hold.md](./2026-09-14-paid-hour-hold.md) —— 既然 Freebucks 拿不回、
而它又是稀缺的那本，那么**付费时段内就不该释放**。

## Alternatives considered

- **什么都不做（只留 Freebucks 闸门）** — 最省事，且现状「能跑」。被否决是因为它漏掉一整道
  上游判据：units 用尽时仍会去 admit，换回一次 `rate_limited` 往返并冷却账号；实测已证明
  units 是独立扣费的，凭「没观测到它拦人」就假设它不拦，正是前两次误判的同一种推理。
- **只留 session_units，删掉 Freebucks 闸门（「全部改用 session_units」的字面做法）** — 看似简化。
  被实测直接否决：`deepseek-v4-flash` 在 units 充足时仍被 Freebucks 拒付，且上游明确以
  `freebucksShortfall` 为理由。删掉这道闸门等于**主动去撞封号判定**——上游把「要的钱超过余额」
  当作账号农场特征。这是本次最关键的一条否决。
- **把 `expected`（Freebucks 口径）换成 `expectedUnits`** — 只留一个对账字段更干净。被否决：
  两本账的应退是**两个不同的数**，混在一起会让「Freebucks 侧为何长期 pending」这个未结问题
  彻底隐身。两个字段并存，正好把「哪本账兑现了」显式化。
- **`pending` 重放到超时就当退 0 出队** — 见 `2026-09-13-refund-reversed.md`：pending 的官方
  语义是「还没算完」，当作 0 是主动放弃已预扣余额。本次维持该决策不变。

## Consequences

- 调度多一道闸门：`session_units` 用尽的账号会被排到最后并记 `units_exhausted`，不再白跑 admit。
  因为 fail-open，老上游 / 无 `rateLimitsByModel` 的账号行为不变。
- **Freebucks 侧「早退是否真退钱」仍然未证实**（结论强度：medium）。本 note 只证明它**确实被扣**、
  且**不是** units 的替代品；是否退还仍取决于 `2026-09-13-refund-reversed.md` 里那条长期观测。
  两个问题必须分开问——这正是本文要固化的区分。
- `refunds[]` 每条多一个 `expectedUnits` 字段（向后兼容：老记录无此字段按 0 累计）。

## Testing

- `test/smoke.mjs`：新增「units 用尽 → `units_exhausted` 且不 admit」用例；既有
  `freebucks_exhausted` 用例保持通过（两码并存）。
- `npm test`、`npm run typecheck`、`npm run verify-notes` 全过。
- 真实上游实测记录于 `docs/evidence/ledger-session-units-vs-freebucks.json`。
