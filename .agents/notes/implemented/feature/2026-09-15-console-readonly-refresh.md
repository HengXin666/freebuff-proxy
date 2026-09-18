# Agent Note: 控制台刷新是只读探测 + 定点更新，且不丢已购会话

Status: implemented

## Problem

用户在同一个会话里提了三条前端要求，背后是三个各自独立的真实缺陷：

1. **刷新会丢钱**。控制台原先只有「探测刷新」，而 `SessionManager.refresh()` 无条件
   `this._apply(body)`：上游对账号级故障（`banned` / `country_blocked` / `rate_limited` /
   `ip_capped` / `free_mode_rate_limited`）的 GET 回执是 403/429 + `{status:"banned"}` 这种形态
   （`upstream/client.js` 直通），于是点一次刷新就会把 session 覆盖成
   `{status:"banned", instanceId: undefined}` —— **活着的 instanceId 被抹掉**。那条会话已经实付了
   一整小时（见 [2026-09-14-paid-hour-hold.md](../architecture/2026-09-14-paid-hour-hold.md)），
   句柄一丢就再也 DELETE 不掉、退款的唯一凭据也没了；同时 `lastProbe` 还被记成 `ok: true`，
   探测失败却显示成功。
2. **测试对话只有一个模型**。`buildModelsListResponse` 用 `m.accessTiers.includes(accessTier)`
   算 `available`，而内置 catalog 的 15 条**都没有 `accessTiers` 字段** → 一律回落 `["full"]` →
   上游回一次 `accessTier:"limited"`，整张目录就被染成 `available:false`；测试对话又按
   `available !== false` 过滤，于是只剩 `extraIds` 里那一个模型。
3. **刷新会重置分组展开状态**。`refreshAccountsCard` / `probeAllAccounts` /
   `refreshOverviewAfterAccountChange` 三处都是 `wrap.innerHTML = ""` 后整块重建账号表，
   等于把用户手动摊开的分区、滚动位置一次性清掉。

另外「能不能用」只有一档：`available = !cooling`。冷却到期后已封禁的号也会重新显示为可用，
用户无法区分**终态封禁**与**暂时被上游拒付**。

## Decision

**刷新是只读探测 + 定点更新；`available` 只表示「能不能请求」，不再编码账号处境。**

- `POST /api/accounts/refresh`（新）：逐账号 `sessions.refresh()` 刷新额度与探测状态，顺手刷新上游模型
  目录（多账号取并集），并把 `banned` / `rate_limited` 等**账号级** code 落冷却，让控制台显示与调度
  判断同源。**不做 admit、不 DELETE、不动任何句柄** —— 已购时段在刷新前后完全一致。
- `SessionManager.refresh()` 新增 `accountLevelSessionStatus(body.status)` 拦截：账号级回执**只当探测
  结果**（保留会话现场、落 `lastProbe.ok = false` 后抛出），绝不 `_apply`。调用方据此区分 ban /
  风控 / IP 上限。
- `AccountRuntimes.list()` 新增 `banned` / `unavailable` / `status` 三个字段。`available` 保持原语义不动
  （不改既有消费者）；`banned` = 账本有 `bannedAt` 或当前冷却 code 是 `banned`（终态），`unavailable`
  = 被上游暂时拒付（冷却到期自愈）。控制台徽章与统计卡按它们分三档显示。
- `buildModelsListResponse` 的目录条目**一律 `available: true`**；`accessTier` 只作为元数据透出
  （`access_tiers` / `current_access_tier`）。`/api/models` 另外回 `upstreamModelIds`（上游此刻真给了
  额度的模型）供前端**标注**，不是过滤依据。测试对话下拉因此显示全部 17 个模型，`✅` 标出上游给额度的那些。
- 前端账号表改为**定点更新**：`applyAccountsSections()` 复用现有 `<details>` 外壳（连同 `open` 状态），
  只替换 `<tbody>` 的行，再用 `append` 移动节点校正分区顺序（移动同一元素不重置展开状态）。展开状态记在
  `state.acctSectionsOpen`（用户 `toggle` 时写入）而不是读 DOM —— 分区可能因本轮无账号而整体消失，
  消失期间也要记住用户偏好。

