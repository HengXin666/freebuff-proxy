# Agent Note: 一次 admit = 买断一小时 —— 已付费时段内不释放会话

Status: implemented

## Problem

`idle_release_sec` 的语义建立在一个**已被证伪**的前提上：早退 `DELETE` 能把未用时长对应的
Freebucks 退回来，所以「挂着的空闲会话是在花钱」，越早释放越省。

一手实测（2026-09-14，账号 `lolid8faw4er@outlook.com`，模型 `upstage/solar-pro4`——该模型
**没有 units 行**，所以是**纯 Freebucks 计费**，排除了 units 那本账的干扰）：

| 步骤 | 观测 |
| --- | --- |
| admit 前 | `rem=5 spent=20` |
| admit 后 | `rem=0 spent=25` —— **当场扣满整小时单价** |
| 25s 后 DELETE | `{"status":"ended","freebucksRefundPending":true}`（无金额） |
| +20 / +40 / +60 / +120s | `rem=0 spent=25` —— **未到账** |
| 重放 DELETE ×2 | 仍只有 `pending`，始终无金额 |
| 重新 admit 同模型 | `rate_limited` + `freebucksShortfall` —— **钱确实没了** |

这与 `session_units` 侧形成**关键的不对称**：units 早退是**当场按比例退**的（实测 `1.1 → 0.2`）。
而实测 24 个「账号 × 模型」组合里 **22 个是 Freebucks 先见底**（`deepseek-v4-flash` 单价 25、
池 10 → 只有 **0.4 小时**的 Freebucks，却有 **6 小时**的 units）。

所以旧策略是**拿稀缺的账去省不稀缺的账**：在已付费的这一小时内，继续发请求的边际成本是 **0**，
而释放之后重开要**重新买一整小时**。

## Decision

**一次 admit = 买断一小时。已付费时段内（`expiresAt` 之前）不因空闲而释放。**

- `SessionManager.paidWindowRemainingMs()` / `inPaidWindow()`：以 `expiresAt` 为主，
  `remainingMs` 按 `admittedAt` 折算兜底；`status === "ended"` 视为 `0`（不再续期）。
  判定不出时返回 `null` / `false` = **不拦**（fail-open）。
- `_armIdleRelease()`：`inPaidWindow()` 为真则**直接清掉计时器、不释放**。
  `idleReleaseSec` 因此变成**付费时段结束之后**的空闲释放时长（默认仍 60s）。
- 腾槽位给别的模型仍由上层**显式** `release` 负责，不再借用这条空闲路径。
- 句柄与持续重放追问**保持不变**（pending 时丢弃就连追问的机会都没了），
  但**不得**把 pending 当成「钱会回来」来决策释放时机。
- **复用必须可见**（用户要求：「总之能让用户知道我们在节约」）：`SessionManager`
  记 `admitCount`（真买过几条）与 `reuseCount`（热路径命中几次 → 零边际成本），
  经 `getSnapshot()` → `/api/accounts` 到控制台。总览显示**会话复用率**
  （`reuse / (reuse + admit)` = 省掉的重买比例），账号行显示「买 N · 复用 M（省 X%）」。

## Alternatives considered

- **什么都不做（保持 60s 空闲释放）** — 最省事，且 tests/文案/AGENTS.md 全都自洽。被否决是因为
  它的核心前提已被上面那张表的最后两行**直接证伪**：释放既拿不回 Freebucks，又让重开多买一小时。
  维持现状等于每小时主动丢掉那笔已买的额度。
- **付费时段内改为「释放后立刻重开同一模型」** — 看似能既腾槽位又不浪费。被否决：实测重开
  直接吃 `rate_limited` + `freebucksShortfall`，说明那一小时的钱是真的没了；且这会把 admit 次数
  翻倍，正好是上游判定「账号农场」的特征。
- **删掉 Freebucks 闸门、全部改看 `session_units`** — 用户曾倾向这条（「全部改用 session_units」）。
  被实测直接否决：`deepseek-v4-flash` 在 units `0.1/6` 完全没超标时仍被 Freebucks 拒付，
  上游回执明写 `pool: freebucks` / `freebucksShortfall`。删掉等于主动去撞封号判定。
  两道闸门**并行**，见 [2026-09-14-two-ledgers-parallel-gates.md](./2026-09-14-two-ledgers-parallel-gates.md)。
- **把 `expiresAt` 判在控制台而不是调度层** — 只修展示、不修行为。被否决：释放是**行为**，
  在展示层修补不了真的丢钱；展示层的问题要单独修（见下）。
- **省下的钱只靠推导、不落数字** — 最省事：既然"时段内不释放"已经写进代码，省了多少
  理论上算得出。被否决是因为**用户要的是看得见**，而推导出来的数在控制台上不存在时，
  没法回答"这套策略到底有没有在省"。落两个计数器即可给出可核对的证据。
- **加「立即释放 / 立即复用」按钮** — 交互上更"完整"。被否决：手动释放正是本决策要禁止的
  动作（那一小时已付款），给个按钮等于把刚拆掉的坑重新摆出来。**只展示、不给操作**。

## Consequences

- **一个账号的一小时被钉在某个模型上。** 这是本决策的真实代价，不是免费的：账号同时只有一条
  session 且 session 绑定模型，所以持有一小时 = 这一小时内别的模型在该账号上要等。
  缓解手段是**账号池摊开**，不是频繁释放。附带好处：admit 次数大幅下降，更不像「轮换账号农场」。
- **诚实的不确定性**：「这一小时内无法拿回钱」是**实测确立**的；
  「永不到账」**没有**被断言——观测窗口只有 2 分钟，而每日池刷新点在约 16 小时之后，
  跨刷新点的结算仍未测。若某天观测到 pending 落地，本决策的**权重**（而非方向）需要重估。
- `expectedUnits = 1 − max(0.1, 占用小时数)` 作为 units 口径的对账字段，与 Freebucks 口径的
  `expected` **并存**：两本账的应退是两个不同的数，混在一起会让「Freebucks 侧为何长期 pending」
  这个未结问题彻底隐身。
- 控制台 `classifyAccount` 必须把「`rem=0` 但在付费时段内」判为**可用**而不是额度不足——
  否则本决策会让每个正在被正常使用的账号都显示成「耗尽」。这需要 `session.expiresAt` 传到前端。

## Testing

- `test/smoke.mjs` (1)：admit 后 `inPaidWindow() === true`；等 600ms（远超 `idleReleaseSec = 150ms`）
  **断言 `sessionDeletes === 0` 且会话仍为 `active`**；把 `expiresAt` 拨到过去后再断言释放**恢复生效**
  （`DELETE` 带 `x-freebuff-instance-id`、退款回执落账）。这条用例在两个方向上都钉死了行为。
- `REFUND-COPY` 全仓扫描改为钉死**新**的旧说法（按实际占用退还 Freebucks / 退还未用时长 /
  挂着的空闲会话在按小时计价 / 越早释放越省）。它在本轮真的抓到了 AGENTS.md、bin/pricing.js、
  docs/configuration.md、docs/scheduling.md、dashboard/app.js 里漏改的 8 处。
- `npm test`、`npm run typecheck`、`npm run verify-notes`、`docker compose config --quiet` 全过。
