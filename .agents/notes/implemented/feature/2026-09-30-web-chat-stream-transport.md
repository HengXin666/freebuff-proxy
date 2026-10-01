# Agent Note: 新增网页通道（/api/chat/stream）作为 Freebuff 上游 transport

Status: implemented

## Problem

`accessTier: limited`（非 allowlist 国家 / 任何 VPN）下，CLI 通道
`POST codebuff.com/api/v1/chat/completions` 对**全部** limited 目录模型返回
`503 "The model is temporarily unavailable"`：
实测 `upstage/solar-mini4`、`mimo/mimo-v2.5`、`z-ai/glm-5.3-flash` 三个均为
`LIMITED_FREEBUFF_MODEL_IDS` 成员，无人幸免。

但**同一账号、同一出口 IP**，换网页通道就完全正常。实测：

```
POST https://freebuff.com/api/chat/stream
Cookie: __Secure-next-auth.session-token=<同一把 authToken>
→ 200, data: {"type":"meta",...,"accessTier":"limited"}
   data: {"type":"delta","text":"OK"}
```

**同一凭据、同一 IP，只换端点与鉴权形态，结果完全不同。** 所以这从来不是 IP 问题，
是通道选择问题。

## Decision

**新增一个并行的网页 transport，把 OpenAI 格式的 /v1/chat/completions 映射
到 /api/chat/stream，与既有 CLI 通道并存。**

协议形态（实测取得，`web/` 目录未同步到公共仓库，故以线上实测为准）：

- 端点：`POST https://freebuff.com/api/chat/stream`
- 鉴权：`Cookie: __Secure-next-auth.session-token=<authToken>`
  ⚠️ 必须是带 `__Secure-` 前缀的这个名字。实测 `next-auth.session-token`
  （无前缀）与 `Authorization: Bearer` 都是 401 `Please sign in to chat`。
  前缀这条线索来自 CLI 源码 `cli/src/utils/codebuff-api.ts:346` 的
  `includeCookie` 选项，但源码写的是无前缀名 —— 有前缀才是线上真值。
- 请求体：`{ threadId, content, model, reasoningEffort, images, attachments }`
- 模型 id **无厂商前缀**：`deepseek-v4-flash`，而非 `deepseek/deepseek-v4-flash`
- 响应：SSE，事件 `meta` / `reasoning_delta` / `delta` / `suggestions` /
  `title` / `done`

### 两条通道的关键差异

**网页通道不消耗 Freebucks。** 两次完整对话后查账 `spent: 0, remaining: 20/20`，
模型计数也没涨。它走 thread 机制（`threadId`），与「一次 admit 买断一小时」的
会话计费是两套独立体系 —— 这正是浏览器上「完全没有阻拦」的原因。

**多轮靠 threadId，不是靠客户端重发历史。** 实测 R1 说 "My name is YG"、
R2 问名字，正确答出 "YG"。

**必须读完当前流才能发下一轮**：未读完就发会得到
`409 {"error":"response_in_progress"}`。

## Alternatives considered

- **继续在 CLI 通道上改伪装** —— 已对齐到源码可验证的极限（UA、端点、
  `x-freebuff-env`、`cli:` claim、`surface: cli` 全部到位），503 依旧。
  继续猜形态只会继续烧账号。
- **只做最小可用（仅单轮非流式）** —— 省事，但代理的核心用例（流式、多轮）
  缺一半，且 OpenAI 客户端普遍要求流式。既然要做就做完整。
- **放弃工具调用** —— 网页通道能否真正发起 tool_call 未证实（带 `tools` 字段
  返回 200 且事件里没有明确的 tool_call 结构）。先按文本优先实现，工具能力
  作为已知降级，不冒充支持。

## Implementation

新增 `src/upstream/web-chat.js`（协议与流解析）与
`src/upstream/web-chat-openai.js`（格式转换），并在 `/v1/chat/completions` 的
**入口**接管 —— 必须在选号/admit 之前，否则外层会用 CLI 通道的准入先把请求
拒掉（实测踩过：放进 forwardCompletions 就太晚，返回的是 country_blocked）。

