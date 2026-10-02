# Agent Note: chat 必须带 `x-freebuff-instance-id`，否则上游 428

Status: implemented

## Problem

带工具的 chat 请求稳定失败，现象极具误导性：

```
admission     200 {"status":"active","instanceId":"cli:xxx"}   ← 会话真建成
startAgentRun 200 {"runId":"..."}                              ← run 真建立
chat          428 {"error":"waiting_room_required",
                   "message":"Your free session has ended. Send your message again to start a new one."}
```

前两跳全绿、第三跳必挂，且错误文案说"会话已结束" —— 看起来像是
**会话建完就消失**，于是排查方向被引向槽位竞争、客户端占用、TLS 指纹、
代理出口，全都查了一圈也没对上。

真因在 `src/proxy.js` 的 chat 头部组装：只有 `officialChatHeaders`
（Authorization + user-agent + 可选的 `x-freebuff-acting-user-id`），
**没有 `x-freebuff-instance-id`**。上游收到 chat 请求但不知道它属于哪条会话，
于是按"无会话"处理 → 428。

⚠️ 矛盾点：`codebuff_metadata.freebuff_instance_id` 一直是填了的
（`buildForwardBody` 第 1396 行）。**体里有、头里没有**，
所以看请求体看不出问题 —— 这也解释了为什么长期没被发现。

## Decision

**`forwardCompletions` 新增 `instanceId` 参数，并在 chat 头部带上
`x-freebuff-instance-id`。**

- 头部常量复用 `src/upstream/official-fingerprint.js` 的 `HEADER_INSTANCE_ID`，
  不另立字符串。
- 值取 `snap.instanceId`（admission 回执给出、调用点已在用）。
- 缺失时（老上游 / 无会话路径）不发该头，行为与改前一致 —— 不引入新失败面。

## Alternatives considered

- **什么都不做** —— 最省事，且表面看"元数据里已经有 instance id 了"。
  但头部才是上游路由会话的依据，体里的那份不顶用。
  不做就等于永远停在 428，且错误文案会持续误导下一个人
  （本次实际代价：绕了一大圈槽位/指纹/出口，全错）。
- **把 instanceId 塞进 metadata 的其他键** —— 已有 `freebuff_instance_id`
  证明无效。上游读的是 HTTP 头，不是 body。
- **改成 chat 失败时 re-admit 重试** —— 仓库判据里 `waiting_room_required`
  确实属于可恢复 gate，但它掩盖真因：re-admit 一次 = 买断一小时额度，
  而每次都会因为同样的头部缺失再次 428，**纯烧钱**。

## Consequences

- 带会话的 chat 现在携带实例 id，上游能定位会话。
- 无 instanceId 的旧路径行为不变（不新增头部）。
- `npm test`（smoke）与 `npm run typecheck` 全绿。
- 该头部是**逐字对齐官方**的既有常量，不构成新的指纹面。

## Evidence

- 2026-10-03 实测（`cli-bridge`，bun 侧逐字节 dump 确认）：
  - 缺失时：`x-freebuff-instance-id` 不在头部清单 → chat 稳定 428。
  - 补上后：头部出现 `x-freebuff-instance-id: cli:fc4a5595-…` →
    **428 消失**，转为模型侧 503（另一个独立问题）。
  - 单变量对照：只改这一个字段，其余完全不动。
- 代码核对：`src/proxy.js` 的 chat headers 只有 `officialChatHeaders`，
  而 `buildForwardBody` 的 metadata 里一直有 `freebuff_instance_id`。
- 详见 `docs/reverse/12-waiting-room-slot-contention.md`。
