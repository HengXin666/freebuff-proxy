# 20 — 上游端点白名单:只有客户端真实发过的才准用

> 2026-10-03.起因:用户指出[所有对上游的请求,全部扒出来,看看哪些是我们
> 没有从客户端对齐过的 —— 这些请求全部都不能用.必须从客户端对齐过的请求,
> 我们才可以使用.之前的所有请求全部作废.]

---

>  **完整对照表(用途 / 顺序 / 每个端点的头集)见 `21-client-request-reference.md`.
> 本文件只讲"哪些端点准用,哪些作废",21 是对照专用真源.

## 20.1 客户端真实端点全集(两次抓包 165 条合并)

| # | Method | Path | 次数 | 是否必需 |
|---|---|---|---|---|
| 1 | GET | `/api/v1/freebuff/models` | 1 |  模型清单(**唯一权威**) |
| 2 | POST | `/api/v1/freebuff/device-keys` | 1 |  设备密钥注册(签名前置) |
| 3 | GET | `/api/v1/freebuff/session` | 17 |  会话状态/额度(只读) |
| 4 | POST | `/api/v1/freebuff/session/admission` | 3 |  建会话(买断一小时) |
| 5 | DELETE | `/api/v1/freebuff/session` | 2 |  释放会话 |
| 6 | POST | `/api/v1/agent-runs` | 6 |  START/FINISH(desktop 世代) |
| 7 | POST | `/api/v1/chat/completions` | 8 |  真正的对话(唯一 chat 端点) |
| 8 | GET | `/api/v1/ads/policy` | 1 |  广告,可免 |
| 9 | GET | `/api/v1/ads/proposal` | 5 |  广告,可免 |
| 10 | POST | `/api/v1/ads` | 1 |  广告,可免 |
| 11 | POST | `/api/v1/ads/impression` | 9 |  广告,可免(含 7×404) |
| 12 | POST | `/api/ads` | 2 |  广告,可免 |
| 13 | POST | `/api/logs` | 7 |  遥测,可免 |
| 14 | GET | `/api/v1/project-profile` | 1 |  项目画像,可免 |
| 15 | HEAD | `/` | 18 |  连通性探测,可免 |

## 20.2  仓库里**客户端从未发过**的请求 —— 全部作废

| 仓库在用 | 客户端 | 处置 |
|---|---|---|
| `GET /api/v1/me` | **0 次** |  **删除**(启动探测,身份校验一律去掉) |
| `POST /api/chat/stream` | **0 次**(web 世代残留) |  **删除**,只保留 `/api/v1/chat/completions` |
| `GET /api/v1/project-profile` | 1 次(客户端有,但非必需) |  可选,默认不发 |
| 各种 `/api/v1/ads/*`,`/api/logs` | — |  一律不发 |

**最严重的是 `/api/v1/me`**:客户端**一次都没发过**,而我们每次启动,
每次账号校验都发.这是"我们比客户端多出来的流量",正是被判第三方的信号源.

## 20.3 铁律:零自动探测

用户裁决:**只有用户主动刷新时才准探测上游.**

```
 服务启动           → 不许发任何上游请求
 导入账号           → 不许自动探测
 /v1/models 首访    → 不许顺带补一次 session GET
 /api/models        → 同上
 控制台「一键刷新」  → 允许
 单账号「检测」按钮  → 允许
 真正要发 chat      → 允许（admission/agent-runs/chat）
```

**缓存是第一数据源**:`data/catalog-cache.json`(目录),
账号快照里的 `quota` / `freebucks`.拿不到就显示"尚未探测",
**绝不因为没数据就自动补一发**.

## 20.4 授权方式也要换

客户端用的是 `Authorization: Bearer <token>`,**全 165 条抓包里
`x-codebuff-api-key` 出现 0 次**.仓库在 session / agent-runs /
chat 上多发这个头 —— 属于"客户端没有的特征",一并删掉.

## 20.5 每个端点的头集(逐项对齐抓包)

| 端点 | 业务头(除 `Authorization` 外) |
|---|---|
| `GET /models` | `x-freebuff-catalog-protocol: 1`,`x-freebuff-client: desktop` |
| `POST /device-keys` | `Content-Type: application/json`(body 只有 publicKey + client) |
| `GET /session` | `x-fb-timezone`,`x-freebuff-catalog-fetch`,`-catalog-protocol: 1`,`-client: desktop`,设备签名三头,`-first-tab-discount: 0`,`-include-unused-rate-limits: 1`,`-install-id`,`-multi-session: 1`,可选 `-instance-id` |
| `POST /session/admission` | 上述全部 + `x-freebuff-model`(**handle**),`-wallet-spend-limit: 0`,`-desktop-attempt-id`,`-instance-id`,`-purchase-continuity: 1`,可选 `-takeover-instance-id` |
| `DELETE /session` | `-catalog-protocol: 1`,`-catalog-fetch`,`-instance-id`,`-multi-session: 1`,`-purchase-continuity: 1` + 签名三头 |
| `POST /agent-runs` | `authorization`,`content-type`,`acting-user-id`(**仅 3 个**) |
| `POST /chat/completions` | `authorization`,`content-type`,三段 UA,`acting-user-id`,`x-freebuff-catalog-fetch` + 签名三头(**共 8 个,无 catalog-protocol**) |

## 20.6 待办(本次实施)

1. 删 `/api/v1/me` 的全部调用(启动校验 / 账号校验).
2. 删 `x-codebuff-api-key` 的全部发送点.
3. 删 `/api/chat/stream`(web 世代残留).
4. 去掉 `/v1/models`,`/api/models`,`/api/models/upstream` 的自动探测,
   改为纯缓存;无缓存时返回空并带 `notProbed: true`,由前端提示[点刷新].
5. 启动路径不再发任何上游请求(含 catalog —— 首次用到才抓,且由用户动作触发).
6. 清理本地过期凭证文件.
