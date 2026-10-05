# Agent Note: 参数翻译必须幂等且不吞字段, 多 harness 工具名要一并映射, 控制台首屏要回灌账本

Status: implemented

## Problem

三处独立缺陷, 都由真实会话轨迹与离线复现钉死, 不是猜测.

### 一, 参数翻译不幂等: 上游回了下游形态时反而把字段吞掉

`src/upstream/signals/param-map.ts` 的 `write` 规则只认官方字段 `path`:

```
write: { fields: { path: { to: 'file_path' }, content: { to: 'content' } } }
```

上游偶尔直接回下游 schema 的字段名(`file_path`). 此时 `file_path` 落在 `src` 里
没人接, 翻译结果变成:

```
{"file_path":"a.txt","content":"hi"}  ->  {"content":"hi"}     # file_path 被吞
```

下游 `write` 的 `required` 是 `['file_path','content']`, 于是报
`missing required property "file_path"`. 这正是 2026-10-05 会话里
`write` 连续失败 4 次(`args={"content":"probe-line\n"}`)的成因.

### 二, `todo_write` 没有参数规则, 官方元素形态原样回给下游

官方 `write_todos` 的元素是 `{task, completed}`, 下游 dsh 的 `todo_write`
要的是 `{content, status}`(status 是三态枚举). 旧表里没有这条规则, 官方形态
原样透传, 下游报:

```
Error: invalid arguments: missing required property "todos[0].content";
       missing required property "todos[0].status"
```

同一会话实测命中两次. 注释里原先写的"同形的(ask_questions / write_todos)不在这里"
是错的 ---- 名字相同不等于形态相同.

### 三, 只映射了本机 harness, 其它 harness 的工具名仍按外来客户端露出

本代理要同时服务 dsh / Claude Code / Codex 等下游. 旧映射表只有 39 条, 全是
小写短名. Claude Code 的 `Read` / `Bash` / `TodoWrite`, Codex 的 `shell` /
`apply_patch` / `exec_command` 都不在表里, 于是落到 MCP 载体通道
(`proxy__Read` 之类) 原样发出去 ---- 而这些名字本身就在上游的外来客户端判据
`FOREIGN_HARNESS_TOOL_NAMES` 里, 会触发 `foreign_tool_names` 判定.

也就是说: 下游换成 Claude Code / Codex, 工具调用仍能跑(载体通道兜住了), 但
请求形态暴露了"这是外来 harness".

### 四, 控制台首屏读不到上次缓存的账号状态

`src/context/ops/account-list.ts` 原先写 `this.byKey.get(a.key)` ---- 直接读
Map. 而 `freebucks` / `quota` / `lastProbe` 只挂在**创建出来的** runtime 上,
由 `_hydrateRuntime` 从 `/data/account-state.json` 回灌. 服务重启后 `byKey`
是空的, 首屏于是把这三个字段全读成 `null`:

```
byKey(冷): 0
旧写法 byKey.get -> runtime: null, freebucks: null, quota: null
```

用户必须手动点一次刷新(那一跳会走 `get()` 建出 runtime)才看得到状态. 这就是
"首次打开网页拿不到上次缓存的账号状态"的根因.

## Decision

1. **`translateParamsForDownstream` 增加旁路保留**: 上游参数里已经是下游形态的
   字段, 只要下游 schema 在 `properties` 里声明过, 就原样留下. 判据是[下游认识],
   不是[规则里没有]; 规则已消费的源字段不得回头再加(否则官方名与下游名会同时出现).
2. **补 `todo_write` 规则**: `todos[].task -> content`, `completed -> status`
   (`true` 落 `completed`, `false` 落 `pending`). 已是下游形态时原样保留,
   包含 `in_progress` 这种三态值.
3. **规则表按职责切出**: `PARAM_RULES` 与两个接口搬到
   `src/upstream/signals/tools/param-rules.ts`(126 行), `param-map.ts` 只留
   翻译引擎(185 行). 切分原因是原文件加规则后到 306 行, 撞了 300 行硬红线.
4. **映射表扩到多 harness**: 在 `CLIENT_TO_OFFICIAL_TOOL` 补 17 条 ----
   Claude Code(`Bash`/`Read`/`Write`/`Edit`/`MultiEdit`/`Glob`/`Grep`/`LS`/
   `TodoWrite`/`WebFetch`/`WebSearch`/`AskUserQuestion`),
   Cursor(`StrReplace`/`Shell`/`AskQuestion`),
   Codex(`exec_command`), opencode(`todowrite`/`webfetch`).
   名字形态取自本仓已有的上游判据镜像
   (`FOREIGN_HARNESS_TOOL_NAMES_BY_HARNESS`), 不另行猜测.
   没有官方等价物的一律不进表(`Task`/`NotebookEdit`/`read_lints` 之类),
   硬凑官方名等于篡改语义 ---- 它们继续走载体通道.
