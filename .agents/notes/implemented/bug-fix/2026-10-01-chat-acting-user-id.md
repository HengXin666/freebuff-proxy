# Agent Note: chat 层补齐 x-freebuff-acting-user-id

Status: implemented

## Problem

真机抓包官方 chat 请求(`POST /api/v1/chat/completions`)只有 **13 个头**,
其中业务相关的 5 个是:

```
x-freebuff-acting-user-id: 75c53211-fce1-4cad-b90f-c0883fa59ba1
x-freebuff-catalog-fetch:   fbf1.AAE...
x-freebuff-device-key:      R8smUpEyPD3ogQ7_yt15Qb
x-freebuff-device-sig:      ...
x-freebuff-device-ts:       1790842466957
```

我们此前只带了签名三头(device-key/sig/ts 由 `apiFetch` 自动注入),
**`x-freebuff-acting-user-id` 一个都没有** —— `officialChatHeaders()` 支持
`opts.userId`,但 `proxy.js` 调用时没传.

## Decision

**把账号 user id 透传到 chat 头.**

关键细节:`accountId` 这个参数此前传的是 `accountKey`(凭据文件名,可能是邮箱),
而官方要的是**账号 user id**(`75c53211-fce1-4cad-b90f-c0883fa59ba1`).
改为 `user.id || accountKey`,并在 client 上暴露 `accountId` 供 proxy 取用.

(`accountId` 另有一个用途是代理池的稳定分配 —— 传 user id 同样成立,
只要同一账号稳定即可.)

## Alternatives considered

- **不传** —— 改前现状.官方 chat 明确带这个头,少一个就是少一层指纹.
- **传 accountKey(邮箱)** —— 语法上能被接受,但值与官方语义不符;
  官方该字段与 device-keys 注册作用域用的 user id 同源,应当一致.

## Consequences

- chat 的业务相关头与官方一致(签名三头 + acting-user-id + catalog-fetch).
- `accountId` 的语义统一为[账号 user id],代理池分配与指纹头共用.

## 补充:purchase_capacity 不冷却账号

实测该 409 状态的语义是**资源竞争**(一个账号 `slotLimit: 1`,付费槽位已被占),
回执给出 `currentInstanceId` / `nextExpiryAt` 指明何时空出.它不是账号故障 ——
冷却换号只会把别的账号也依次买断.已在 `shouldSwitchAccountOnError` 里让它
(连同 `premium_slot_taken` / `purchase_in_use`)返回 false,并把官方 409 全集
补进 `client.js` 的直通分支.

## Evidence

- 官方聊天抓包 13 头清单(见上).
- `npm test` 全绿,typecheck 通过.
-  端到端仍受**槽位竞争**阻塞:当前唯一障碍是 `purchase_capacity`
  (`slotLimit: 1`,被官方 CLI 那条会话占用,`nextExpiryAt` 08:51:59 UTC).
  账号未被封,额度 15/25 未消耗.
