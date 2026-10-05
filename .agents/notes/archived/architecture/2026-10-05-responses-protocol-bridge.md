# Agent Note: /v1/responses 走协议翻译复用 chat 链路, 不重写第二条调度链

Status: implemented

Archived: 2026-10-05

## Problem

下游 harness(dsh 的 `fb` provider)按 Responses 协议发请求:

```yaml
fb:
  api: openai-responses
  baseURL: https://ai.woa.qzz.io/v1
```

实测单变量对照(同一 key, 同一模型, 同一分钟):

| 通道 | 结果 |
|---|---|
| `POST /v1/chat/completions` | HTTP 200, 正常返回 |
| `POST /v1/responses` | HTTP 502 `error code: 502` |

根因不是账号/额度/模型: 本仓**没有 `/v1/responses` 实现**. 该路径落到
`handleGenericPassthrough`(`src/proxy/routes/router.ts` 的 `/v1/*` 兜底),
被原样透传到上游 `/api/v1/responses`, 上游没有这个端点, 中间层把 404 崩成
502 空体 ---- 与 docs 里记过的同族现象一致.

会话日志里同时出现 `502 status code (no body)` 与多次
`429 Upstream rate limit exceeded`, 都是这条路径的直接后果.

## Decision

**翻译, 不重写**. 入站 `/v1/responses` 翻成 chat 请求, 用合成 req/res 驱动
同一个 `chatHandler`, 再把它的输出翻回 Responses:

```
/v1/responses
  -> chatRequestFromResponses()   翻请求(input items -> messages, 扁平 tools -> function 包装)
  -> syntheticChatRequest()/createCaptureResponse()
  -> chatHandler()                既有链路: 会话调度/账号锁/换号/上游形态/工具承载
  -> sseEventsFromChatChunk()     翻响应(chat 分片 -> response.* 事件)
```

不新开链路的原因: 会话调度 / 账号锁 / 换号重试 / 官方形态 / 工具承载全在 chat
那条链上, 复制第二份必然漂移. 而 `handleChatCompletions` 对 req 只用到
`headers / method / url / socket / 可迭代体 / destroyed`, 对 res 只用到
`setHeader / getHeader / writeHead / write / end / on / once / headersLoaded`,
所以合成对象是可控的.

协议真值取自 **dsh 自身的实现**, 不是记忆:
`@earendil-works/pi-ai/dist/api/openai-responses.js` 与
`openai-responses-shared.js`:

- 请求: `model / input / stream / store`, 工具是扁平
  `{type:'function', name, description, parameters}`(没有 chat 那层 function 包装).
- 响应: `output` 数组 + 扁平字段; 工具调用是 `function_call` item, 且 id 是
  `call_id|item_id` 两段式(其 createSlot 对 `item.type === 'function_call'` 的写法).
- 流式事件名: `response.created` / `response.output_item.added` /
  `response.output_text.delta` / `response.function_call_arguments.delta` /
  `response.output_item.done` / `response.completed`.

## Alternatives considered

- **什么都不做 / 让下游改用 chat 协议**: dsh 侧的 `api: openai-responses` 是
  它的 provider 配置, 改它等于要求用户为这个代理改客户端. 而 Responses 是常见
  协议(本仓既有注释里也提到下游有 Responses 桥接层), 兼容它比要求所有人都改更合理.
- **在 chatHandler 里加 if 分支识别两种协议**: 会把一条已经拆得很细的链路
  (选号/锁/重试/管道)搅进第二套字段名, 每个分支都要判两次. 翻译层放在协议边界上,
  链路本身一行不改.
- **直接透传给上游 `/api/v1/responses`**: 实测上游没有该端点, 拿到的是 404 被
  崩成 502. 且 docs/reverse/20 的白名单只准用客户端真实发过的端点, 这属于新增
  上游请求, 违反该约束.
- **只补非流式**: dsh 的 `buildParams` 里 `stream: true` 是写死的, 只做非流式
  等于这条链路仍然用不了.

## Consequences

- `/v1/responses` 与 `/v1/chat/completions` 共享同一套并发闸门(`withRequestSlot`)
  与会话调度; 两条协议不允许绕过彼此的限制.
- 上游仍然只有 `/api/v1/chat/completions` 一个 chat 端点, 没有新增上游流量
  (docs/reverse/20 的白名单约束不变).
- 上游是流式(官方链路 stream 恒 true)而非流式的 Responses 请求需要 aggregation,
  由 `aggregateChatSse()` 把 SSE 收成一条 message 再翻译.
- 收尾事件必须带**完整**文本与完整调用参数: 只发 delta 而 done 给空串会让客户端
  拿不到最终内容(实测过这个中间态, 输出 `text: ""`).
- 工具调用的 `call_id` 必须原样出现在 `function_call` item 上, 并拼出两段式 id;
  缺 call_id 会让下一轮 `function_call_output` 对不上.
