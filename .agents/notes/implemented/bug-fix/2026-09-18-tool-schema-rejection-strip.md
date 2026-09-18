# Agent Note: 上游以 tool-schema 指纹拒绝工具请求时剥离工具重试

Status: implemented

## Problem

下游调用**所有模型**都拿到空响应，错误文本是
`OpenAI API error (502): 502 status code (no body)`。

一手的链路与判定（2026-09-18，直连线上实例逐段对照）：

1. 客户端（DSH/Codex 类 agent）**每个请求都带 `tools`**（它们的工作方式就是调工具）。
2. 上游 Freebuff 对 `tools` 做 **tool-schema 指纹比对**——它把"工具集是否与官方
   CLI 一致"当作第三方客户端判据（freebuff 源码 `freebuff-models.ts` 原话：
   "the tool-schema check (docs/freebuff-abuse-detection.md), which downgrades
   third-party clients"）。
3. 比对失败时 /api/v1/chat/completions 回的是
   `404 {"error":{"message":"No endpoints found for <model>","code":404}}` ——
   **字面说"模型不存在"，与工具毫无关联**。
4. 代理把 404 当"客户端 4xx，不换号、不重试"（`shouldSwitchAccountForError` 的
   既有语义）原样透传；下游 Responses 桥接层（sub2api）处理该错误时崩成
   Cloudflare 纯文本 502（body 仅 `error code: 502\n`），OpenAI SDK 解析不出
   JSON，于是报 "502 status code (no body)"。

实测矩阵（同一 key、同一模型、直连线上 freebuff-proxy）：

| 请求 | 结果 |
|---|---|
| 无 `tools` | **200**（稳定复现） |
| `tools:[bash]` | 404 No endpoints found |
| `tools` = 逐字复刻官方 24 个工具名 + 中性 schema | 404 No endpoints found |
| `functions`（OpenAI 旧式字段） | 200，但模型把调用写成正文而非结构化 `tool_calls`（不可用） |
| 无 `tools` + `tool_choice` | 200 |
| 无 `tools` + `response_format` | 200 |

即：**只要带 `tools` 就被拒**，与工具名/schema 内容无关；`tools: []` 与完全不带的
行为一致（200）。

同一批实验中还确认了第二个缺陷：上游对第三方客户端的封禁回的是
`403 {"error":"account_suspended","message":"...third-party client or proxy..."}`，
`error` 是**字符串**、没有 `code` 字段。既有的 `shouldSwitchAccountOnError` 只认
`banned` / `country_blocked` / `ip_capped` 三个 code，于是这个 403 落进
"4xx 客户端错误不换号"分支：**每个被封的账号被反复复用**，错误原样甩给下游，
`markCooldown` 也记不上 `bannedAt`（控制台看不到封禁）。

## Decision

**把"工具被上游拒"当成一种可恢复杂志，剥离工具后重发一次。**

- `src/free-mode.js` 新增 `hasClientTools` / `stripClientTools`：后者删
  `tools` / `tool_choice` / `parallel_tool_calls`（`functions` 不删——它不触发该检查）。
- `src/proxy.js` 的 `forwardCompletions` 在响应头阶段改为**最多两轮**：第一轮带原
  工具集；若被 `isToolSchemaRejection`（404 + "No endpoints found"）判定为工具拒绝，
  第二轮去掉工具重发。命中时回 `x-freebuff-proxy-tools-stripped: 1`，让下游能看见
  "这次是无工具模式"。
- 只在**客户端确实带了 `tools`** 时才可能重试（没工具可去时重试无意义）；受
  `settingsStore.stripToolsOnSchemaRejection`（默认 true）控制，可在控制台关掉。
- `src/upstream/client.js` 新增 `extractAccountBanError`：把
  `account_suspended` / `banned` / `country_blocked` 归一为 `banned`；
  `forwardCompletions` 据此**重算 `effectiveErrCode`**（只改响应体而不改
  `errCode`，`shouldSwitchAccountOnError` 与 `markCooldown` 仍然照旧分支，等于没改）。

取舍是明确的：**宁可丢工具能力，也不能全体空响应**。剥离后模型仍给出文本回答，
下游 agent 至少能继续跑（本轮无工具调用，下一轮同样如此）；不剥离则所有模型全废。

## Alternatives considered

- **什么都不做，把 404 原样透传** — 最省事，且"不替客户端做决定"本身是个好原则。
  但它等于承认"带工具的 agent 完全不可用"：受影响的是**所有**以工具为工作方式的
  下游（DSH / Codex 类），空响应对它们就是全损。实测已证明该 404 与"模型不存在"
  无关，继续按客户端错误处理是**错误归因**，不是保守。
- **继续补签名工具（往 tools 末尾加官方 `end_turn`）** — 既有实现
  （`ensureFreebuffToolSignature`，v1.10 引入）正是这个思路，注释写着"补一个官方工具名
  免得被当成外来工具集"。它的**最强理由**是：这曾是真实有效的对策，且成本为零。
  但 2026-09-18 实测已使其失效——`tools` 里哪怕是逐字复刻的官方 24 个工具名，
  照样 404。保留该开关（不再依赖它），把真正生效的剥离逻辑另立。
- **逐字复刻官方 24 个工具的完整 schema** — 理论上能过指纹（官方 CLI 就是靠它通过
  的）。但官方 schema 是**上游私有实现**（要从 140MB 二进制里逆），每次上游改版都要
  重逆一遍；且这只是"伪装成官方客户端"，与项目定位（合法转发免费额度）相悖，维护
  成本与风险都远高于剥离。此举还会掩盖真实失败原因。
- **用 `functions` 旧字段绕过** — 实测确实 200，但模型把工具调用写成正文文本而非
  结构化 `tool_calls`，下游解析不到调用，等于工具能力失效。换个字段换个死法。
- **把该 404 当作账号级故障换号重试** — 换号解决不了：这是**请求形态**被判据拒绝，
  每个账号都会拒。白烧 admit 预算（一次 admit 买断一小时）。

## Consequences

- 带工具的请求：第一次仍会打到上游并吃一个 404（多一次往返），之后才剥离重试。
  上游若恢复接受工具集，这条路径自动不再触发（无状态判据，无需回滚开关）。
- **工具能力在免费模式下不可用**：模型不会返回 `tool_calls`。这是上游判据的结果，
  不是本代理的取舍。下游若强依赖工具，应改用自带 key 的付费通道。
- `account_suspended` 归一为 `banned` 后，被封账号进入 24h 冷却并在控制台标记
  `banned`——这是**正确的**行为（该账号确实不能再用于免费模式），代价是账号池会
  快速见底，需要换号/补号。
- 新增下游可见的响应头 `x-freebuff-proxy-tools-stripped`；新增设置项
  `stripToolsOnSchemaRejection`（`/data/settings.json`，web API 可读写）。

## Testing

- `test/smoke.mjs`（`tool_schema_reject`）：带 `tools` 时 mock 上游回
  404 No endpoints found → 断言**恰好两次** chat 调用、第一次带原工具、第二次
  `tools === undefined`、响应 200 且带 `x-freebuff-proxy-tools-stripped: 1`。
- `test/smoke.mjs`（无 `tools` 对照）：不触发拒绝、只调用一次。
- `test/smoke.mjs`（`suspended_a` 多账号）：token-a 回 403
  `account_suspended` → 断言换到 token-b 成功、且 a 在 `runtimes.list()` 里
  `banned === true`。
- 线上一手对照实验（本文 Problem 的矩阵）为这套判据的来源。
