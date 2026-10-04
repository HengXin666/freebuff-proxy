# 03 — 会话建立(admission):实测与坑位

源码:`orchestrator.js:207120-207200`(`postSessionAdmission` / `getSession`)

## 3.1 端点

```
GET    /api/v1/freebuff/session              # 查询 / 心跳
POST   /api/v1/freebuff/session/admission    # 建立（买断一小时）
DELETE /api/v1/freebuff/session              # 释放
DELETE /api/v1/freebuff/session/attempt      # 释放（带 attemptId 时）
```

## 3.2 admission 请求头(官方逐字清单)

```js
{
  Authorization: `Bearer ${auth}`,
  ...freebucksTimeZoneHeaders(),                       // 时区
  "x-freebuff-catalog-protocol": "1",
  "x-freebuff-catalog-fetch":    catalog.fetchId,
  "x-freebuff-client":           "desktop",
  "x-freebuff-install-id":       installId,
  "x-freebuff-model":            catalog.handleFor(model),   //  handle，不是 key
  "x-freebuff-wallet-spend-limit": "0",
  "x-freebuff-first-tab-discount": "0",
  "x-freebuff-instance-id":      instanceId,
  "x-freebuff-purchase-continuity": "1",
  "x-freebuff-multi-session":    "1",
  // + 设备签名三头（sessionFetch 里由 RequestIntegrity 注入）
}
```

## 3.3  关键坑:admission 用 handle,chat 用 key

实测(同一账号,同一 catalog):

| 位置 | 传 handle (`fbm1.xxx`) | 传 key (`m-xxx`) |
|---|---|---|
| `x-freebuff-model`(admission) | **200 active**  | 409 `freebuff_catalog_stale`  |
| chat 的 `model` 字段 | **通过模型校验**  | 409 `session_model_mismatch`  |

> 这是本次逆向最反直觉的一点:两个端点对"模型是什么"的表示法要求相反.
> 官方源码里 `modelHeader = catalog.handleFor(model)` —— admission 走 handle 映射.

## 3.4 错误码对照(实测)

| 状态 | error | 含义 | 处置 |
|---|---|---|---|
| 409 | `purchase_capacity` | 免费模式瞬时容量排队 | **可重试**:实测重试第 4 次即 200 active |
| 409 | `freebuff_catalog_stale` | model 表示法错 / fetchId 与目录不匹配 | 改传 handle;重新拉目录 |
| 403 | `banned` | 账号被封(第三方客户端) | 换号;见 §3.6 |
| 428 | `waiting_room_required` | 没有活跃会话就发 chat | 先 admission |
| 409 | `session_model_mismatch` | chat 的模型与会话绑定的不一致 | chat 改传 handle(或重开会话) |
| 503 | `The model is temporarily unavailable` | 上游模型侧暂时不可用 | 换模型 / 稍后重试 |

## 3.5 GET session 回执(本机实测,limited 档)

```jsonc
{
  "status": "none",                 // active 时才表示有活跃会话
  "accessTier": "limited",
  "freebucks": {
    "balance": 25,
    "daily": { "limit": 25, "spent": 0, "remaining": 25,
               "resetAt": "2026-10-02T16:00:00.000Z",
               "resetTimeZone": "Asia/Shanghai" },
    "wallet": { "balance": 0 },
    "planId": null,
    "prices": { "m-22ff70c712": 0, "m-916b95b337": 2, "m-00032eaeec": 10, ... },
    "planRequiredModelIds": [...],   // 需要付费计划
    "offPeak": { "m-096e75164d": { "startHourUtc": 22, "price": 10, "regularPrice": 15 } }
  },
  "subscription": { ... }
}
```

`prices` 是**每小时 Freebucks 单价**.0 价的模型(如 `m-22ff70c712`)不消耗额度.

## 3.6 `403 {"status":"banned"}` —— 本次任务起点

实测:用仓库凭据 `1e600b3a`(llh282000500@gmail.com)打 admission:
```
403 {"status":"banned","desktopSessionCounts":{...},"desktopPurchases":[],"desktopRefunds":[]}
```
而**同一时刻**用官方客户端登录态 `54393a42`(loli@woa.qzz.io)打:
```
200 {"status":"active","accessTier":"limited",...}
```

即:**ban 是账号级,且已发生**;不是请求形态问题.
(`extractAccountBanError` 归一 `account_suspended`/`banned`/`country_blocked` → `banned`.)

 因此"让仓库用这条链路"的**前提是仓库持有未被封的凭据**,
协议正确不能救一个已被封的账号.
