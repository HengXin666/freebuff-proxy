# Agent Note: 工具集必须双向映射到**真实抓包的官方名**(带工具即 503 的真因)

Status: implemented

## Problem

用户报[带工具的请求被上游拒],并要求[发送 1 次请求,能够正常回复,不拒绝,
并返回工具调用].

### 一,带工具请求 503,不带工具 200(同一会话,同一刻)

单变量对照(本地,同一条已付费会话,边际成本 0):

| 组 | 工具集 | 结果 |
|---|---|---|
| A | 不声明工具 | **200** |
| B | 20 个第三方工具(`bash`/`edit`/`read`/`write`/`glob`...) | **503** |
| B′ | 同 B,但合并官方 37 后发出 | **仍 503** |

远程同现象(2026-10-04 15:02):`toolCount: 55` → 503;
之后不带工具的请求全部 200.**唯一变量就是工具集.**

### 二,旧行为:客户端工具**原样追加**

`mergeOfficialTools()` 把下游工具按名去重后**直接追加**到官方工具集后面.
而上游官方工具集是**固定 37 个**(`docs/reverse/captures/official-tools.json`),
里面**没有** `bash` / `edit` / `read` / `write` 这些下游 harness 的常用名 ——
上游看到官方不存在的工具名,把请求当外来客户端.

### 三,更深一层:代码里的"官方工具名清单"本身是错的

即使加了映射,第一次仍 503.逐字段 dump 请求体后发现:

```
发出工具名里的唯一非官方名 = ask_user
真实抓包里的官方名        = ask_questions
```

根源:`src/upstream/foreign-client-signals.js` 的 `OFFICIAL_TOOL_PARAMETER_KEYS`
(手写 40 项)与**真实抓包**(37 项)**只有约 12 项重叠**:

- 抓包有,代码无:**25 项**(`ask_questions`,`preview_*` 共 18 个,
  `read_thread_context`,`register_preview`,`report_project_profile`,
  `request_elevation`,`suggest_prompts`,`write_doc`,`browser_check`)
- 代码有,抓包无:**28 项**(`add_message`,`apply_patch`,`ask_user`,
  `browser_logs`,`composio_*`,`create_plan`,`find_files`,`gravity_index`,
  `lookup_agent_info`,`propose_*`,`read_docs`,`read_subtree`,`render_ui`,
  `set_*`,`skill`,`spawn_*`,`suggest_followups`,`task_completed`,
  `think_deeply`,`update_subgoal`)

那份手写表是**CLI 世代残留**(与 `lookup_agent_info` 同类,见
`docs/reverse/18` §三 的注).**拿它当判据,映射目标就落在上游不认识的名字上.**

## Decision

### 一,下行映射:客户端名 → **真实抓包的官方名**,映射不到的**原样保留**

`cli-bridge/upstream.mjs` 的 `MAP_TOOLS` + `mergeOfficialTools(official, client)`:

```
bash  → run_terminal_command      read  → read_files
edit  → str_replace               grep  → code_search
write → write_file                ls    → list_directory
…（34 条，目标全部在真实抓包里）
```

- 映射不到的**原样保留**(不改名,不丢弃;见文末[重大更正]一节 ——
  "映射不到即丢弃"已被单变量实测证伪).
- 去重保留(客户端声明了官方已有名时以官方定义为准).

### 二,上行还原:官方名 → 客户端名

`foreign-client-signals.js` 的 `unmapToolCallsInBody()`,在 `proxy.js` 透传前
逐行处理 SSE.**必须同时处理两种形态**:

- 非流式:`choices[].message.tool_calls[]`
- **SSE 流式:`choices[].delta.tool_calls[]`**(首片给 name,后续片只给 arguments)

只处理 `message` 会让流式响应一条都不还原(实测 `changed: false`).

### 三,判据改用真实抓包

`test/verify-tool-name-mapping.mjs` 的"官方工具名"取自
`docs/reverse/captures/official-tools.json`,**不是**代码里的手写表.
两侧映射表(bun 侧 `MAP_TOOLS` / Node 侧 `CLIENT_TO_OFFICIAL_TOOL`)
**逐条一致性**由该测试扫描校验.

## Alternatives considered

- **继续原样追加客户端工具** —— 就是本 bug 的成因,已实测 503.
- **只发官方工具,丢弃客户端全部工具** —— 客户端声明的工具会静默消失,
  用户以为声明了能调,实际没发出去;映射能保住大部分(见下).
- **把映射目标取代码里的 `OFFICIAL_TOOL_PARAMETER_KEYS`** —— **实测踩过**:
  那个手写表与真实抓包只有约 12/37 重叠,映射出 `ask_user` 这种上游不认的名字,
  仍然 503.真值只能来自抓包.
- **不做上行还原** —— 下游拿到的 `tool_calls[].function.name` 是官方名
  (`write_file`),它自己不认识,无法派发.用户明确要求"双向映射".
- **只在非流式响应上还原** —— 上游 chat 恒 `stream: true`,等于没还原(实测).
- **什么都不做** —— 带工具即 503,dsh 这类客户端完全不可用.

## Consequences

- **映射不到的客户端工具在该链路不可用**(丢弃 + `[tool-map] dropped ...` 日志).
  这是刻意的取舍:保链路可用 > 保单个工具.
