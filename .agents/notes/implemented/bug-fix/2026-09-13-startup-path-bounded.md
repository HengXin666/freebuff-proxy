# Agent Note: 启动路径上的一切等待都是有界的（sessions.json 清孤儿不再卡住启动）

Status: implemented

## Problem

容器"起不来"的一个真实形态是**启动被上游会话扫尾卡住**：`sessions.json` 里每次
重启都会累积若干待清理的上游会话句柄，启动时逐条发 DELETE。上游不可达时
（代理挂死 / DNS 黑洞 / 句柄所属账号已被删除），每一次 DELETE 都要等满
`session.admitTimeoutMs`（默认 30s），挂起（`freebucksRefundPending`）还会重放两轮。

实测（v1.13.0 镜像，2 条遗留句柄 + 一个连不上的代理）：从容器启动到 `healthz`
可达用了 **33 秒**。句柄更多、上游是黑洞时代价随条数线性增长——十几分钟不进监听
状态完全可能。

用户看到的是"服务起不来"，而**删掉 `sessions.json` 立刻就好**（没有遗留句柄就没有
扫尾）。于是这个文件被当成故障源删掉——而那些句柄是重启后**唯一**还能寻址 DELETE
的东西，删了它们，对应账号的上游会话槽位只能等会话自然过期才回来。

同一段启动代码里，`sessions.json` 的**脏条目**（`null` / `{}` / 字符串）还有第二个
隐患：它只静默跳过、不进审计表，控制台显示"全部正常"，而这正是"自检说没事、行为却
不对"的老毛病（与 `web-sessions.json` / `users.json` 同类）。

## Decision

**上游相关的启动工作全部移出监听的临界路径**，并且扫尾本身**有界**：

- `bin/serve.js` 里的 `startUpstreamWarmup()` **只在 `startServer()` 返回之后调用**
  （不 await）：会话句柄扫尾与 `/api/v1/me` 身份自检都变成"监听之后再异步做"。
  顺序是硬约束——上游可达与否**不允许**决定服务起不起来。
  实测（真实数据 + 黑洞上游）：改前 27s（v1.13.4）/ 54s（v1.13.3）才监听，
  改后**223ms** 端口就绪。

扫尾与脏条目的其余机制：

- `SessionHandleStore.cleanupOrphans(resolveUpstream, { budgetMs })` 有总预算
  （`STARTUP_SWEEP_BUDGET_MS = 15_000`）与单次上限（`DELETE_ATTEMPT_TIMEOUT_MS = 8_000`）；
  每次尝试用 `Promise.race` 加一道本地硬超时，**不依赖上游客户端一定 abort**。
  预算用尽时剩余句柄计入 `deferred` 并原样留在索引里，下次启动继续。
- `freebuffSession(method, { timeoutMs })` 接受调用方给的单次超时（不传仍是
  `admitTimeoutMs`），扫尾据此把每次等待压进剩余预算。
- 挂起重放在启动路径上只做 1 次，且同样吃预算。
- `sessions.json` 的脏条目走和 web-sessions 相同的路：合法句柄进 orphans，坏条目
  `dumpDroppedEntries` 留证 + `noteDroppedEntries` 记账（控制台显示「脏条目」，
  **不**报成文件损坏）。
- 新增 `noteOpenHandles`，把"还有几条句柄待结算"登记进数据文件审计；
  `/api/system/data-status` 返回 `openHandles`，控制台在「系统」页显示「待结算 ×N」。
  这是**状态**不是错误：每条都占着上游会话槽位，清没清干净应该一眼看得见。

## Alternatives considered

- **什么都不做，继续让它扫完** — 最省事，而且"清得干净"本身是好事。但它把一个
  **非关键路径**（回收旧槽位）放在了**关键路径**（服务开始监听）前面：用户用不上
  服务，只为回收几条可能早已过期的句柄。v1.13.0 镜像实测 33s 起不来就是它。
- **删掉扫尾 / 只在真正空闲时扫** — 更快，但句柄就再也没人去 DELETE，等于把
  "删 sessions.json" 的后果内建进产品。丢的是槽位这份实打实的资源。
- **只缩短 `admitTimeoutMs`** — admit 本身就慢是上游正常行为，用一个全局参数治
  一条局部路径，副作用更大。给单次 DELETE 加超时才是对症的。
- **把超时做成可配置项** — 违反"一切配置走前端、别让用户改文件"的既有约定；
  15s / 8s 是工程常量。

## Consequences

- 上游不可达时启动最多等约 15s 就能进监听状态（有界、可预期）；代价是这次没轮到的
  句柄要等下一次启动，若服务长期不重启它们会一直留着（每条都占着槽位）。
- 更坏的上游（假死连接，undici 永不 settle）也拖不住启动：硬超时是本地实现的。
- `sessions.json` 的脏条目不再静默：控制台显示条数并留下 `.dropped-<时间>` 原文。
- 新增一个语义：sessions.json 可以是 "ok 但有 N 条待结算"，UI 必须按状态而不是按
  错误渲染它。

## Testing

- `test/smoke.mjs` (DATA-ENTRIES ⑥)：脏句柄只降级不抛、合法句柄保留、丢弃条数与
  留证进审计、`openHandles` 登记正确、文件仍算 ok。
- `test/smoke.mjs` (7)：用**永不 settle** 的假上游 + `budgetMs: 300`，断言扫尾在预算内
  返回、`cleaned === 0`、句柄一条不少。
- `npm run pipeline:image`：13 个场景（含"损坏 sessions.json 仍降级启动"）全过，且每个
  场景容器内真实登录后 8 个鉴权接口全部 200。