## Alternatives considered

- **什么都不做** — 现状「能用」。被否决：这三条各自的后果都不是观感问题。刷新丢句柄等于持续丢钱
  （每个被刷新的活会话都变成无法寻址的计费孤儿），模型列表只剩一个会让下游客户端以为不能用，
  而整块重建是用户已经点名要求修的行为。
- **只改前端过滤条件（不过滤 / 取反）** — 一行就能让模型都显示出来。被否决：病根在 `available` 的
  定义（拿静态目录准入冒充实时配额），前端绕过它只会让 `/v1/models` 这个下游可见契约继续骗人；
  而且「元数据透出 vs 过滤依据」这条线一旦模糊，下一个消费者还会踩。
- **刷新时顺手释放坏账号的会话腾槽位** — 听起来更彻底。被否决：这是**直接丢钱**。一次 admit 买断
  一小时，付费时段内释放等于把已付的钱作废（实测早退只回 `freebucksRefundPending`，见
  [2026-09-14-two-ledgers-parallel-gates.md](../architecture/2026-09-14-two-ledgers-parallel-gates.md)）。
  用户明确要求「刷新和警告都不会导致丢失已购买的会话」—— 这条是硬约束，不是优化项。
- **把展开状态存进 `localStorage`** — 能跨页面刷新保留。被否决：用户要的是**同一次会话里的局部刷新**
  不重置，不需要跨浏览器会话持久化；写 localStorage 反而多一个需要清理的状态源，且和「局部更新」这个
  更根本的修法无关。
- **给封禁单独做一个页面/弹窗** — 信息更全。被否决：封禁只有「什么时候被封的」这一条信息，一个徽章
  加一个统计卡数字就够；单独页面会让日常视图更碎。

## Consequences

- 刷新语义被钉死为**只读**：任何「刷新时顺便清理 / 顺手释放」的改动都违反本决策。回归断言在
  真实端到端里（刷新前后上游的 `sessionPosts` / `sessionDeletes` 计数必须不变）；`test/smoke.mjs`
  钉住的是底层不变式：账号级回执不得改 `this.session`。
- `banned` 与 `unavailable` 是**两档**：冷却到期只会让号从 unavailable 回到 ok，**不会**让 banned 回 ok。
  这是刻意的 —— `bannedAt` 是终态标记，只有换号/平台解封才该消失。
- 分区顺序现在同时是**渲染顺序**（`applyAccountsSections` 用 `append` 序列校正），所以任何「分区顺序 =
  优先级」的调整都要同时改 `ACCOUNT_SECTIONS`。
- 已购会话的存活不再依赖任何刷新路径的善意：`refresh()` 只可能失败并抛出，不会改 `this.session`。

## Testing

- `npm test`（`test/smoke.mjs`）新增两组回归，**都验证过「还原根因即变红」**：① `accessTier="limited"`
  时不得有任何模型 `available === false`，且 `available !== false` 过滤后长度不得缩水；② 账号级回执下
  `refresh()` 必须抛出、`session.instanceId` 与 `status` 原样保留、`lastProbe.ok === false`。把 `model.js`
  的判断改回旧逻辑 → ① 红；把 `accountLevelSessionStatus` 短路成 `null` → ② 红。
- 真实端到端（临时脚本，验证后已删除）：起真实 HTTP 服务 + 照上游契约写的 mock 上游，登录后打
  `/api/models`（17 个模型、`upstreamModelIds` 3 个）、`/api/accounts/refresh`（`sessionPosts` /
  `sessionDeletes` 计数不变）、`/api/overview`（正常 → `status:"ok"`；封禁 → `banned:true` + `bannedAt`；
  限流 → `unavailable:true` 但 `banned:false`）。
- 真实浏览器（headless chromium + CDP）：手动展开一个折叠分区 → 点「一键刷新」→ 断言分区 `data-uimark`
  身份与 `open` 状态**逐项不变**（= 原地更新而非重建）、状态徽章出现「可用」与「限流」两档、测试对话下拉
  17 项且 `✅` 标注 3 项、控制台零 JS 异常。
