# Agent Note: 回程工具改写必须流式, 不得等上游整篇收完

Status: implemented

## Problem

远程部署(`https://freebuff.woa.qzz.io`, 2.2.1)反复出现"带工具的请求失败", 用户
观感是"请求太频繁 / 工具调不出来". 远程日志(按 reqId 聚合后)给出唯一链条:

```
14:21:17.993 chat forward model resolved      requested=m-096e75164d
           ........  44.784 秒, 日志零字节 ........
14:22:02.929 official channel rpc failed, falling back to legacy
            error="bun bridge timeout after 44784ms"
14:22:03.131 upstream chat non-ok  status=428  waiting_room_required
14:22:05.769 upstream chat non-ok  status=428   (attempt 2)
14:22:05.770 account cooling down  code=waiting_room_required
14:22:06.103 skip account: freebucks cannot afford model  balance 10 < price 15
14:22:06.407 skip account: freebucks cannot afford model
14:22:06.692 skip account: freebucks cannot afford model  daily_exhausted
```

三次失败(`ba8ce1c0` 14:18:13 / `0fd9d03a` 14:19:31 / `0f45afc1` 14:21:17)完全同形,
耗时 48.09s / 48.59s / 48.76s, 都恰好卡在 45s 附近. 同一分钟窗口里带同样 55 个工具
的 `8cf25988` 3.5 秒就 200, `5a642abc` 用 41.3 秒 200(贴着悬崖).

全量日志里 `upstream chat non-ok` 只有 428, **一次 429 都没有** ---- 下游看到的 429
是本地合成的: RPC 超时 -> 降级 legacy 形态 -> 上游不认(428) -> 428 归入
`isSessionRecoverableGate` -> 同号 re-admit 重试 -> 再超时 -> 攒满 2 次 -> 换号冷却
-> 池中其余账号 `balance_shortfall`(余额 10 < 价格 15) -> 全池买不起 -> 下游 429.
日志里 `14:19:02~14:19:30` 与 `14:22:07~14:22:30` 两串各 14~15 个只含 3 行
`skip account` 的短请求, 就是这串雪崩的尾巴.

### 根因: 整段缓冲

`cli-bridge/lib/endpoints/chat.ts` 用 `await res.text()` 把上游整条 SSE 流收完才返回:

```ts
const res = await fetch(url, { method: 'POST', headers: hdrs, body });
const text = await res.text();          // 上游不产完整篇回复, 这里就不返回
```

而官方 chat 恒为流式. 于是"上游不产完整篇回复 -> bun 子进程不返回 -> 主服务一个
字节都吐不出来". 主服务侧又把 45s 的**首字节预算**套在了这次整体调用上:

- `src/proxy/chat/state/fields.ts` 的 `schedulingDeadline = now + schedulingBudgetMs`
- `src/proxy/transport/official.ts` 的 `timeoutMs = min(180000, schedulingDeadline - now)`

schedulingBudgetMs 的注释写明它是[首字节之前]的预算(全局槽位 -> 账号锁 -> 上游首字节),
防的是 Cloudflare 100s 悬崖; 但代码让它约束了"整篇回复". 语义错位 + 全缓冲 =
长回答必然超时.

全缓冲的动机在 `mergeAndTranslateSseToolCalls`: 它要跨分片合并同一个 tool_call 的
arguments(上游把参数拆成多片), 而合并需要完整文本.

## Decision

**把"整段收完再合并"改成"边收边改", 两个缓冲层级都消掉.**

### 一, bun 侧: 边收边吐

`chat.ts` 新增 `streamStdout` 开关: 上游字节按行直接写 stdout, 不在内存里拼整份.
stdout 协议加两行控制帧(正文行一律无前缀, 保持下游按行改写的原始形态):

```
@{"status":200}                    上游响应头一到就发(提交下游响应头前只等它)
data: {...}                        正文行, 逐字节原样
data: [DONE]
>{"action":"reuse","chat":{...}}   末行汇总(供 Promise 版 callBun 解析)
```

状态行是必需的不是可选: 主服务要在**提交下游响应头之前**知道上游状态码, 否则
428/503 会被包成 200 发给下游(错误被吞).

