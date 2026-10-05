# Agent Note: official 通道是 RPC 委托,不是在主服务重复实现

Status: implemented

## Problem

主服务的请求体原本是**自己拼**的:`ensureFreebuffSystemMessages()` +
`ensureFreebuffToolSignature()` + CLI 世代 agent.来源是早期第三方项目加
多年补丁,已无法与官方逐字段核对.

2026-10-03 抓到官方客户端真实流量后,我先做了一件**错事**:把官方形态
(system 模板 / 37 工具 / desktop agent)**又在主服务实现了一遍**
(`src/upstream/official-shape.js` + `official-assets/`).

用户明确指出:**不要重复迁移一套代码**.两份实现必然漂移,官方形态一变
要改两处,而且等于把 cli-bridge 里已实测通过的逻辑丢掉重写.

## Decision

**主服务不实现官方形态,只做 RPC 委托.**

边界划分:

| 侧 | 职责 |
|---|---|
| 主服务(Node) | 持有 instanceId / runId,通道判定,把参数交给副仓库,透传响应 |
| 副仓库(cli-bridge,bun) | desktop 世代 startRun,官方形态构造 + 发送 chat |

实现要点:

- 用副仓库的 `reuse`(只 startRun + chat)而非 `full`:
  主服务**已经**做过 admission 并持有会话,副仓库不该再买一次
  (一次 admit = 买断一小时).
- `src/upstream/official-rpc.ts` 是薄客户端:只做参数转发与结果透传,
  **不含任何协议逻辑**.`buildRpcCfg()` 负责把主服务的设备密钥文件转成
  副仓库需要的 cfg(`client.js` 为此暴露 `deviceKeyPath`).
- 通道优先级:`settingsStore.upstreamChannel`(前端可调)>
  `config.upstream.channel`(兜底).默认 `official`.

## Alternatives considered

- **在主服务完整实现官方形态** —— 已做过,被否.两份实现漂移,
  且丢掉已验证逻辑.**已删除**(`official-shape.js` / `official-assets/`).
- **主服务 spawn bun 自己拼请求** —— 那还是主服务持有协议逻辑,
  只是换了执行器.**否决**:协议实现必须在副仓库,主服务只传参.
- **主服务完全不管,全权交给副仓库(含 admission)** —— 会破坏主服务
  已有的会话管理与账号调度(多账号池,粘性优先,冷却).
  **否决**:采用最小委托面(只委托 startRun + chat).
- **official 下跳过主服务的 startAgentRun** —— 试过,导致 runId 为
  undefined:FINISH 上报与 RPC 失败回落都需要它.**改为仍发**:
  chat 世代由副仓库自己的 startRun 决定,不受影响.

## Consequences

- 协议实现**只有一份**(副仓库).主服务零协议代码.
- RPC 失败时降级到 legacy:请求体会补成 legacy 形态
  (`ensureFreebuffSystemMessages` + 签名工具)再走原 raw 路径,
  避免发出"既无官方 system 也无签名工具"的畸形请求.
- `toolStripCapable` 移到 RPC 之后计算:只有**确定**走了官方形态才禁用
  [剥离工具重试]退路;降级到 legacy 时该退路重新生效.
- 循环控制修了两个 bug:
  - `for (round < 2 && !upstreamRes)` 会让第一次 404 后不再重试;
  - 循环开头 `if (upstreamRes) break` 会打断第二次重试.
  改用独立的 `_rpcResponse` 标记,语义清晰.
- `npm test`(smoke ok)与 `npm run typecheck` 全绿.

## Evidence

- cli-bridge 实测:official 形态 200 + `write_file` 工具调用
  (`docs/reverse/16-success-200-with-toolcall.md`).
- 抓包真值:`docs/reverse/captures/2026-10-03-official-client.jsonl`.
- 差异分析:`docs/reverse/14-captured-diff.md`,
  `15-protocol-review.md`,`17-current-status-and-gaps.md`.
