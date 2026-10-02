# Agent Note: 日志带账号与请求 id（AsyncLocalStorage 上下文）

Status: implemented

## Problem

此前每条日志只有 `ts / level / msg / fields`，**看不出是哪个账号的哪一次请求**。

多账号池并发时，选号、会话准入、上游请求、冷却换号各阶段的日志**完全交织**，
用户只能看到一堆 503 / 冷却记录，却无法回答最基本的两个问题：
- 这条日志属于**哪个账号**？
- 它和那几条是**同一次请求**？

控制台「日志」页也因此只是"倒序铺开"，没有聚合。

## Decision

**用 `AsyncLocalStorage` 透传日志上下文，logger 自动注入。**

- 请求入口（`server.js handle`）生成 `reqId`（UUID 前 8 位），
  `runWithLogContext({ reqId }, ...)` 包住整个处理流程。
- 账号选定后（`proxy.js` 的选号循环里 `lastKey = rt.key` 处）
  `patchLogContext({ account, model })` 补上账号。
- `log()` 输出时把 `reqId / account / model` 放在**最前面**
  （读日志时一眼看到"谁的哪次请求"）。
- 前端日志行渲染 `account` 与 `#reqId` 两个 chip；点 reqId 即筛选该请求全链路。
- `/api/logs` 新增 `reqId` / `account` 过滤参数。

**及时清理**：缓冲容量可配（`config.log.ringCap`，默认 500，0 = 不缓冲），
超限丢最旧的；补 `clearRing()` 主动释放。

## Alternatives considered

- **在每个调用点手工传 account 字段** —— 要改几十处调用点，
  且漏一处就又出现无主日志。**否决**：上下文透传是唯一不遗漏的做法。
- **只在入口记一条"开始请求"、靠时间推断归属** —— 并发时时间重叠，
  推断不可靠。**否决**。
- **用全局单例存当前账号** —— 并发请求互相覆盖，直接错乱。**否决**：
  AsyncLocalStorage 正是为解决"异步上下文"而生。
- **无限缓冲** —— 长期运行会被日志吃光内存。**否决**：有界是硬要求
  （原实现已是环形缓冲，本改动保留并让它可配）。

## Consequences

- 每条日志自动带 `reqId` + `account`（有账号时），无需改调用点。
- 控制台可按请求聚合查看，或只看某个账号。
- 无 `AsyncLocalStorage` 的环境（极老 Node）自动降级为无上下文，不报错。
- `npm test`（smoke ok）与 `npm run typecheck` 全绿。

## Evidence

实测一次请求（`POST /v1/chat/completions`）的日志：

```
info | req= abfc6264 | acct= llh282000500@gmail.c | admitting freebuff session
info | req= abfc6264 | acct= llh282000500@gmail.c | device signature generated
info | req= abfc6264 | acct= llh282000500@gmail.c | account cooling down; will try others
```

同一 `reqId` 的多条日志可聚成一组，且明确指向具体账号。
