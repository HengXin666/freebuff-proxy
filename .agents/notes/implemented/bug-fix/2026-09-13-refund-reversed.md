# Agent Note: 早退 DELETE 的 Freebucks 退款回归 + 挂起退款必须被持续追问

Status: implemented

## Problem

「早退 DELETE 到底退不退 Freebucks」在本项目里被反复推翻过一次，而**错误的那一版被写进了代码、
配置默认值、控制台文案、README 和 AGENTS.md**，并用一条 `REFUND-COPY` 回归把相反的说法从全仓封杀。

第 3 版的推理链是：受控实验（占用 3 分钟 → DELETE → 每 3s 重放，共 20 分钟）里
`freebucksRefund` 金额字段始终不出现 ⇒ 结论「结构上不退」。**这个实验设计无法区分竞争假设**：

| 假设 | 占用 3 分钟 | 占用接近整小时 |
| --- | --- | --- |
| (a) 按占用比例退（短占用结算成 0） | 0 | **非 0** |
| (b) 结构上永不退 | 0 | 0 |

两个被观测的时间点都落在两假设预测相同的那一列。加上把 `freebucksRefundPending` 的语义
（官方类型注释：*"Final usage is still outstanding; replay DELETE with the same instance for
its receipt"*，即**结算未完成**）读成「不退」，就得出了错误的「已结案」。

更实际的一层：当时**只在启动时**扫一次挂起退款，进程不重启就再也没人重放过 DELETE——那笔
已经预扣的 Freebucks **没有任何一次追问**。「观测恒为 0」有很大一部分是我们自己造成的。

后果是策略整体反向：`idle_release_sec` 被从 60s 抬到 600s（理由是「早退不退、挂着不额外扣」），
推荐值算法、控制台文案、「省钱只能靠少 admit」的推理全部建立在这个前提上。

## Decision

**早退 DELETE 会按实际占用时长退还 Freebucks；`freebucksRefundPending` = 结算未完成，必须持续重放追问。**

一手依据（不是推理）：

- 上游 issue **#1337**：用户实测早退产生的 pending refund **会到账**，落在每日池且可跨日叠加；
- 上游 issue **#1324**：用户对「cancel early 拿回点数」是正常预期；
- 官方类型 `FreebuffDesktopRefundInfo`：*"Emitted only after the reversal ledger entry and
  purchase marker commit"*，带 `poolDate`（标明退回到哪一天的池子）；
- `freebucksRefund` 的定义：*"Final early-end refund receipt, including zero; retries return
  the same amount."*；
- 参考实现 trefeon/freebuff-proxy README：*"refunded on early `DELETE`"*，且其 `refund_refresh.go`
  实现了单飞重放 + `Settled/Pending/Amount` 三态 +「A zero receipt is a real receipt」。

落地为三件事：

1. **默认值反向**：`session.idle_release_sec` **600 → 60**；控制台 `idleReleaseAdvice` 推荐值
   区间改为 60 / 120 / 300s。
2. **持久化待结算退款队列**：`SessionHandleStore.pendingRefunds`（写进 `sessions.json`），
   `notePendingRefund` / `dropPendingRefund` / `sweepPendingRefunds`。**只有拿到终态回执
   （含 0）才出队**——绝不因为「问了几次还是 pending」就丢弃。
3. **两条追问通道**：进程内 `SessionManager._replayPendingRefund()` + 30s 定时器（窗口 1 小时）；
   进程级 `bin/serve.js` 每 5 分钟一次 `sweepPendingRefunds`（有界 30s 预算、`unref`）。
   重启后由启动扫尾接着追。

护栏也**反向**：`REFUND-COPY` 现在钉死「早退不退」这类旧说法；并断言 `sweepPendingRefunds`
与 `serve.js` 的周期调用存在、`idleReleaseSec` 默认为 60s。

## Alternatives considered

- **什么都不做 / 保持现状（结论=不退，默认 600s）** — 最省事，而且第 3 版的推理**内部是自洽的**，
  控制台、README、AGENTS.md 与测试全都对齐，没有任何「不一致」提示有问题。被否决的理由是：
  自洽不等于正确——它的核心实验**在设计上就无法区分两种假设**，而一手证据（官方账本类型、
  用户实测的跨日退款、参考实现）全部指向相反结论。继续维持现状的代价是**每次空闲释放都在
  放弃一笔已经预扣的钱**。
