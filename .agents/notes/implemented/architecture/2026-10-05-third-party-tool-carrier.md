# Agent Note: 第三方工具改走官方 MCP 载体形态, 不再按名字丢弃或原样硬塞

Status: implemented

## Problem

下游客户端(dsh 等)声明的工具名与上游官方 37 工具集交集很小, 表现为两类故障:

1. **静默消失**: 早期策略是"映射不到的丢弃"(cli-bridge 注释里的原话),
   于是 dsh 的 44 个工具里 30 个(68%)根本没发给模型 ---- 用户以为声明了能调.
2. **原样硬塞回 503**: 改为"原样保留"之后, 实测同一会话同一模型逐项改工具集:

   | 组 | 工具集 | 结果 |
   |---|---|---|
   | ① | 无工具 | 200 |
   | ② | 1 个官方工具 | 200 |
   | ③ | 1 个非官方工具 | 200 |
   | B | 18 个第三方工具 | 503 `The model is temporarily unavailable` |

   保留名字解决了"消失", 但没有解决"上游怎么看这一堆陌生名字".

## Decision

按官方本来就支持的形态承载: **客户端自定义工具在官方 wire 上就是展开进
`tools` 的 MCP 形态工具**, 名字规则是 `server__tool`.

三处真值(2026-10-05 从官方 orchestrator.js 与抓包核对):

- `customToolDefinitionsSchema`(109672)里的 `mcpOrigin: { server, tool }`
  就是官方给客户端自定义工具留的登记位; 该字段属于**本地 session 状态**
  (`fileContext.customToolDefinitions`), **不出现在 chat wire body 上**.
- wire 上自定义工具经 `getToolSet`(114196)经 `additionalToolDefinitions()`
  直接并入 toolSet, 再由 `prepareTools2`(126604)转成
  `{type:'function', function:{name, description, parameters}}`.
- 抓包 `docs/reverse/captures/2026-10-03-official-client.jsonl` 8 条 chat 请求体
  顶层键恒为 `model/codebuff_metadata/provider/messages/tools/tool_choice/stream`,
  `customToolDefinitions` **一次都没出现**; 官方 worker 层是 37 工具, manager 层
  是 `['decide']`.
- 名字规则取自 `mcpExposedToolName`(105346): `server + "__" + tool`, 非法字符换
  下划线, 仍不合法则截 55 字符并追加 sha256 前 8 位.

据此本代理的承载规则:

```
下游工具
  ├─ 官方工具集里有等价物  -> 走既有下行改名(bash -> run_terminal_command 等)
  ├─ Hermes delegate_task -> 走既有窄通道双向别名(tool-alias), 由本通道让开
  └─ 其余(记忆 / 知识库 / 自定义脚本) -> 包成 proxy__<原名>, 原名进映射表
```

映射表是**请求作用域**的(`ToolCarrierPlan`): 下行打包时建立, 随请求传到
`forwardCompletions`, 回程按同一张表把 `proxy__<原名>` 拆回下游原名. 拆包覆盖
`message.tool_calls` / `delta.tool_calls` / `function_call` 三种承载.

## Alternatives considered

- **什么都不做 / 复用现有两处改名**(`tool-map.ts` 的 MAP_TOOLS 与
  `tool-alias.ts` 的 Hermes 别名): 它们只处理"有官方等价物"与"一个特例名字",
  对无等价物的工具只能丢弃或原样硬塞 ---- 正是本 note 要解决的两个症状.
  最诚实, 但等于把 18 个陌生名字的 503 留在原地.
- **把下游工具塞进 `customToolDefinitions` 字段发上游**: 看起来最贴合用户给的
  协议线索, 但实测穷举后该字段**不在 chat wire body 上**(见上, 8/8 抓包无此键).
  照此实现等于发一个上游从不读的字段, 工具照样消失, 而且引入一个假契约.
- **丢弃无等价物的工具**: 已被实测证伪(声明 8 个官方完全不存在的工具名,
  出站 45 个, 上游回 200 ---- 上游并不因名字官方没有而拒绝); 且会让下游 68%
  的工具静默消失.
- **改名成看起来像官方名**(如把 memory_save 改成 read_files): 语义被篡改,
  模型会按官方语义调用, 下游拿到一个自己没声明过的名字, 无法派发.

## Consequences

- 下游工具名在 wire 上是 `proxy__<原名>`; 回程已拆回原名, 下游按自己的名字派发,
  行为与"直连官方且官方支持自定义工具"一致.
- 无官方等价物的工具由**客户端**执行(本代理不执行工具), 与既有分工一致.
- 开关 `toolCarrierEnabled`(控制台[第三方工具承载], 默认开)可一键关掉,
  退回"原样发出"用于对照排障.
- 只在客户端真的声明了工具时才写 `tools` 键: 无工具时写空数组会让上游与本地
  判据都按"带了工具"判(实测无工具请求凭空变成 404).
- 保留名字的映射表是请求内的, 不落盘, 不跨请求复用 ---- 并发请求之间不串.
