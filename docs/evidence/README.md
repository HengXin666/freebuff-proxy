# 退款复测原始日志（2026-09-13）

这一目录是**实证留档**，用来支撑/证伪 `docs/account-scheduling-and-refund.md` §3 关于
「早退 DELETE 是否退还 Freebucks」的结论。**不要删**——这个结论已经反复三次，
下一次想改这个结论的人必须能读到当时的原始数据。

## 实验设计（为什么要这样测）

旧的受控实验（占用 3 分钟 → DELETE → 重放 20 分钟）**在设计上无法区分**两个竞争假设：

| 假设 | 占用 3 分钟时 | 占用接近整小时时 |
| --- | --- | --- |
| (a) 按比例退，但短占用被结算成 0 | 0 | 非 0 |
| (b) 结构上永不退 | 0 | 0 |

旧实验只测了左列，所以它证明不了任何一方。本轮把观测窗口拉长、并加了多臂对照。

## 本轮观测（模型 `upstage/solar-pro4` = 5 FB/h，另有 15 FB/h 的线上真实会话）

| 臂 | 占用 | 结果 |
| --- | --- | --- |
| `refund-W.json` | **2 秒**（复现 issue #1337 的即时中断） | DELETE → `{status:ended, freebucksRefundPending:true}`，**无金额**；扣 5 FB |
| `refund-verify.jsonl` X | **3 分钟** | 同上，**无金额** |
| `refund-verify.jsonl` Y | **50 分钟** | 同上，**无金额** |
| `refund-long.jsonl` Z（线上真实会话） | **53 分钟**（15 FB/h） | **终态** `{status:ended, freebucksRefund:0}`，expected 1.66 |

`refund-desktoprefunds.jsonl`：轮询 GET `/session` 抓 `desktopRefunds` 字段（官方类型里的
账本级退款记录）——**始终为 null**。

## 结论强度：**medium，不是 high**

- **有利**：官方类型 `FreebuffDesktopRefundInfo`（*"emitted only after the reversal ledger
  entry and purchase marker commit"*，带 `poolDate`）、issue #1337 用户实测到账、
  参考实现 trefeon/freebuff-proxy 的 README（*"refunded on early DELETE"*）
  都指向「会退」。
- **不利**：**本仓库自己的观测没有一笔到账**，且线上有一条**终态 0**。
- **未决**：issue #1337 说到账发生在**每日池刷新时**。本轮的观测窗口（约 10 分钟）
  **没有跨过**刷新点 `2026-09-14T07:00Z`——所以「未观测到到账」**不能**证明「不会退」。

> 要终结这个问题，唯一有判别力的实验是：**跨过每日池刷新点**观测同一批 instance
> 的 `freebucksRefund` 与 `daily.remaining`，看 remaining 是否突破 `limit`。
> 在这之前，**任何一方都不该宣称「已结案」**——这个结论已经反复三次了。
