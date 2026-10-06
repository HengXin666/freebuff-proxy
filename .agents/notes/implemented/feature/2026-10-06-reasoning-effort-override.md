# Agent Note: 思考强度覆盖 -- 控制台逐模型强制出站 reasoning effort

Status: implemented

## Problem

上游请求里发不发思考档位, 此前由下层决定; 官方通道(`official`, 唯一有效通道)下
主服务把整条 chat 委托给副仓库, 副仓库的 `buildMetadata` 只在收到 `reasoningEffort`
时才写 `codebuff_metadata.freebuff_reasoning_effort`, 而主服务从不传它 ----
于是出站体里根本没有这个键, 上游按自己的 defaultEffort 决定思考深度.

用户要求: 控制台要有一个总开关, 打开后可以逐模型指定档位; 指定了就必须忽略下游
(客户端)传来的 `reasoning_effort`, 直接按配置的档位发上游; 默认关闭; 实时生效;
界面要好看. 并明确要求[不同模型的档位不同, 不能统一用一个值].

## Decision

新增一张控制台卡片[思考强度覆盖](设置页 → 上游与工具), 数据形态是
`reasoningOverride: { enabled: boolean, models: [{ model: string, effort: string }] }`,
默认 `{ enabled: false, models: [] }`.

判定真源只有一处: `src/proxy/reasoning-effort.ts` 的 `resolveForcedEffort`. 
它按目录 key 归一模型标识(`catalog.keyForName`, 不另写映射), 命中时返回档位:

- 开关关闭 / 表为空 -> 不覆盖(零行为变化). 
- 命中行的 `efforts` 已声明且不含该档位 -> 记一条 warn 并**跳过**(有正面证据说明
 该模型不支持该档位时, 宁可不动也不发一个必被拒的值). 
- 未声明 `efforts`(目录里就没有这一项) -> 照配置发, 判定权留给上游. 

两个落点, @同一函数:

| 通道 | 落点 | 出站形态 |
|---|---|---|
| official(有效) | `transport/official/index.ts` 的 rpcArgs.reasoningEffort | `codebuff_metadata.freebuff_reasoning_effort` |
| legacy(已废弃, 仅兜底) | `transport/forward-body.ts` 的 applyForcedEffort | 顶层只留一个 `reasoning: { effort }` |

实时性走 `SettingsStore` 的实时字段通道(LIVE_FIELDS + settings.json), 与
`upstreamChannel` / `officialToolNames` 同一条路: 请求时读 `settingsStore.get()`,
不重启.

前端卡片 `dashboard/views/proxy/inject/effort.ts`: 开关 + 逐模型档位芯片, 芯片选项
来自 `/api/settings` 新增的 `reasoningModels`(目录行 -> key / name / efforts /
defaultEffort, 只读本地缓存, 不发上游请求). 点芯片即存, 再点一次取消该模型的覆盖. 

## Consequences

- 默认路径逐字节不变: 未配置时 `resolveForcedEffort` 返回 null, official 侧
 `reasoningEffort: null`(副仓库据此不发该 metadata 键), legacy 侧不动 body. 
- 开启后下游的 `reasoning_effort` 被完全忽略 ----
 `applyForcedEffort` 先删顶层再写 `reasoning.effort`, 与
 `normalizeReasoningFields` 的[只许一个思考字段]约束一致. 
- `settings-store.ts` 因新增字段越过 300 行硬红线, [盘值读回]整段搬进
  `settings-fields.ts`(`applyStoredSettings`), 设置形态 `SettingsShape` 随之成为
  该模块的导出; 两文件的职责边界不变: 字段声明与读回判据在一处, 装载流程在另一处.
- `/api/settings` 新增两个回显字段(`reasoningOverride` / `reasoningModels`),
 POST 侧由 `isReasoningOverrideShape` 校验; 非法档位直接 400, 不静默纠正. 
- 档位枚举是官方 `REASONING_EFFORTS`(minimal/low/medium/high/xhigh/max/ultra);
 逐模型可选集合来自目录的 `efforts`, 未声明时不列出芯片. 
- 目录未探测时卡片给出明确提示(去[模型]区点[同步上游模型]), 不自动打上游. 

## Alternatives considered

- **什么都不做(继续不发送)**: 最省事, 但用户要的正是[控制出站思考深度]这个能力,
 而且官方抓包证明官方客户端会发 `freebuff_reasoning_effort`("max"), 不发本身就是
 形态差异. 否决.
- **一个全局档位(所有模型同一个值)**: 实现最简, 但用户明确否决了这种口径 ----
 各模型的 `efforts` 声明不同(Gemini 3.8 Flash 只有 high, 有的模型五档),
 统一值会造出发不出去的组合. 否决.
- **做成可调项(config.yaml, 重启生效)**: 与[一切配置走前端页面, 实时生效]的约定
 相悖, 且它改的是每个请求的出站形态, 重启才能生效很难用. 否决.
- **在 bun 侧判定与解析**: 主服务算好再传[结果]是本仓既有分工
 (officialToolNames / systemPrompt 同一模式), 两份分类表必然漂移. 否决.
- **命中不支持档位时静默改用 defaultEffort**: 会把[用户配了但没生效]伪装成[生效了].
 否决, 改为跳过 + warn, 前端也只列模型真正支持的档位.
