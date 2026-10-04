# Agent Note: 建会话走 GET + cli claim(官方 CLI 从不用 POST /admission)

Status: implemented

## Problem

我们一直用 `POST /api/v1/freebuff/session/admission` 建会话.真机抓包官方 CLI
(0.2.6)后确认:**它从不打这个端点**.

```
=== METHODS ON SESSION ENDPOINTS（官方 CLI 全程）===
 18 GET  /api/v1/freebuff/session
  1 DELETE /api/v1/freebuff/session/attempt
admission ever used? NO
```

同一次抓包还暴露出一个更严重的误判(本次一并修正):**`status: "active"` 被我们
当成了封锁**.官方在完全相同的出口条件下拿到的回执是:

```json
{ "status": "active", "accessTier": "limited",
  "instanceId": "cli:23d5c416-c049-47db-8f64-89799e384ba1",
  "model": "m-00032eaeec",
  "countryCode": "JP",
  "countryBlockReason": "country_not_allowed",
  "verificationReason": "region_locked" }
```

即 `countryBlockReason` 是**说明性字段**(解释为什么模型集变小),**不是拒绝
信号**.而我们此前见到它就归一成 `country_blocked` 并抛错 —— 明明拿到了可用
会话,却主动把账号判死.

## Decision

**两处修正:**

1. 建会话先走官方路径 `GET /api/v1/freebuff/session`(带自生成的 `cli:` claim
   与 `x-freebuff-multi-session: 1`).GET 未给出可用会话(`status: none`)或
   失败时才回落 `POST /admission`;
2. `status: "active"` **优先**:active 回执一律采纳,不再看 `countryBlockReason`.
   只有**没有 instanceId 的**终态封锁才抛错.

### GET 建会话不带 x-freebuff-model

官方 GET 请求的头里**没有** `x-freebuff-model` —— 模型由服务端在回执里给出,
而且是个**不透明句柄**(`m-00032eaeec`),不是我们传的 `deepseek/deepseek-v4-flash`.
这说明 model 字段在 GET 路径上是**输出**而非输入.测试已断言 GET 不带该头.

## Alternatives considered

- **继续只用 POST /admission** —— 改前现状,也是我们几轮都被 503/409 拒的路径.
  官方不用它,继续用等于持续走一条"官方客户端从不出现"的路径.
- **完全删掉 POST 兜底** —— 更贴合官方,但老部署若只认 admission 就没路可走.
  官方自己把 404/405 当作[端点不支持],保留兜底不会降低保真度,只增加可用性.
- **保留 countryBlockReason → 封锁的归一** —— 这是上一版的做法.金标准直接证伪:
  官方在同样的字段下拿到的是 active.保留它只会把可用账号判死.

## Consequences

- 建会话路径与官方 CLI 一致(GET + cli claim).
- `countryBlockReason` 不再导致误判;账号不会因为"出口被判受限"被错误标死.
- GET 失败时仍有 POST 兜底,不会因为对齐而丢掉可用性.

## Evidence

- 官方 CLI 0.2.6 用我们的凭证**真实完成一次对话**(`reply with exactly OK` → `OK`,
  界面显示 `1h left`),mitmproxy 抓到全程报文.
- 同账号同 IP:官方 GET 建会话拿到 `status: "active"`(见上),我们此前 POST 被拒.
- `npm test` 全绿:新增[必须走 GET + cli claim][GET 不带 x-freebuff-model]
  [active + terminal reason 仍可用]三组断言.
-  **端到端仍未通**:本次修正后尚未用真实账号验证(今日 Freebucks 已用尽,
  16:00 UTC 重置).按纪律,下一次验证一次一请求,失败即停.
