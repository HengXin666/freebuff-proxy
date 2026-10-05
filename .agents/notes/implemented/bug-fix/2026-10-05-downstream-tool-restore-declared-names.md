# Agent Note: 回程工具还原必须按下游[本次声明]过滤, 参数形态要一起翻译, 且定位失败必须显式报错

Status: implemented

## Problem

两条独立缺陷, 都在本仓的模型/工具标识层, 都不是客户端的问题.

### 一, 回程还原会造出下游从未声明的别名

实测症状(本地 dsh 会话记录, 62 个会话 / 148 条 isError):

```
ls   -> Error: unknown tool "ls"       参数 {"path":"."}
     -> Error: unknown tool "ls"       参数 {"path":"src/proxy/routes/responses"}
read -> Error: invalid arguments: missing required property "file_path"
                                    参数 {"paths":["src/...","src/..."]}
```

成因: `unmapToolCallsInBody` 用全表反查 `CLIENT_TO_OFFICIAL_TOOL`, 不看下游这次
到底声明了什么. 只要模型调了官方原生工具 `list_directory`, 回程就被改名成 `ls`
(表里 `ls -> list_directory` 的反向), 而下游可能根本没声明 `ls`.

同一官方名有多个下游别名时, 选哪个也是猜的: `read_files` 一律还原成 `read`,
即使下游声明的是 `cat` 或 `read_file`.

`cli-bridge/lib/tool-map.ts` 的 `unmapToolCalls(body, unmappedNames)` 本来就支持
按本次请求过滤, 但它在 cli-bridge 里, 主服务(Node)侧 import 不到 ---- 同一张表
两处实现, 只有一处带了过滤条件.

### 二, `pickRow` 静默回落首行, 把一个定位失败伪装成成功

`cli-bridge/lib/upstream/actions.ts`:

```js
return rows.find((r) => r.key === input.modelKey)
  || rows.find((r) => r.handle === input.modelKey)
  || rows[0]                                   // 静默回落
```

`modelKey` 传的是 handle(`src/proxy/transport/official.ts` 把 `forwardBody.model`
当 modelKey, 而它已被 `catalog.handleFor()` 翻成 handle). 而 handle
**每次抓取全量轮换**(docs/reverse/19 第 19.3 节实测: 同一次会话里同一模型出现过
`fbm1.AAEAAUPu6mpo...` 与 `fbm1.AAEUPvzJ2N62...` 两个 handle), 所以跨抓取必然匹配不上.

匹配不上时不报错, 而是取 `rows[0]` ---- 远程目录第一行是 MiMo 2.6 Flash, 于是:

```
12:00:23 chat forward model resolved  outgoing=fbm1...deepseek 的 handle
12:00:33 official channel: rpc result status=409  model=MiMo 2.6 Flash
12:00:33 upstream chat non-ok         409 session_model_mismatch
```

会话是按 deepseek 的 handle 绑定的, 却拿 MiMo 的标识去 chat. 本地日志只显示
"model=MiMo 2.6 Flash", 排障时完全看不见真实原因.

### 三, 回程只还原名字, 不还原参数形态

线上实测(2026-10-05, 远程 2.2.0, 一次带 tools 的真实请求):

```
"function":{"name":"read"}
"function":{"arguments":"{\"paths\":[\""}   <- 拼起来是 {"paths":["src/index.ts"]}
```

下游 `read` 只认 `file_path`, 于是 `invalid arguments: missing required property
"file_path"`. 本地会话记录里这一类 4 条; `edit` 的 `old_string was not found`
同源(官方对应物是 `replacements[].oldString`).

参数对照(逐项不同):

| 下游 | 下游必填 | 官方等价物 | 官方必填 |
|---|---|---|---|
| read | file_path | read_files | paths |
| write | file_path, content | write_file | path, instructions, content |
| edit | file_path, old_string, new_string | str_replace | path, replacements[] |

## Decision

1. `unmapToolCallsInBody(body, declaredNames, declaredSchemas)` 增加[本次声明]过滤: 只把官方名还原成
   下游这次真的声明过的客户端名; 声明集里没有的一律保持官方原名(下游收到不认识的
   名字会明确报错, 好过收到一个它不认识的别名). 调用方不传声明集时退化为旧行为.
2. 声明集一路从 `src/proxy/chat/run/turn.ts`(从 `st.body.tools` 取)传到
   `forwardCompletions` -> `tryOfficialChannel` -> `buildUpstreamResponseFromRpc`,
   以及 `rewriteUpstreamResponse`. SSE 与整体 JSON 两条路径共用.
