# Agent Note: admission 用目录句柄 + terminal 判据必须是 HTTP 403

Status: implemented

## Problem

两处修正，都来自**从零建会话**的真机抓包（2026-10-01：先开 mitmproxy、再启动
官方 CLI，抓到完整流程 109 条记录）。

### 1. terminal 判据写错了，把正常流程打断

我们此前见到回执里有 `countryBlockReason` 就判成 terminal 封锁并抛错。
但真机抓包证明：**正常的 GET /freebuff/session 回执本身就带这个字段** ——

```json
{ "status": "none",
  "countryBlockReason": "country_not_allowed",
  "prices": { "m-7e20df6765": 5, "m-00032eaeec": 10, ... }   ← 目录模式的价格表
}
```

官方拿到这份回执后**照样继续 POST admission 并建成会话**。也就是说这个字段是
**纯说明性**的（解释模型集为何变小），出现在成功路径上。

后果很严重：我们的 GET 一返回就被判死，**永远走不到 POST admission** ——
抓包里表现为"只有 GET、没有 POST"，而官方明明是 GET×3 → POST → active。

修正：**terminal 判据只看 HTTP 403**（官方 403 + `{status:"banned"|
"country_blocked"}` 才是真拒绝）。

### 2. admission 的 x-freebuff-model 必须是目录句柄

官方 POST /session/admission 的该头是 `fbm1.AAEAAUPe2Us...`（句柄），
我们传的是 `deepseek/deepseek-v4-flash`（模型名）。句柄是服务端签名的，
客户端造不出来，只能从目录取。

目录行数**随服务端版本变化**（实测同一账号两次抓取分别是 12 行与 52 行），
所以模型名未必在册 —— 加一条兜底：查不到时用目录的 `recommendedKey`
（服务端推荐，实测 `m-00032eaeec`，也正是官方会话回执里的那个 model）。

同时补齐官方 admission 还带的 `x-freebuff-desktop-attempt-id`
（= claim 去掉 `cli:` 前缀，对齐官方 `freebuffCliAttemptId()`）。

## Decision

- `client.js`：terminal 归一化加 `res.status === 403` 前置条件；
  admission 的 model 经 `catalog.handleFor()` 翻成句柄，缺册时回落
  `recommendedKey`；
- `official-fingerprint.js`：新增 `HEADER_DESKTOP_ATTEMPT_ID` 与
  `claimAttemptId()`，在非 GET 的 cli claim 请求上带该头；
- `session-manager.js`：恢复 POST admission 为主路径；`refresh()` 也带 cli
  claim（此前裸发，实测比官方少 5 个头）；
- `catalog-protocol.js`：`handleFor()` 支持 `m-xxx` → `fbm1.xxx` 映射。

## Alternatives considered

- **继续用模型名做 admission** —— 实测被拒；官方该字段是句柄。
- **只判 `countryBlockReason` 不看状态码** —— 这正是 bug 本身。
- **硬编码 `recommendedKey`** —— 它会随服务端目录版本变，只能作为兜底而非首选。

## Consequences

- 我们的 admission 请求头与官方**逐字一致**（实测 20 个头，含句柄与
  `desktop-attempt-id`）。
- 错误从 `country_not_allowed` 变为 `purchase_capacity` —— 这是**决定性的进步**：
  说明形态已对齐，只剩槽位竞争。

## Evidence

真机抓包（从零建会话）的完整流程：

```
GET  /freebuff/session  ×3    → 200 {"status":"none",...}
POST /session/admission      → 200 {"status":"active",
                                    "instanceId":"cli:b4e28cef-...",
                                    "model":"m-00032eaeec"}
POST /agent-runs → POST /chat/completions
```

修正后我们抓到的 admission 响应：

```json
{ "status": "purchase_capacity",
  "currentInstanceId": "cli:b4e28cef-827c-4584-a9b7-caf2d0062f09",
  "concurrency": "slot-bound", "slotLimit": 1,
  "nextExpiryAt": "2026-10-01T08:51:59.906Z" }
```

**槽位被官方 CLI 那条会话占着**（一个账号 `slotLimit: 1`），DELETE 返回 200 但
`desktopSessionCounts.premium` 仍为 1 —— 服务端不会因 DELETE 立即释放已购时长。
待 08:51:59 UTC 过期后即可验证。账号未被封、额度 15/25 未消耗。