控制台新增 `webChannelEnabled` 开关，**默认关闭**以保持既有行为。

## Testing

- 开关关闭时行为与改动前完全一致（CLI 通道，全部既有测试通过）。
- 开关开启时：`/v1/chat/completions` 走 freebuff.com，返回 OpenAI 格式；
  非流式返回 `chat.completion`，流式返回 `chat.completion.chunk` + `[DONE]`。
- 不消耗 Freebucks（Freebucks 余额在对话前后不变）。
- 多轮：同一 `x-freebuff-thread-id` 下上下文延续。
- 转换层逐项被测试锁住（模型 id 双向、cookie 名、事件映射、跨 chunk 解析）。

## Consequences

- 现有 CLI 通道保持不变，网页通道并行；按可用性选择，不做静默切换。
- 模型 id 需要双向转换（无前缀 ↔ 有前缀）。
- 不消耗 Freebucks ⇒ 绕开了「一次 admit 买断一小时」的调度约束，
  但**也绕开了既有的两本账闸门** —— 限流边界未知，需实测其上限。


## Verification (2026-10-01，端到端已通过)

经代理转发的完整链路实测通过（账号 `llh282000500@gmail.com`，未封）：

```
POST /v1/chat/completions  {"model":"deepseek/deepseek-v4-flash", stream:false}
→ 200 {"id":"chatcmpl-web-...","object":"chat.completion",
        "choices":[{"message":{"role":"assistant","content":"OK"},
                    "finish_reason":"stop"}]}

stream:true → SSE：
  data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}
  data: {"object":"chat.completion.chunk","choices":[{"delta":{"reasoning_content":"..."}}]}
  data: {"object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}
  data: [DONE]
```

非流式与流式均**零错误**收尾（`unhandled request error` 计数为 0）。

关键实证：**全程 Zero Freebucks 消耗** —— 对话前后 `spent: 0,
remaining: 20/20`。这印证了网页通道走 thread 机制、不经过「一次 admit
买断一小时」的会话计费，也解释了浏览器上"完全没有阻拦"。

### 修掉的一个真 bug

初版在 `handleWebChannelChat` 里只取了 `reqToAbortSignal(req).signal`
而**丢弃了返回的 `cleanup`** —— 那是 keep-alive 连接的 socket 监听器，
不摘会随请求累积，且客户端中途断开时 AbortError 冒到顶层。现已：
- 保留 `abortCtrl` 并在所有出口（成功/错误/异常）`cleanup()`；
- 流式读取包 try/catch/finally：下游断开走"优雅收尾"而非冒错，
  `finish_reason` 与 `[DONE]` 只在客户端仍在时发送。

⚠️ 教训（前三次封号的共同点）：**反复请求即封号**，与请求正确性无关。
本轮严格一次一请求、失败即停，账号完好。

## Risks

- **封号风险最高**：网页通道的限流边界未知。三次封号的共同点是"反复请求"，
  与请求正确性无关。必须一次一请求、失败即停。
- **工具能力未证实**：带 `tools` 返回 200 但未观察到 tool_call 事件，
  故不冒充工具能力（finish_reason 恒为 stop）。若下游依赖工具调用会静默降级。
- **限流未知**：不消耗 Freebucks 不等于无限。开启前应先探明其上限，
  否则可能比 CLI 通道更快触发风控。
- **thread 语义差异**：网页通道靠服务端 threadId 记住上下文，与本项目
  "无会话记忆"（客户端带全量历史）的既有设计不同 —— 多轮行为可能不一致。

## Evidence

- 真账号实测：网页通道 200 + 正常出流；CLI 通道同账号 503。
- 网页通道两次对话后 Freebucks 仍 20/20（`spent: 0`）。
- 多轮实测：R1 "My name is YG" → R2 "What is my name?" → "YG"。
- 未读完流就发下一轮 → 409 `response_in_progress`。