- **只改文档与默认值，不动追问逻辑** — 代价最小，且能立刻纠正文案。但这样仍然只在**启动时**
  扫一次挂起退款：进程不重启时，pending 的钱永远没人问。那只修好了叙事，没修好钱。
- **用无限重放（照抄官方 CLI 的每 3s）** — 官方客户端确实这么做，行为最「对齐」。被否决是因为
  对一个多账号常驻服务来说，3s 一条 DELETE 是持续的上游请求压力，且收益在拿到回执后归零。
  30s + 常驻扫尾 + 跨重启持久化，在「拿到钱」这个目标上等价，压力小几个量级。
- **pending 超时就当作退 0 收工** — 实现最简单，账本也干净。被否决：pending 的官方语义就是
  「还没算完」，当作 0 是**主动放弃**一笔已预扣的余额，而且会把这个错误结论沉淀成新的「事实」。

## Consequences

- 挂着的空闲会话重新变成**在花钱**：`idle_release_sec` 默认 60s 会让「喝口水再回来」这类停顿
  触发一次释放。**这是有意的**——早退会把未用时长退回来，而留在那里会一直计费；代价是
  「释放 → 重建」的 admit 往返变多（每次重建都要一次 admit 往返）。推荐值因此改为按
  模型/账号比在 60~300s 之间取舍。
- `sessions.json` 多了一个 `pendingRefunds` 段（向后兼容：缺失按空处理）。老文件能直接读，
  新文件在老版本里会被当作未知字段忽略。
- 上游若某天真的改成不退（或结算口径变化），现象会是：pending 长期不落地、退款恒为 0。
  届时应重跑实验——**这次请把占用调到接近整个会话窗口**，否则又会得到一个无法区分假设的结论。
- `freebucksRefund` 为 0 现在被当作**终态**（可以收工）。这是参考实现与 vendor af898dc 的口径。
  补充（2026-09-14）：**线上观测到的 0 全部落在 `deepseek/deepseek-v4-flash` 上**，而该模型实测走
  `session_units` 记账——那本 Freebucks 账**根本没产生消费**，所以 0 是**正确的终态**，不是「上游吞了钱」。
  原先按 Freebucks 单价算出的 `expected` 是用错了口径，已改为按 units 记 `expectedUnits`。
  两本账的**并行**关系见
  [2026-09-14-two-ledgers-parallel-gates.md](../architecture/2026-09-14-two-ledgers-parallel-gates.md)。

## Testing

- `test/smoke.mjs` (REFUND-COPY)：全仓扫描「早退不退 / 不退 Freebucks / 买断整小时」这类旧说法，
  出现即失败（`docs/account-scheduling-and-refund.md`、`test/smoke.mjs`、`.agents/notes/` 因需要
  引用旧说法而豁免）；并断言 `sweepPendingRefunds`、`serve.js` 周期调用、`idleReleaseSec: 60` 存在。
- `test/smoke.mjs`：`/api/settings` 未保存过时 `idleReleaseSec === 60`，且落在 5..300 区间。
- `npm run typecheck`、`npm test` 全过。
- **真实上游复测（2026-09-13 当晚，已完成但结论是「未证实」）**：三臂占用 2s / 3min / 50min
  （模型 5 FB/h，账号各 25 FB）+ 一条线上真实会话（占用 53min，15 FB/h）——
  **全部**只拿到 `{"status":"ended","freebucksRefundPending":true}`，**无金额字段**；
  线上那条拿到**终态 `freebucksRefund: 0`**（expected 1.66）。
  原始日志：`docs/evidence/refund-*.jsonl`。

  **这意味着本条 note 的结论强度是 medium，不是 high。**（2026-09-14 复核：本 note 覆盖的是
  **Freebucks 侧**是否退钱，**该问题至今仍未证实**；而 `session_units` 侧「早退当场按比例退」
  已被一手实测证实，两件事不要混为一谈——见
  [2026-09-14-two-ledgers-parallel-gates.md](../architecture/2026-09-14-two-ledgers-parallel-gates.md)。） 已实现的行为（持续重放追问 +
  只有终态才出队）**在任何一种结论下都正确**，所以保留；但「早退一定会退钱」这个前提
  **仍未被本仓库自己的观测证实**。跨每日池刷新点（`2026-09-14T07:00Z`）的观测在本 note
  写下时**尚未结束**。
