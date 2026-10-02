# Agent Note: session 端点按官方抓包去掉 `x-codebuff-api-key`，并让 admission 的模型映射带 displayName 兜底

Status: implemented

## Problem

主服务的 admission 一直失败（`purchase_claim_released` / `admit_failed`），
而**副仓库（cli-bridge）同一账号同一时刻 admission 200 active**。两者必有一处
与官方不一致。逐端点核对抓包后定位到两个差异。

### 1. 多带了 `x-codebuff-api-key`

官方抓包（`docs/reverse/captures/2026-10-03-official-client.jsonl`）逐端点核对：

| 端点 | 官方是否带 `x-codebuff-api-key` |
|---|---|
| `GET /api/v1/freebuff/session` | ❌ |
| `POST /api/v1/freebuff/session/admission` | ❌ |
| `POST /api/v1/agent-runs` | ❌ |

官方只用 `Authorization: Bearer`。主服务 `freebuffSession()` 额外叠加了
`freebuffAuthHeaders(token)`（既有注释称"只带 Bearer 会 401"）。

### 2. admission 的 `x-freebuff-model` 映射不到

主服务 `/v1/models` 的 id 来自**静态快照**（从官方仓库同步的 60 项），
而目录是**实时**的（53 行）。两者会漂移：

- 快照里有 `deepseek/deepseek-v4.1-flash`
- 实时目录里该行（`m-096e75164d` / "DeepSeek V4.1 Flash"）的 legacyDigest
  对应的是 **`deepseek/deepseek-v4-flash`**

于是 `handleFor('deepseek/deepseek-v4.1-flash')` 不命中，日志
`requested model not present in this catalog`，模型名被原样发给服务端。

## Decision

1. **`freebuffSession()` 只带 `Authorization`**，不加 `x-codebuff-api-key`
   （按官方抓包；`apiFetch` 侧 `includeAuth: false` 已确保不会被加回）。
2. **`catalog.handleForModel(id, displayName)`**：legacy 摘要不命中时，
   用**完全一致的 displayName** 反查目录 key。不做模糊匹配、不用
   `recommendedKey` 兜底（后者已被证伪：会静默换模型）。
   `displayName` 由 client.js 从内置静态表按 id 查（session-manager 没有
   模型表的上下文）。

## Alternatives considered

- **保留 `x-codebuff-api-key`** —— 既有注释有"会 401"的观察。但官方抓包三个
  端点都不带，且副仓库不带时成功。**按证据优先于记忆**：以抓包为准，
  若后续实测确有 401 再回退并补证据记录。
- **用 recommendedKey 兜底映射** —— 会静默把请求换到"推荐"模型，
  会话绑错模型必然 503（实测踩过）。**明确否决**。
- **让前端/调用方传 displayName** —— session-manager 没有模型表上下文，
  逐层透传成本高且易漏。**否决**：在 client.js 就近查表。

## Consequences

- session 三个端点的头部与官方一致（只 Bearer）。
- admission 的模型映射在 id 漂移时仍能命中正确目录行。
- 排障能力：`FB_DEBUG_SESSION_HEADERS=1` 时打印 session 请求的完整头部与
  上游响应原文（默认关闭，不影响生产）。
- `npm test`（smoke ok）/ `npm run typecheck` / `docker compose config` 全绿。

## Evidence

- 官方抓包三端点均无 `x-codebuff-api-key`（脚本核对，非目测）。
- 副仓库 admission 回执：`status: active`、`desktopRefunds: []`。
- 主服务修复后日志：`requested model not present` 消失（说明映射命中），
  GET 与 POST admission 均成功发出。
- **尚未完成端到端自测**：验证时该账号的每日配额已被反复测试耗尽
  （`rate_limited` 冷却至次日 07:00 UTC），协议链路通但拿不到 200。
  需在配额重置后补测。

## 遗留

- 端到端自测（主服务 Node 侧 official 通道 200 + 工具调用）待配额重置后完成。
- 该改动的效果（去 api-key 头）尚未被端到端实测证实，仅有抓包依据与
  副仓库对照。
