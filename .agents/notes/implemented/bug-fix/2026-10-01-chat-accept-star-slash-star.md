# Agent Note: chat 的 Accept 是 `*/*`，不跟第三方实现的 `text/event-stream`

Status: implemented

## Problem

官方 chat 的 `Accept` 与我们发的不一致：

```
官方（mitmproxy 抓 CLI 0.2.6，流式 chat ×2）: */*
我们（改前）:                                   application/json, text/event-stream
```

两条官方样本**都是** `*/*` —— 这是 Bun `fetch` 的默认值，说明官方 chat 路径
**没有显式设置** Accept，直接用了运行时默认。

我们此前写的是 `application/json, text/event-stream`，注释里注明"对齐 trefeon
chat.go:105"。问题在于：**trefeon 是另一个第三方实现，不是官方 CLI**。
它的选择被当成了金标准，把我们从真实形态推偏了。

## Decision

**chat 的 Accept 恒为 `*/*`，流式与非流式都一样。**

不区分 stream：官方两条样本都是流式请求，都发 `*/*`；非流式没有样本，
但同一运行时同一 fetch 路径，按同一个值发是最小假设。

## Alternatives considered

- **跟 trefeon 发 `application/json, text/event-stream`** —— 已被真机证伪。
  第三方实现之间互相抄会放大偏差；只有真机抓包能当金标准。
- **流式发 event-stream、非流式发 application/json** —— 改前现状，两头都不是
  官方值。按"看起来更语义化"去猜，正是这轮反复踩的坑。
- **不设置 Accept 交给 fetch 默认** —— 效果上等价（undici 默认也是 `*/*`），
  但显式写死能让意图可读、且不依赖运行时默认值变化。

## Consequences

- chat 的 5 类业务头（Accept / Authorization / Content-Type / User-Agent /
  3 个 x-freebuff-* ）现在全部与官方逐字一致。
- 注释里"对齐 trefeon"的来源被移除，避免后来者继续把第三方实现当金标准。

## Evidence

- 真机抓包两条流式 chat：`Accept: */*`。
- 官方 chat 完整业务头（13 个头里除 4 个传输层外的全部）：

```
Accept: */*
Authorization: Bearer <token>
Content-Type: application/json
User-Agent: ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser
x-freebuff-acting-user-id: <account user id>
x-freebuff-catalog-fetch: fbf1....
x-freebuff-device-key / -sig / -ts
```

- `npm test` 全绿。
- 相关：[2026-10-01-chat-ua-two-part.md](2026-10-01-chat-ua-two-part.md)（同一个 UA 头，
  同样被"非官方来源"带偏过）。
- ⚠️ 端到端未验证：本会话无可用账号（被封 + 其余三个 token 401）。
