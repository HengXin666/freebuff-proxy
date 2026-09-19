# Agent Note: Hermes `delegate_task` 工具名窄范围双向别名

Status: implemented

## Problem

Hermes 的 delegation 工具名固定为 `delegate_task`。Freebuff 当前把这个名字明确列入
`FOREIGN_HARNESS_TOOL_NAMES`（OpenClaw 组），且 `foreign_tool_names` 属于受罚信号。
因此即使请求已经带了 genuine signature tool，单独出现这个名字仍可让请求走异常工具通道。

Issue #17 的单变量对照实验把触发条件缩到**名字本身**：

- 同模型、同问句、复用 session：10 个工具不含 `delegate_task` → 3/3 正常；
- 同一工具集加 `delegate_task` → 2/3 返回原始 DSML 文本；
- 加任意其它第 11 个工具 → 3/3 正常；
- Hermes 全部 15 个工具去掉 `delegate_task` → 3/3 正常；
- 描述/schema 不变，仅把名字改成 `spawn_subagent` → 3/3 正常，并能返回结构化
  `tool_calls` 调用该别名。

Hermes 内部对 `delegate_task` 有大量字面派发与 guardrail 依赖，直接改 Hermes 端会扩大
维护面，并会在 Hermes 升级时被覆盖。

## Decision

在代理边界对**这一处已证实的名字冲突**做窄范围双向别名：

- 仅当客户端实际声明 `delegate_task` 时启用；
- 去程选择无冲突别名，首选 `spawn_subagent`；若客户端已有同名工具则按
  `spawn_subagent_2`、`spawn_subagent_3`… 递增；
- 同步改写 `tools[].function.name`、对象形 `tool_choice.function.name`、
  历史 assistant `tool_calls[].function.name` 和 role=tool 消息的 `name`；
- 回程把该次请求选中的别名恢复为 `delegate_task`；
- 非流式 JSON 整体恢复；流式 SSE 逐 `data:` 行恢复，只改携带 `function.name`
  的 chunk，arguments 分片原样透传；
- 激活时删除上游 `Content-Length`，并返回
  `x-freebuff-proxy-tool-alias: delegate_task=<alias>` 便于观测。

这不是通用 harness 翻译层：只修复 Issue #17 已经用 A/B 实验证实的单个名字碰撞，
避免把参数 schema 不同的其它工具贸然做大范围映射。

## Alternatives considered

- **什么都不做** — 最省代码，也避免维护任何别名。但完整 Hermes 工具集会间歇返回
  DSML 正文而不是结构化 `tool_calls`，子代理功能和同轮其它工具都可能一起失效。
- **在 Hermes 源码里把 `delegate_task` 永久改名** — 语义最直接，不需要代理回译。
  但 Hermes 的 delegation 派发、guardrail、UI、压缩器等多处依赖字面名，改动面大，
  且 `hermes update` 会覆盖本地 fork。
- **从上游工具集直接删除 `delegate_task`** — 实现最小，也不会出现名字冲突。
  代价是该 provider 永久失去 delegation/subagent 能力，且模型不知道该能力存在。
- **把全部 `FOREIGN_HARNESS_TOOL_NAMES` 做通用双向映射** — 一次解决未来相似名字。
  但其它工具往往不只是名字不同，参数 schema/结果格式也不同；没有逐个对照实验时做通用
  翻译容易制造静默错调用。Issue #17 只证明了 `delegate_task` 的名字冲突，因此保持窄修。
- **只改 tools 声明，不改历史和回程** — 首轮可能成功，但多轮会话历史仍泄漏原名，
  模型返回别名后 Hermes 也无法派发。工具协议必须端到端对称。

## Consequences

- Hermes 无需修改，仍只看见并执行 `delegate_task`。
- 代理上游 wire 中不再出现该名字；本地 `detectForeignClient` 不会因此命中
  `foreign_tool_names`。
- 仅在请求声明该工具时增加 SSE 解析开销；其它请求仍保持原始字节透传。
- 如果上游未来把选中的别名也加入显式外来工具名表，问题会重新出现；响应头与现有
  foreign-client 日志可以帮助快速定位。
- 这条修复不改变 `foreign_system_prompt`、出口 IP、账号风控或其它独立信号。

## Testing

`test/smoke.mjs` 新增纯函数回归：

- 默认别名与冲突避让；
- tools / tool_choice / assistant 历史 / tool message 去程改写；
- 原客户端对象不被原地修改；
- genuine signature 注入后再跑本地判据，断言不命中 `foreign_tool_names`；
- 非流式 message/delta `tool_calls` 回译；
- SSE `data:` 行回译。

完整仓库仍由 PR CI 执行 `npm test`、`npm run typecheck` 与现有门禁。

## Related

- Issue #17：Hermes `delegate_task` 单变量复现与 A/B 证据。
- [2026-09-19-genuine-tool-signature.md](2026-09-19-genuine-tool-signature.md)：
  genuine signature 解决 `foreign_toolset`；本文补上显式 `foreign_tool_names` 的
  Hermes 单点碰撞。