`cli-bridge/bridge.ts` 新增 `callBunStream(input, {timeoutMs, onLine, onSummary, onError})`:
逐行交出去, 末行汇总时 resolve; `callBun` 同步改为解析 `>` 前缀的汇总行.

### 二, 主服务侧: 只等状态行就交出流

`src/proxy/transport/official/stream.ts` 的 `runStreamingRpc`:

- 状态行 200 -> **立刻**返回带流体的 Response(不等正文), 后台任务在 RPC 结束时关写端;
- 状态行非 200 -> 等 RPC 收完错误体, 用**真实状态码**交出(不能包成 200);
- 任何信号之前失败 -> 返回 null, 调用方降级 legacy(保持既有容错).

timeout 语义分离: `RPC_TOTAL_TIMEOUT_MS = 600_000`(整篇上限)与 `schedulingDeadline`
(首字节预算)各管一段, 取二者较大值.

### 三, 改写层: 有界缓冲, 名字永不被参数拖住

新增 `src/proxy/transport/reply/sse-tool-rewrite.ts` + `sse-tool-line.ts` 取代
`mergeAndTranslateSseToolCalls` 的全量合并:

1. **名字**(`function.name`)只出现在首片 -> 首片立即还原并下发, 零延迟;
2. **参数**只在该工具[确有翻译规则]时才累积(`hasParamRule`); 能 `JSON.parse` 就立刻
   翻译并**就地**下发 ---- 上游一次给完时零额外延迟(本链路实测如此);
3. 参数真被拆开时, 该分片的 arguments **摘空**下发(名字照常), 累积到能解析的那一片
   就地替换成翻译结果 ---- 不额外补发分片(见下方"实测踩到的坑");
4. 无规则的工具名(55 个里的大多数)完全不过缓冲, 直接透传.

### 实测踩到的坑: 补发分片会让参数被拼两次

第一版在"参数构齐"时除了就地替换, 还**额外补发一行同 index 的分片**; 下游按 index
累积 arguments, 于是拿到 `{..}{..}` 而不是 `{..}` ---- `JSON.parse` 直接抛
`Unexpected non-whitespace character after JSON`. 端到端实测抓到这个形态后改为
"只在就地替换 + 流结束时对仍未构齐的做兜底", 并补了断言 ⑧(反向探针 5 精确捕获)

同一类坑还有一个分支: `flush` 的兜底补发必须先把**已构齐**的条目清出
`pendingPatch` ---- 否则关流时会把同一份参数再补一次.