5. **新增 `runtimeFor(key)`**: 只读展示专用的容错入口 ---- 内部走 `get()`
   (懒创建 + 账本回灌), 失败返回 `null` 而不是抛. 控制台账号表改用它.
   回灌只读账本, 不发上游请求, 与[零自动探测]不冲突.

## Alternatives considered

- **什么都不做**: 四条都已在真实会话里造成用户可见失败(`write` 4 次,
  `todo_write` 2 次, 换 harness 即露形态, 首屏必须手动刷新), 且用户明确点名要修.
- **把旁路保留改成[规则里没有的字段一律放行]**: 那会把上游的多余字段
  (`instructions` 之类)泄给下游, 而下游普遍声明 `additionalProperties: false`,
  多一个键整条被判非法. 必须按下游 schema 的 `properties` 过滤.
- **只修 `write` 一条规则, 不加通用旁路**: `str_replace` 的 `path` / `read_files`
  的 `paths` 都存在同类风险(上游若直接回 `file_path`, 规则会把它当未知字段丢掉).
  通用旁路一次覆盖全部规则, 且判据集中一处.
- **给 `todo_write` 也走通用旁路而不写规则**: 元素级字段名不同(`task` vs
  `content`), 不是顶层键改名能解决的, 必须有逐元素转换规则.
- **把官方 37 工具里下游没有对应物的那些从出站列表删掉**: 官方工具集是指纹对齐
  的一部分(docs/reverse/18 §4.1), 删掉会改变请求形态; 且模型的选择空间会缩小.
  本次不动工具集, 只补等价名映射.
- **`runtimeFor` 直接改成让 `list()` 调 `get()`**: `get()` 在凭据不可用时抛异常,
  会让整张账号表崩掉 ---- 控制台应当对坏账号容错渲染. 容错入口是必要的.
- **在前端做首屏兜底(先读缓存再刷新)**: 后端返回的就是 `null`, 前端没有可兜的
  数据. 必须在产生它的地方修.

## Consequences

- 有翻译规则的工具, 无论上游回官方形态还是下游形态, 结果都正确(幂等).
- 下游换成 Claude Code / Codex / Cursor / opencode 时, 核心工具名会映射到官方
  等价物, 不再以载体形态暴露 harness 身份. 无等价物的工具照旧走载体通道.
- 映射表是唯一真源: Node 侧 `src/upstream/signals/tool-name-map.ts` 与 bun 侧
  `cli-bridge/lib/tool-map.ts` 必须逐条一致, `tool-name-mapping.ts` 有断言.
- 控制台首屏现在会按需建 runtime. 每个账号一次懒创建 = 一次读凭据 + 建上游
  客户端对象, 都是本地 IO, 不发请求.
- 规则表搬到子目录后 `src/upstream/signals/` 回到 5 个文件(目录红线).

## Evidence

离线复现(真模块 + 本次会话真实声明的 55 个工具):

```
write 官方形态 : write {"file_path":"a.txt","content":"hi"}
write 下游形态 : write {"content":"hi","file_path":"a.txt"}   <- 修复前只有一个 key
todo_write 官方: {"todos":[{"content":"a","status":"completed"},{"content":"b","status":"pending"}]}
```

多 harness:

```
Claude Code 声明集 -> 全部映射到官方(载体数 0)
  run_terminal_command -> Bash    read_files -> Read    write_file -> Write
  write_todos -> TodoWrite        list_directory -> LS
Codex 声明集 -> shell -> run_terminal_command, apply_patch -> str_replace
```

控制台首屏(冷启动, 不预热):

```
修复前 byKey.get   -> freebucks: null, quota.byModel: 0 个模型
修复后 runtimeFor  -> freebucks: 有,   quota.byModel: 6 个模型
```

反向探针(先破坏实现, 确认断言变红, 再还原 ---- 五条全部实测):

```
关掉旁路保留        -> tool-restore-declared exit 1
删 todo_write 规则  -> tool-restore-declared exit 1
删 claude 等价名    -> tool-restore-declared exit 1
account-list 改回裸读 -> dashboard-cold-start-state exit 1
还原后              -> 两条套件全绿
```

门禁与测试:

```
node scripts/gates/run.ts  -> ALL PASS (17/17 条)
npm run typecheck          -> 通过
tool-name-mapping          -> 119 断言通过
tool-restore-declared      -> 101 断言通过
dashboard-cold-start-state -> 新增, 10 断言通过
```
