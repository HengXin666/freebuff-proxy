# cli-bridge/AGENTS.md -- bun 侧(官方通道)

> 只讲[动 cli-bridge/ 时才知道的事]. 通用约定见根 [AGENTS.md](../AGENTS.md).

## 它是什么
官方通道 = **bun 侧执行上游调用**, Node 侧通过 RPC 委托. 需要 bun 运行时与官方客户端的
请求形态(设备签名 / catalog 协议头 / 流式协议). 启动方式见 `bin/`.

## 铁律: 不要在这里[逐项挑字段]
Node 侧算好的能力(注入名单 / 系统提示词处置 / 分层 / 思考强度)**必须逐项透传**到 `chat()`.
实测缺陷: `actions.ts` 的 `actReuse` 只挑 6 个字段, `session.ts` 的 `reuseChat` 只挑 7 个,
导致主服务配好的 `officialToolNames` / `systemPrompt` / `layer` / `reasoningEffort` **全被吃掉**,
症状是[控制台改了不生效]. 现在两处都展开透传, `config-passthrough` 套件钉死两层.

## 两张表必须逐条一致(成对契约)
| Node 侧 | bun 侧 |
|---|---|
| `src/upstream/signals/tool-name-map.ts` | `cli-bridge/lib/tool-map.ts` |

改一处**必须同时改另一处**, 断言在 `test/suites/entries/verify/tool/name-mapping.ts`.

## 类型检查覆盖不到(要格外小心)
`cli-bridge/` **不在 tsconfig 的 include 里** ---- tsc 看不见[少传一个可选参数]这类错误.
上面那个真缺陷之所以能过全部门禁, 就是因为它. 改这里请**手写断言**(见 `config-passthrough`).

## 目录
| 路径 | 职责 |
|---|---|
| `lib/upstream/actions.ts` | RPC action 表(chat / reuse / admit / streak / ...) |
| `lib/upstream/bridge.ts` | Bridge 对象, 组装各 endpoint |
| `lib/endpoints/` | 各上游端点的实际实现(chat / session / reads / catalog) |
| `lib/tool-map.ts` | 工具名映射表(与 Node 侧成对) |
