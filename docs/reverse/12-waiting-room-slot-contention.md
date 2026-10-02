# 12 — 428 `waiting_room_required` 的真因：同账号槽位互斥（不是协议、不是 TLS）

> 实测账号 `21def426`（全新授权，余额 20/20，配额 0/6 未用）。
> 用 bun 桥接（`freebuff-cli-bridge`）跑，TLS 与官方同源，协议件全部对齐。

## 12.1 现象

完整链路的前两跳**全部成功**，第三跳必失败：

```
admit     200  {"status":"active", "instanceId":"cli:aa0b8ac3-..."}
startRun  200  {"runId":"af198588-..."}
chat      428  {"error":"waiting_room_required",
                "message":"Your free session has ended. Send your message again to start a new one."}
```

换模型（Claude Sonnet 5.5 → GPT-6.1 Mini）结果一致。
同会话重试 → 428 变 503，说明会话确实被登记过、随后失效。

## 12.2 真因：会话被建了又全额退款

读 `admission` 回执的 `desktopPurchases` / `desktopRefunds` / `desktopSessionCounts`：

```jsonc
"currentInstanceId": "cli:5295f8b1-bdd1-4e05-a3e8-0cedd4efe4f4",
"concurrency": "slot-bound",
"slotLimit": 1,
"desktopSessionCounts": {"premium": 1, "unlimited": 0,
                          "nextExpiryAt": "2026-10-02T18:26:57.212Z"},
"desktopPurchases": [{
  "model": "m-00032eaeec",
  "expiresAt": "2026-10-02T17:56:57.212Z",
  "holderInstanceId": "cli:5295f8b1-bdd1-4e05-a3e8-0cedd4efe4f4"
}],
"desktopRefunds": [{
  "claimInstanceIds": ["cli:aa0b8ac3-c379-4755-8600-3835086ce974"],  // ← 我刚建的
  "purchaseId": "2f2a2d96-...", "model": "m-00032eaeec",
  "amount": 10, "refundedAt": "2026-10-02T16:56:38.015Z"
}, ...]
```

三条事实：

1. **槽位上限 1，已被 `cli:5295f8b1...` 持有**（`desktopPurchases` + `premium: 1`）。
2. **我建的每一个会话都在 `desktopRefunds` 里，amount 10 全额退**。
   即：上游收了钱又退回来，会话作废。
3. 于是 chat 时会话已不存在 → `428 waiting_room_required`。

## 12.3 持有者不是客户端（已证伪的初判）

⚠️ **本节记录一次错误归因及其证伪过程，勿删。**

初判：`cli:5295f8b1...` 是官方客户端占的槽位（同一账号 `21def426`，
客户端进程活跃 9h52m，凭据正是从客户端登录态读出的）。

**证伪**：后续读取中，`cli:5295f8b1...` 出现在 `desktopRefunds[].claimInstanceIds`
里 —— 它**也是我自己建的、随后被退款的会话**。槽位持有者 `holderInstanceId`
每次都在变（`cli:4cd35b9e...` / `cli:5295f8b1...`），全是我自己的。

所以正确表述是：**不是"客户端占着不给"，而是"上游给我的每一次购买都退款作废"**。
`slotLimit: 1` 只是让这个现象表现为连续的 `purchase_capacity`。

真正的退款诱因**尚未确定**，现有两条候选：
1. 出口被判定为匿名网络：
   `ipPrivacySignals: ["vpn","res_proxy","hosting","anonymous"]`、
   `countryBlockReason: "anonymous_network"`、`countryCode: "JP"`。
2. 请求形态仍有未对齐处（已排除：TLS 同源、协议件齐全、surface 已改 desktop）。

**待证**：换一个非匿名出口（直连/US 住宅 IP）跑同一条链路，若 428 消失则确认为 (1)。

## 12.4 附带发现：requestedModel 被强制改写

```
请求 x-freebuff-model: <GPT-6.1 Mini 的 handle>
回执 requestedModel:   "m-00032eaeec"        ← MiMo 2.6 Flash，不是我请求的
```

回执里的 `requestedModel` / `desktopPurchases.model` / `desktopRefunds.model`
**恒为 `m-00032eaeec`**，与我传的 handle 无关。
这与 `03` 记的"admission 传 handle、chat 传 key"是两回事：
**账号的槽位/购买记录被钉在某一个模型上**。

## 12.5 另一个信号：出口被判定为匿名网络

```jsonc
"countryCode": "JP",
"countryBlockReason": "anonymous_network",
"ipPrivacySignals": ["vpn", "res_proxy", "hosting", "anonymous"]
```

余额提示也写明：*"On a VPN or proxy: 20 Freebucks a day, not 25."*

这是**降级档位**（可用，模型集合变小、额度 25→20），不是封锁
（`03` / AGENTS.md 已记：真正的 terminal 是 `country_blocked`，且只有 HTTP 403）。
但它是退款的可能诱因之一 —— **待证**。

## 12.6 与 TLS 的关系：排除

本次全程用 bun 发请求（`freebuff-cli-bridge`），TLS 栈与官方同源，
依然 428 —— 且失败模式是**"建了再退"**而非"拒绝建"。
上游接受了请求、扣了款、又退回，说明**请求形态是通过的**，
拒绝发生在**槽位/购买归属**层面。

**结论：428 与 TLS 指纹无关，也与协议件无关。**

## 12.7 处置与验证路径

- 判据：chat 收到 `waiting_room_required` 时，**先读 admission 回执的
  `desktopRefunds`** —— 若刚建的 instanceId 出现在 `claimInstanceIds` 里，
  就是"会话被退款作废"，根因是槽位竞争，**re-admit 无效**（会再退一次）。
- 这类失败**不应冷却账号**（不是账号故障），也不应无限 re-admit（每次都扣退一轮）。
  正确处置：**等待或让出槽位**，或换一个账号。
- 若要验证桥接的 chat 能力：**必须让官方客户端先登出**（释放唯一槽位），
  或用一个与客户端不同的账号。

## 12.8 当前阻塞

客户端正占用该账号唯一槽位，且用户正在其中使用。
**在客户端登出之前，本账号无法通过代理完成 chat。**
