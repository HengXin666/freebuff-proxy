# Agent Note: v1/responses 明确不支持(无会话存储)

Status: implemented

## Problem

Responses 协议有两种调用形态, 本仓只支持得了其中一种:

- 全量形态: 每次请求把完整对话放进 input 数组(pi-ai 的
  openai-responses.js 就是这种, 其 buildParams 同时写死 store: false).
  这种本仓能译.
- 引用形态: 请求带 store: true 或 previous_response_id, 只发增量 item,
  历史留在服务端. 本仓没有会话存储, 上游 Freebuff 侧也没有
  (docs/reverse/20-upstream-endpoint-whitelist.md 的端点白名单里没有任何
  会话存储 API).

引用形态落进来的后果是静默的: 翻译层只读 model / input / tools / stream /
temperature / top_p / max_output_tokens / tool_choice / parallel_tool_calls /
instructions, 从不读 store 与 previous_response_id, 于是上游收到的是一轮
没有前文的对话 ---- 模型答非所问, 而 HTTP 仍是 200. 这比直接失败难查一个量级.

v2.2.0 上线的协议桥接(见 .agents/notes/archived/architecture/
2026-10-05-responses-protocol-bridge.md)正是这个形态: 它对全量形态有效,
对引用形态静默丢上下文.

## Decision

/v1/responses 明确不支持, 统一回 501 not_supported.

实现落在 src/proxy/routes/router.ts 的 rejectResponses(): 匹配
route === '/v1/responses' (不限方法), 回 501 并在 message 里直接给出出路
---- 改发全量 messages 到 /v1/chat/completions.

三条约束, 每条都是在实现里被踩到或差点踩到的:

- 这一支必须留在 /v1/* 兜底之前. 去掉它, 请求会落进同一文件的
  handleGenericPassthrough, 被原样透传到上游 /api/v1/responses; 上游没有
  这个端点, 中间层把 404 崩成 502 空体. 这正是 v2.2.0 之前用户报的那个症状.
- 不限方法. 只看 POST 时, GET / PUT 仍会走兜底拿到 502. 实测三种方法均为
  501, 且 chat 链路零调用.
- 不返回 200 空响应, 也不假装成功. 想让它"能跑"的诱惑是返回一个空的
  output: [], 但那会把协议错误伪装成模型没输出.

同一提交里删掉了协议桥接的全部实现: src/proxy/routes/responses/ 五个文件,
src/proxy.ts 的 handleResponsesRequest 包装与 handleResponses import,
test/suites/entries/verify/protocol/responses-bridge.ts 及其在 test/run.ts
的注册. 留下它们是留下一个会静默出错的可达路径.

## Alternatives considered

- **保留桥接, 只对引用形态 fail-fast**(即只拦 store: true 与
  previous_response_id). 它的最强理由是: 全量形态的调用方(如 dsh)确实能
  正常工作, 拦掉等于让已经能用的链路改用别的端点. 否决的原因是收益不成立
  ---- 本仓对外的定位是 OpenAI 兼容的 chat 代理, /v1/chat/completions 是
  唯一主路径; 多一条只在"全量"子集上正确的协议面, 换不到任何本仓已有能力,
  却要长期承担两套字段名与一套只能对半支持的语义.
- **把全量历史缓存到本地, 补上引用形态.** 服务端存储是唯一能真正支持
  previous_response_id 的做法, 所以这是"支持"的唯一完整答案. 否决: 本仓是
  无状态代理, 实例内缓存会造出影子会话(TTL 到期, 进程重启, 多副本被打散,
  三者都表现为静默上下文损坏), 而共享存储等于给一个无状态代理引入有状态
  组件并额外留存用户对话. 另有旁证: 本仓既有的 stripFreebuffConversationState()
  (src/free-mode/body.ts)一直在主动删除下游传来的 conversation_id /
  session_id / thread_id / run_id, 理由是留着会把新请求绑到已退役的会话上
  ---- 一个正在向无状态收敛的仓, 不该新开一条有状态面.
- **什么都不做, 保持 v2.2.0 现状.** 对 dsh 这类只发全量的调用方确实无害,
  这是它最强的地方; 实测也确实通过. 否决: 缺口是静默的 ---- 引用形态调用方
  拿到 200 加错误答案, 且没有任何日志能指出这件事. 留一个已知会静默出错的
  协议面, 比明确拒绝它更贵.
- **只删路由分支, 不删桥接实现.** 否决: 请求会退化成 502 空体(见上), 且
  五个无人引用的文件会变成下次有人"顺手复活"的现成材料.

## Consequences

代价:

- 任何把 provider 配成 api: openai-responses 并打向本仓的客户端, 从"能跑
  (全量形态)"或"静默错答(引用形态)"变成一律 501. 调用方须改配 chat 协议,
  或改发全量 messages.
- 上游契约面缩小一条: /v1/responses 从"有实现"回到"路由表显式拒绝".

换到:

- 引用形态不再静默丢上下文 ---- 它现在必然以 501 加一句可操作的 message 结束.
- 502 空体这个伪症状从这条路径上消失(它此前是 404 被中间层包装的结果).
- 保护源码因此少一个 300 行规模的协议适配面, 少一处需要跟随上游字段变化
  维护的翻译层.