3. `pickRow` 匹配不到时返回 null, 新增 `failUnknownModel` 显式写
   `out.error` 并置 `out.ok = false`; 五个 action(admit/chat/reuse/dryrun/full)全部接入.
4. `cli-bridge/lib/tool-map.ts` 的 `unmapToolCalls` 同步支持声明集过滤, 两侧同语义.
5. 新增 `src/upstream/signals/param-map.ts`: 官方参数形态 -> 下游参数形态的翻译表
   (read/write/edit/bash/grep/ls/web_fetch/web_search). 无规则的组合一律返回 null,
   调用方原样保留参数; 翻译后按下游 schema 的 properties 裁剪键(下游普遍声明
   additionalProperties: false, 多一个键就整条被拒).
6. 新增 `src/proxy/transport/reply/sse-tool-merge.ts`: 官方链路恒为流式, 一个
   tool_call 的 arguments 被拆成多个 data 分片, 逐行翻译时每片都不是完整 JSON.
   该层先把同一调用的 name 与 arguments 合并回完整调用, 翻译后放回首次携带它的
   那个分片, 其余分片 arguments 清空 ---- 结构不变, 下游增量拼装得到的仍是完整
   且形态正确的调用.

## Alternatives considered

- **只还原名字, 参数不动(即本次修改前的状态)**: 就是线上实测到的
  `name=read` + `{"paths":[...]}` 错配. 下游必然报参数缺失.
- **回程直接把下游 schema 替换掉上游 schema / 反向改写请求体**: 那是下行方向
  的事, 改不动已经发出去的上游调用; 且会让模型失去官方 schema 的提示.
- **什么都不做 / 沿用全表反查**: 这就是本 bug 的成因. 幽灵别名会让下游直接
  `unknown tool`, 且用户无法从日志看出是谁改的名.
- **只在下游报错后重试一次**: 治不了根 ---- 下游拿到的是一个语法合法但语义错误的
  工具调用(名字与 schema 不匹配), 它没有"重试"的语义可用; 而且每个请求都可能中.
- **把官方 37 工具从出站列表里删掉, 只发下游声明的工具**: docs/reverse/18 第 4.1 节
  单变量实测已证伪"陌生工具名会被拒", 但官方工具集是指纹对齐的一部分,
  删掉会改变请求形态; 且模型的工具选择空间会大幅缩小. 保留官方集, 只修回程还原.
- **把 `cli-bridge/lib/tool-map.ts` 与 `src/upstream/foreign-client-signals.ts`
  的两张表合并成一份**: 合并是对的终局, 但它要改 import 边界(bun 侧与 Node 侧),
  风险面远大于本次两个缺陷. 本次先让两侧**同语义**, 合并另开.

## Consequences

- 下游收到的 tool_call 名字, 一定是它这次声明过的名字之一; 否则就是官方原名.
- 有翻译规则的工具(read/write/edit/bash/grep/ls/web_fetch/web_search)参数形态
  与下游一致; 没有规则的组合保持官方原样(下游会看到陌生字段并明确报错).
- 翻译规则是**静态表**, 上游改官方 schema 时要回来对
  docs/reverse/captures/official-tools.json.
- `pickRow` 失败会让整轮 `out.ok=false`, 上层的 `relayUpstreamError` 会把它当
  上游错误透传(502/400). 这是刻意的: 定位失败必须可见.
- 声明集为空(无工具请求)时行为与旧版一致, 不影响无工具路径.

## Evidence

反向探针(先破坏实现, 确认断言变红, 再还原):

```
2) list_directory(下游未声明) -> list_directory   # 旧实现此处会给 ls
5) 下游声明 sh            -> sh                 # 旧实现会给 bash(表内第一个)
6) 下游声明 cat           -> cat                # 旧实现会给 read
7) 不传声明集             -> read               # 旧行为兼容
```

`pickRow` 侧:

```
1) pickRow 仍回落首行(必须为 false): false
2) pickRow 找不到时返回 null: true
4) 接入 failUnknownModel 的 action 数(应为 5): 5
```

线上实测(远程 2.2.0, 修改前):

```
"function":{"name":"read"}
"function":{"arguments":"{\"paths\":[\""}   -> 拼接 {"paths":["src/index.ts"]}
```

门禁与测试:

```
npm test             -> ALL SUITES PASS (8 个, 含新增 tool-restore-declared 32 条断言)
npm run check:gates  -> ALL PASS (17/17 条)
npm run typecheck    -> 通过
```