- **每个带工具的请求多一次 Map 查**(下行)+ 一次 SSE 逐行 JSON 解析(上行).
  无额外上游请求.
- **`OFFICIAL_TOOL_PARAMETER_KEYS` 仍与抓包不符**(28 项幽灵名 / 缺 25 项真名).
  本次**未改它**(它还被签名判据用),但已明确:**凡涉及"官方工具名真值"的判据
  一律以抓包为准**.这是一笔已知债务,收拢它需要单独评估签名判据的影响.
- **`npm test` 新增一节** `verify-tool-name-mapping.mjs`(90 条断言).

## Evidence

**真实端到端(本地,同一条已付费会话,边际成本 0)**:

```
不带工具                → HTTP 200
带 20 个第三方工具       → HTTP 200 + finish_reason: "tool_calls"   ← 目标达成
```

**双向映射实证**(`/tmp/dsh-min.json`:只声明 `write`):

```
下行（dump 出站请求体）：tools 里是 write_file（官方名）
上行（客户端收到）：    tool_call name = write        ← 已还原成 dsh 声明的名字
HTTP = 200
```

**逐字段 dump 对比**(`FREEBUFF_DUMP_DIR`):出站 `bodyUtf8` 里
`tools[].function.name` **全部是真实抓包的官方名**(唯一例外 `ask_user` 已在
本次修正为 `ask_questions`).

**门禁**:`npm test` 全绿(新增 90 条工具映射断言,判据 = 真实抓包);
typecheck 过.

## Correction

本次纠正了我自己的三处错误:
1. 先写死 `bash → run_terminal_command` 等映射,但目标取自**代码里的手写表**
   (含幽灵名 `ask_user`)—— 测试当场抓出"目标不在官方清单里".
2. 断言 `skill` 不在官方清单里 —— 测试抓出它在抓包里.
3. 只处理 `message.tool_calls` 做上行还原,漏掉 SSE 的 `delta.tool_calls`
   —— 实测 `changed: false` 才发现.

## 重大更正:映射不到的**不是丢弃,而是原样保留**(2026-10-05 实测证伪)

用户问:[dsh 它去调用的话,能够兼容吗?......一些外部的工具,如果上来的话,
它能兼容吗?]——查下来发现**旧策略是错的**.

### 实测

统计 dsh 的 44 个工具:**只有 14 个能映射到官方等价物,30 个(68%)被丢弃**.
即 `git_status` / `memory_save` / `subagent` / `send_message` / `job_output` ...
这些**静默消失**,模型永远看不到它们(用户以为声明了能调).

于是做了**单变量实测**:声明 8 个**官方完全不存在**的工具名
(`memory_save` / `memory_search` / `git_status` / `git_diff` / `subagent` /
`job_list` / `send_message` / `list_agents`),出站 **45 个工具**
(官方 37 + 这 8 个),上游回 **HTTP 200**.

**结论:上游并不因为"工具名官方没有"就拒绝请求.**

### 更正后的策略

```
有官方等价物  → 映射过去（bash → run_terminal_command）
              —— 让上游按官方语义理解，且保留指纹对齐
无官方等价物  → **原样保留**（不改名、不丢弃）
              —— 模型至少看得见它，能按 schema 生成 tool_call，
                 由客户端自己执行（本代理不执行工具，只转发）
```

`mergeOfficialTools` 里 `if (!mapped)` 分支从 `continue`(丢弃)改为
`list.push(t)`(保留),`dropped` 出参及对应日志一并清理;
新增 `[tool-map] renamed N / kept-as-is M` 观测日志.

### 反向探针

把该分支改回丢弃 → `test/verify-tool-name-mapping.mjs` 的
[映射不到的客户端工具必须 list.push 原样保留(不得丢弃)]断言变红(已实测).

### 伴随的致命回归:`mapped` 未声明(同日修复)

改这一分支时把 `const mapped = MAP_TOOLS[n] || null;` **整行删掉了**,
分支与后面却仍在用 `mapped` —— 而 `node --check`(仓库 typecheck/test 里唯一的
静态门禁)**只查语法,抓不到 ReferenceError**,于是它一路进了远程镜像.

远程后果(2026-10-04T18:52:34Z):55 个工具一进来,`mergeOfficialTools` 在
第一轮循环即抛 `ReferenceError: mapped is not defined` → bun 侧整轮失败 →
`official channel rpc failed` → 降级 legacy → chat 428 → 用户看到
[花了 15 点,一次没用上].

**教训:源码正则断言(本 note 的 ⑥)挡不住"代码能编译但不能运行".**
本次补了一条**真执行**断言 —— 把 `MAP_TOOLS` 与 `mergeOfficialTools` 源码
抽进同一作用域后 `new Function(...)` 构造并实际调用;任何未声明变量都会立刻抛
`ReferenceError`.反向探针:删掉那行 `const mapped` → 该断言以
`ReferenceError: mapped is not defined` 变红(已实测),而 `node --check` 仍然通过.

### 这次更正说明什么

**"上游会因为陌生工具名拒绝"是一个未经验证的推断,而它导致 68% 的工具被丢弃.**
本仓的纪律是"结论必须来自实测"(见 AGENTS.md[按症状查文档]的验证方法论)——
这条纪律正是为了拦住这类推断.旧实现里那句
[官方没有等价物 → 丢弃,绝不原样发出]的注释,写的是信心而非证据.
