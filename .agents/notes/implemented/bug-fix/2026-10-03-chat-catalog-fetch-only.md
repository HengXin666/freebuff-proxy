# Agent Note: chat 只带 `x-freebuff-catalog-fetch`，不带 `-protocol`

Status: implemented

## Problem

主项目 chat 请求**多发** `x-freebuff-catalog-protocol`。

官方 chat 头部恒为 8 项（2026-10-03 抓包，8 个样本逐个校验 diff 为空集）：

```
Authorization / Content-Type / 三段 UA /
x-freebuff-acting-user-id / x-freebuff-catalog-fetch /
x-freebuff-device-key / x-freebuff-device-sig / x-freebuff-device-ts
```

**没有** `x-freebuff-catalog-protocol`。它只出现在 catalog 抓取与 admission 上。

根因是装配位置：`src/upstream/client.js` 的 `apiFetch()` 内部会
best-effort 地 `Object.assign(headers, catalog.headers())`，而
`catalog.headers()` 一次返回**两个**头（protocol + fetch）。
chat 走 `raw() → apiFetch()`，于是被连带加上了 protocol。

顺带修正一个此前误判：我一度认为主项目 chat「缺 catalog 头与设备签名」——
**是错的**。它们由 `apiFetch` 内部注入，proxy.js 那一层看不到而已。
真正的问题恰好相反：不是缺，是多。

## Decision

**`CatalogHolder` 新增 `fetchOnlyHeaders()`（只给 fetch），
`apiFetch` 支持 `init.catalogFetchOnly`，chat 走该分支。**

- `fetchOnlyHeaders()` 与 `headers()` 并存：非 chat 端点继续用完整的两个头。
- `raw()` 透传 `catalogFetchOnly`，`proxy.js` 的 chat 调用显式置 `true`。
- 不改 `apiFetch` 的默认行为 —— 除 chat 外一切照旧。

## Alternatives considered

- **在 proxy.js 组装 headers 时删掉 protocol** —— 最直观，但**无效**：
  catalog 头是在 `apiFetch` 内部、`raw()` 之后注入的，
  调用方先删也会被后加覆盖。
- **让 `catalog.headers()` 少返回一个头** —— 会影响 catalog 抓取与
  admission，那两处**确实需要** protocol（没有它服务端不认目录客户端）。
  一刀切会破坏已验证的链路。
- **什么都不做（多带无害）** —— 与"删 instance-id"那次的取舍一致地否决：
  官方头部是**恒定集合**，多发就是指纹面；且该仓库已有判据把
  "多余的指纹面"列为第三方客户端信号。

## Consequences

- chat 头部收敛到官方 8 项（前提：设备签名与 catalog 可用）。
- catalog 抓取、admission、session 等端点行为完全不变。
- `npm test`（smoke ok）与 `npm run typecheck` 全绿。

## Evidence

- `docs/reverse/15-protocol-review.md` P0-1：官方 chat 8 样本头部 diff 空集。
- `docs/reverse/captures/2026-10-03-official-client.jsonl`：
  chat 请求头部逐项列出，无 catalog-protocol。
- 代码核对：`client.js` `apiFetch` 第 360 行 `Object.assign(headers, catalog.headers())`。