累积语义按公开协议实测结论: [index 优先键控 + 首个非空 name 获胜], 延续分片里的
null/空 name 一律剔除 ---- 否则下游累积器会把名字抹空, 报 `unknown tool ""`
(deepseek-harness discussion #1713 的逐字节实测).

`rewriteUpstreamResponse` 增 `__toolRewriteApplied` 判定: RPC 路径已做过流式改写,
不再做第二遍(旧实现两层各改一次).

`CLIENT_TO_OFFICIAL_TOOL` 与 `buildOfficialToClientMap` 抽到
`src/upstream/signals/tool-name-map.ts`, 流式与非流式两条回程路径共用同一张还原表
(消灭"两处实现"的漂移隐患).

## Alternatives considered

- **什么都不做 / 让下游用非流式**: dsh 的 `stream` 是写死的, 改它等于要求用户改客户端.
  且非流式同样要等整篇, 只是把超时位置挪了地方.
- **只调大 timeoutMs(把 45s 改成 600s)**: 最省事, 但治不了根 ---- 首字节延迟仍等于
  整篇生成时间, 用户感知的"卡死"不变; 且 Cloudflare 100s 悬崖仍在(源站 100s 未回
  响应头即 524). 必须让首字节与整篇解耦.
- **保留 `mergeAndTranslateSseToolCalls`, 提前到首片就猜参数**: 参数是字符串分片,
  首片几乎必然不是合法 JSON, 猜不出来. 已有的 partial-JSON 方案(`partial-json` /
  `ijson`)要新增依赖, 而本项目的定位是零运行时依赖(仅 undici/yaml) ---- 且我们
  只翻译少数字段, 不值得为此引入解析器.
- **给 55 个工具都建参数翻译规则**: 与本次问题无关(参数翻译是既有能力), 且会让
  缓冲面从少数据工具扩到全部, 反而拖慢.
- **在 bun 侧就把工具名换回来**: bun 侧不持有[本次下游声明]与下游 schema, 换不回来;
  换到那里等于把两条协议语义各复制一份.

## Consequences

- **首字节延迟与纯透传等同**: 上游吐一片, 下游就收到一片. 不再有"等整篇"的静默期.
- **长回答不再被调度预算误杀**: 45s 只约束首字节之前的等待, 整篇上限独立(600s).
- **无翻译规则的工具走零成本路径**: 55 个工具里只有 9 个有参数规则, 其余逐行
  `JSON.parse` 之外无额外开销.
- **参数被拆开时多一行补发分片**: 下游按 index 拼装, 语义等价; 代价是流里多一行.
- **bun 子进程仍在(每次 chat 一个)**: 本次不碰该架构 ---- 它不在故障链上, 且
  `cli-bridge` 是官方形态唯一实现处.
- **stdout 多两行控制帧**: 任何新增的 bun 调用方都要按 `>`/`@` 前缀解析; `callBun`
  已同步处理, `serve/api` 走的是它, 契约不变.
- **测试**: 新增 `test/suites/entries/verify/tool/stream-rewrite.ts`(17 断言, 夹具在
  `.../tool/stream/harness.ts`), 已登记进 `test/run.ts`. 断言覆盖: 增量投递 /
  名字首片还原 / 参数整份立即翻译 / 参数拆开后关流的完整性 / 参数不得被拼两次 /
  null-name 剔除 / 载体拆包 / 非 data 行与畸形 JSON 透传 / 未构齐时的兜底.

## Evidence

### 协议级实测(假 bun 复现 chat.ts 的 stdout 协议, 上游内容可控)

关键指标 = 状态行到达时刻 vs 正文首片到达时刻:

```text
+24ms    @{"status":200}                    <- 下游此刻就能提交响应头
+2025ms  data: {...,"tool_calls":[{"index":0 ... (上游"思考"2s 后才吐首字节)
+2125ms  data: {... "arguments":"-la\"}"}   <- 参数构齐, 就地翻译完成
+2226ms  data: {...,"finish_reason":"tool_calls"}
+2326ms  data: [DONE]
```

全链路(过 `rpcReuse` + 变换器)终态校验:

```text
name      = bash
arguments = {"command":"uname -a","description":"run: uname -a"}
```

即: 官方名 `run_terminal_command` 已还原成下游的 `bash`, 官方参数形态已翻译成
下游 schema(含合成必填的 description), 且参数只拼一次.

### 反向探针(逐条实测, 破坏实现后本套件必须变红)

| 探针 | 破坏点 | 结果 |
|---|---|---|
| 1 | `transform` 改成攒到 flush 才 enqueue | 红: 第一片内容必须在写入后立刻可读 |
| 2 | 去掉 `plan.back` 名字还原 | 红: 首片带官方名时必须立刻还原成 bash |
| 3 | 去掉延续分片的 null-name 剔除 | 红: 必须剔除该键(否则 unknown tool "") |
| 4 | 关掉参数翻译(`worthBuffering=false`) | 红: 下游必填的 description 未合成 |
| 5 | 恢复"补发分片" | 红: 承载参数的片只能有一个(实际 2 个) |

5 条全部先红后绿(还原后 17/17).

门禁: `npm run check:gates` 17/17; `npm run typecheck` 通过;
`npm run verify-notes` 全过(coverage 认到 10 个受保护路径).
全套 `npm test` 9 个套件通过(222.5s).

**未完成**: 远程端到端真实请求验证(需要一次带工具的远程 chat, 会消耗额度).
本次改动覆盖"协议级实测 + 门禁 + 全套测试", "远程不再出现 44.8s 卡死"仍需一次
真实请求最终确认.
