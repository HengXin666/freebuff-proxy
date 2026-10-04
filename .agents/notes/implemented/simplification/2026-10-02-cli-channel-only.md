# Agent Note: CLI Channel Only — Web Channel Removed

Status: implemented

**Affects:** `src/proxy.js`,`src/upstream/client.js`,`src/web/api.js`,
`src/web/settings-store.js`,`test/smoke.mjs`

## Problem

`/v1/chat/completions` 存在一个[网页通道]优先接管分支:命中
`shouldUseWebChannel()` 时走 `freebuff.com/api/chat/stream`,**根本不进 CLI 通道**.

它的请求体只有 `{ threadId, content, model, reasoningEffort, images, attachments }`
—— **没有 `tools` 字段**.所以只要它接管,工具调用就不可能工作:
tools 参数被静默丢弃,客户端永远拿不到 `tool_calls`.

更糟的是它会**伪装成协议化失败**:设备签名明明生效了(实测带签名 53 模型,
不带 13 模型),但对话仍没有工具能力 —— 因为路走错了,不是签名没用.
用户明确要求:"我们只需要 CLI 这个通道,我不需要 chat 这个接口,
这个是之前遗留的,现在没有用了,我们永远只走真正的 agent 接口".

## Decision

彻底移除网页通道,而不是"加开关默认关":

- 删 `shouldUseWebChannel()` / `webThreadIdFor()` / `handleWebChannelChat()`(共 230 行)
- 删 `upstream.webChat()` 及其 `webChatHeaders` import
- 删设置项 `webChannelEnabled`(默认值,load 读回,save 校验,API 暴露)
- `/v1/chat/completions` 唯一入口 = `handleChatCompletions()`(CLI 通道:
  admit 会话 → startAgentRun → `codebuff.com/api/v1/chat/completions`)

已落盘的旧 `settings.json` 里若残留 `webChannelEnabled`,不会被读回(字段已不存在).
测试改为断言该 key **不存在**(含 legacy 残留场景),钉死"不许复活".

## Consequences

- 所有请求都必须过 CLI 通道的会话准入(会扣 Freebucks,占会话槽位)——
  这是使用真正 agent 接口的必然代价,也是它的价值所在(有 tools).
- `limited` 访问档位下 CLI 通道可能对部分模型 503.这不再是"切到网页通道绕开",
  而是要么换出口/验证身份提升档位,要么换模型.
- 行为变化:此前开着网页通道的部署会开始消耗 Freebucks 并可能 503.
  属于用户明确要求的方向性修正.

## Alternatives considered

### 1. 保留网页通道,但把开关默认关掉

**Rejected:** 开关仍在,就仍会被打开,然后再次出现"工具调用静默失效"且难以归因.
用户要的是"永远只走 CLI",不是"默认走 CLI".

### 2. 保留网页通道,给它补上 tools 支持

**Rejected:** `/api/chat/stream` 是 Freebuff 网页版的 thread 机制接口,
没有 tools 的协议位置;补不出来.且它与 CLI 通道的鉴权(cookie vs Bearer),
上下文模型(threadId vs 客户端带全量历史)都不同,是两条路.

### 3. 保留网页通道作为 limited 档位的自动回落

**Rejected:** 回落过去 = 工具调用静默消失.宁可如实 503 让用户知道该换出口,
也不要给一个"能聊天但没工具"的假可用状态.

### 4. 什么都不做

**Rejected:** 用户明确要求移除.

## Related

- `.agents/notes/implemented/feature/2026-09-30-web-chat-stream-transport.md`(网页通道引入时的决策,本篇取代它)
- `.agents/notes/implemented/bug-fix/2026-10-02-no-account-pii-in-errors.md`(同轮修的错误响应 PII)
- 设备签名 A/B 实测:带签名 53 模型 / 不带 13 模型 —— 协议化确实生效,
  网页通道移除前它才是"对话能通但没工具"的真因
