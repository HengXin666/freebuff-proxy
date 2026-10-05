# Agent Note: 并行工作流的写范围裁决（src/server.ts 归谁拆）

Status: implemented

## Problem

五个并行 doer 的写范围是互斥的，但 `src/server.ts`（147 行）落在五个人的范围
之外：

| 工作流 | 独占写范围 |
|---|---|
| WS-A 后端核心 | `src/proxy.ts`, `src/app-context.ts`, `src/session-manager.ts`, `src/session-handles.ts`, `src/free-mode.ts`, `src/tool-alias.ts`, `src/account-state-store.ts` |
| WS-B 平台层 | `src/upstream/**`, `src/config.ts`, `src/model.ts`, `src/catalog-models.ts`, `src/auth-store.ts`, `src/util/**`, `bin/**`, `cli-bridge/**`, `scripts/**`（除 `scripts/gates/**`） |
| WS-C 前端 | `dashboard/**`, `src/web/static.ts` |
| WS-D 控制面 | `src/web/**`（除 `static.js`）, `test/**` |
| WS-E 文档 | `docs/**`, `README.md` |

不裁决的后果：没人碰它，而它恰恰是**扩展性的瓶颈** —— `src/` 顶层有 12 个文件，
而 `src/` 直接挂的文件数卡在 5 的红线上；拆子目录的第一步就是先明确顶层还剩谁。

## Decision

**Lead 自己拆 `src/server.ts`**，因为它同时是四个模块的装配点
（`createProxyHandler` / `createWebApi` / `serveStatic` / `startServer` 的调用方），
任何 doer 单独改它都会与另外三条工作流的接口变动冲突。

拆分形状：

- `src/server/request-context.ts` —— 请求级日志上下文（reqId 分配）
- `src/server/route-table.ts` —— 路径到处理器的分流表（`/healthz` `/v1/*` `/api/*` 静态）
- `src/server/startup-tasks.ts` —— 启动期副作用（catalog 缓存 seed；自动同步刻意停用）
- `src/server.ts` —— 薄装配层，保留 `startServer` 导出名

`src/` 顶层的进一步收缩（`src/context/` 收 `app-context.js`、`src/model/` 收
`model.js` 等）由**各文件的所有者自行完成**，不由 Lead 代拆。

## Alternatives considered

- **什么都不做 / 让 WS-A 顺手拆**：最强的理由是"它是后端，WS-A 离得最近"。
  否决原因：`src/server.ts` 的每一行都在调用别人正在改的接口（`deps` 里 8 个依赖
  全是别的 doer 的模块）。让 WS-A 拆，等于让它去读四份正在变动的接口，
  每次别人改一处它就红一次 —— 那是把并行变成串行。
- **让 WS-D 拆**（因为 `createWebApi` 的接线在里面）：否决原因同上，
  而且 WS-D 的 `src/web/**` 已经是最大的拆分面（8 文件到子目录）。
- **挂一个共享任务等有空的人做**：否决原因：`src/` 的目录红线上限是 5，
  顶层 12 个文件。这是**所有 doer 的公共阻塞点**，交给"有空的人"等于交给没人。
- **先不拆，等 doer 们做完再统一收**：最强的理由是"减少并行冲突"。否决原因：
  那时 `src/` 顶层仍会是 12 个文件，且 `src/proxy/`、`src/upstream/client/` 等新
  子目录已经建好 —— 顶层数量不降反升，红线只能在最后一刻靠大改一把过。

## Consequences

- Lead 只碰 `src/server.ts` 与它拆出的 `src/server/**`；doer 们的接口变动只需保证
  `startServer(deps)` 的入参形状不变，装配层无需跟着改。
- `src/server/**` 目录内文件数不超过 5，函数不超过 80 行，同样受六条红线约束。
