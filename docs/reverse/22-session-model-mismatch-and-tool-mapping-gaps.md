# 22 -- `session_model_mismatch` 预警的真因 与 下游工具调用失败的三处缺口

> 取证时间 2026-10-05 20:00-20:20,远程部署 `https://freebuff.woa.qzz.io`(`2.2.0` / commit `2a35844`).
> 全部结论来自**远程运行日志**与**本地会话记录**,不是源码推断.

---

## 22.1 问题一:409 `session_model_mismatch` 为什么出现,又为什么"忽略后照样能用"

### 现象(用户原话)

> 你看一下远程日志为啥会出现警告,我把警告忽略了的话,它还是能继续调用的.

### 铁证:同一次请求里,主服务算出的模型与 bun 子进程实际用的模型不一致

`reqId=ea7b362d`(2026-10-05T12:00:16 → 12:00:33)完整链路:

```
12:00:16 selected account for model key=88f8583c reusedSession=true model=m-096e75164d
12:00:23 started agent run agent=base3-free-catalog
12:00:23 chat forward model resolved requested=m-096e75164d sessionModel=m-096e75164d
 assigned=m-096e75164d
 outgoing=fbm1.AAEAAUPu6mpo1qluTgl... ← 主服务用的是 deepseek 的 handle
12:00:33 official channel: rpc result status=409 model=MiMo 2.6 Flash ← bun 侧自己抓的 row 是 MiMo
12:00:33 upstream chat non-ok 409 session_model_mismatch
 "This session is bound to deepseek/deepseek-v4-flash"
```

同一模型在远程日志里出现过**两种 handle**:

```
(model=m-096e75164d, assigned=m-096e75164d) -> handle 种类数 = 2
 fbm1.AAEAAUPu6mpo1qluTgl... (11:56:45 - 12:00:23)
 fbm1.AAEAAUPvzJ2N62f3bmy... (12:01:41 - 12:02:32)
```

### 根因:`handle` 不可跨抓取使用,而主服务与 bun 子进程各抓各的

`docs/reverse/19-catalog-is-the-model-list.md` §19.3 早已实测:

- `key`(`m-096e75164d`)/ `displayName` / `legacyDigests` ---- **稳定不变**
- `handle`(`fbm1.xxx`)---- **每次抓取全量轮换**,只有 `fetchId` 那次抓取内有效

而当前架构里,一次 chat 的模型标识来自**两次互相独立的目录抓取**:

| 阶段 | 谁执行 | 用什么标识 |
|---|---|---|
| admission(建会话) | 主服务 `CatalogHolder` | 它那次抓取的 `handleFor(key)` |
| chat(发消息) | bun 子进程 `actions.actReuse` | 它**自己重抓**目录后 `pickRow()` 得到的 row |

`cli-bridge/bridge.ts` 的 `callBun()` **每次请求 spawn 一个新 bun 子进程**,所以
`cli-bridge/serve/api/catalog.ts` 里那个**进程内** TTL 缓存(`CATALOG_TTL_MS = 10 分钟`)
在 `reuse` 路径上等于不存在 ---- 每个请求都是一次全新抓取.

于是当上游对同一 `instanceId` 的新抓取返回了**新的 handle** 时:

- 会话按 admission 那一刻的 handle 绑定;
- chat 却用新抓取的 handle 去问;
- 上游回 `409 session_model_mismatch`,并用 `message` 自证绑的仍是最初那个
 (`deepseek/deepseek-v4-flash` ---- 与请求模型**同一个**,不是用户说的"换错了模型").

### 为什么"忽略警告仍能继续调用"

这是两个叠加的效应,不是矛盾:

1. **上游多数时候容忍**. 12:00:33 前后约 20 个请求里只有这一个是 409,其余全
 `status=200 model=DeepSeek V4.1 Flash`. handle 轮换发生在同一个 `version` 内时,
 上游仍认它是这条会话的模型标识 ---- 匹配是按语义做的,不是按字节.
2. **本地把它当"可恢复闸门"重试**. `src/proxy/transport/errors/normalize.ts` 第 84 行把
 `session_model_mismatch` 归入 `isSessionRecoverableGate`,回
 `switchAccount:false / recoverable:true`;`src/proxy/chat/run/errors.ts` 第 86-102 行
 据此安排 **同号 re-admit 一次**. 下一次请求重新走一遍 admit + 重抓,handle 重新对齐,
 于是又 200 了.

所以"忽略它"并不是绕过检测,而是**这条重试路径确实把它救回来了** ---- 代价是白烧一次
尝试机会,并在日志里留下一串 `warn`. 真正的问题在于它本不该发生.

### 加重因素:`pickRow` 的静默回落

`cli-bridge/lib/upstream/actions.ts`:

```ts
function pickRow(bridge, input) {
 const rows = bridge.catalog.rows
 return rows.find((r) => r.key === input.modelKey)
 || rows.find((r) => r.handle === input.modelKey)
 || rows[0] // ← 静默回落第一行
}
```

`modelKey` 传的是 **handle**(`src/proxy/transport/official.ts` 第 59 行 `modelKey: forwardBody.model`,
而 `forwardBody.model` 在 `forward-body.ts` 第 141-144 行已被 `catalog.handleFor()` 翻成 handle).

一旦匹配不上(不同抓取的 handle 天然不同),它**不报错**,而是静默取
`rows[0]` ---- 而远程目录第一行正是 **MiMo 2.6 Flash**,与日志里
`rpc result ... model=MiMo 2.6 Flash` 逐字吻合. 这把一个"应该 400 的编程错误"
伪装成了一次看起来正常的请求,并在最坏情况下真的用错模型.

### 修复方向(未落盘,理由见 §22.4)

1. `pickRow` 匹配不到时必须**失败**(去掉 `|| rows[0]`),让错误在日志里可见.
2. `rpcReuse` 的 `modelKey` 改传**目录 key**(`m-xxx`)而不是 handle ----
 或者由主服务把 admission 那次抓取的 handle **一并下传**给 bun,
 禁止 bun 在 `reuse` 路径上重新抓目录. 两者择一,不要两边都抓.
3. `handle` 明确标注为**单次抓取票据**,任何跨进程/跨请求的持有都是缺陷.

---

## 22.2 问题二:下游工具调用失败的三处缺口

统计口径:本地 dsh 会话记录(`~/.dsh/sessions/<项目>/session-*.jsonl`,共 62 个会话),
`tool/result` 里 `isError=true` 共 **148** 条,按 (工具, 错误头) 聚合:

| 次数 | 工具 | 错误 |
|---|---|---|
| 23 | bash | `UNKNOWN: unknown error, write` |
| 13 | run_code | `code run failed (exception): Expected ',', got 'ident'` |
| 11 | edit | `old_string was not found` |
| 8 | bash | `tool call aborted` |
| 4 | read | `invalid arguments: missing required property "file_path"` |
| 3 | glob | `glob could not start its search command (ripgrep launch failed)` |
| 3 | ls | `unknown tool "ls"` |
| 1 | -- | `unknown tool ""` |

其中第 4,7,8 行是**本仓映射层造成的**,不是客户端或环境的锅.

### 缺口 A:回程只还原工具名,不还原参数 ---- 下游收到"自己的名字 + 别人的参数"

链路实际行为(已离线复现):

1. `cli-bridge/lib/tool-map.ts` 的 `mergeOfficialTools(official, clientTools)` 把下游工具
 按官方优先去重,并把有等价物的改成官方名:

 ```
 read → read_files
 ```

 官方 37 工具里**本来就有** `read_files`,于是下游声明的 `read` **被丢弃**,
 发出的是官方 `read_files`(参数 `paths`).

2. 上游按官方 schema 生成调用,回程 `unmapToolCallsInBody()`(只改 `function.name`)把它还原成:

 ```json
 {"name":"read","arguments":"{\"paths\":[\"src/x.ts\",\"src/y.ts\"]}"}
 ```

3. 下游 dsh 的 `read` 只认 `file_path` → `missing required property "file_path"`.

实测参数对照(**官方 vs 下游,逐项不同**):

| 下游工具 | 下游必填参数 | 官方等价物 | 官方必填参数 |
|---|---|---|---|
| read | `file_path` | read_files | `paths` |
| write | `file_path`, `content` | write_file | `path`, `instructions`, `content` |
| edit | `file_path`, `old_string`, `new_string` | str_replace | `path`, `replacements[]` |

这三对恰好是**改动频率最高的三个工具**,所以症状最显眼.
`edit` 报的是 `old_string was not found` ---- 因为它的 `old_string` 落在了官方
`replacements[].oldString` 的位置之外,下游找不到那个字段.

### 缺口 B:回程会生成下游从未声明的"幽灵别名"

`unmapToolCallsInBody()` 用的是**全表反向映射** `UNMAP_TOOLS`
(`foreign-client-signals.ts` 第 213 行把 `CLIENT_TO_OFFICIAL_TOOL` 整体反转),
它**不看下游本次到底声明了什么**.

于是只要模型调了 `list_directory`,回程就被改名成 `ls` ---- 而下游(如 dsh)根本没声明 `ls`.

实测可被生成的幽灵别名(下游未声明, 却可能出现在回程 `tool_calls` 里):

```
shell, sh, run_command, execute_command, terminal, apply_patch, create_file,
cat, read_file, find, ls, list_dir, fetch, curl, search
```

对照 `unknown tool "ls"` 那 3 条:参数是 `{"path":"."}` / `{"path":"src/proxy/routes/responses"}`
---- 正是 `list_directory` 的 schema,名字被改成了下游不认识的 `ls`.
(那几条发生在迁 TS 之前的旧会话,当时 `ls` 还在上游 foreign 名集里;
现在上游认 `list_directory` 了,但**回程生成幽灵别名这条路径依旧存在**. )

`cli-bridge/lib/tool-map.ts` 的 `unmapToolCalls(body, unmappedNames)` 已经支持
"本次实际用过的映射"(第 147-149 行),但 `tool-map.ts` 在 `cli-bridge/` 里,
**主服务(Node)侧根本 import 不到**;Node 侧只有 `foreign-client-signals.ts` 的
全表版本. 同一张表两处实现,只有一处带了"本次声明"这个过滤条件.

### 缺口 C:同一官方名对应多个下游名时,还原目标是猜测的

`UNMAP_TOOLS` 的反转取**表内第一个声明**:

```js
if (!acc[official]) acc[official] = client
```

`read_files` 会被还原成 `read` ---- 但如果下游声明的是 `cat` 或 `read_file`,
回程照样给 `read`. 这也是缺口 B 的同一种病:还原目标必须取自**本次请求实际声明的名字**,
而不是表里恰好排第一的那个.

### 修复方向(未落盘,理由见 §22.4)

1. **上行还原必须带"本次声明的工具名集合"**:只把官方名还原成下游**这次真的声明过**
 的那个客户端名;声明集里没有的,保持官方原名(下游会看到陌生的官方名并明确报错,
 好过收到一个它不认识的别名).
2. **参数必须在映射时一并翻译**:`mergeOfficialTools` 改写工具名时,同时把下游 schema
 翻成官方 schema(或反过来);回程按同一张表翻回来. 只改 `function.name` 而放着
 参数形态不管,就是缺口 A.
3. **两侧映射表合并为一份**,带 `declaredNames` 运行时过滤,消灭漂移.

---

## 22.3 与远程日志的交叉验证

远程日志(2026-10-05T11:53:38 - 12:07:08,469 条)里的相关行:

```
11:56:23 warn device signer NOT created hasDeviceKeyPath=false hasAccountId=false
11:56:23 warn catalog fetch rejected status=401
11:56:45 warn session admitted on limited tier account=llh282000500@gmail.com
 countryCode=US reason=recent_limited_country
11:56:56 warn upstream may treat request as a foreign client
 signal=foreign_toolset toolCount=55
```

- `foreign_toolset / toolCount: 55` 是**本地可观测性提示**,不是上游判据
 (`docs/reverse/18` §4.1 已明确). 它每个请求都打,不代表请求被拒.
- `device signer NOT created` + `catalog fetch rejected 401` 出现在 11:56:23,
 早于 11:56:45 那次成功 admit ---- 属于启动早期的凭据自检,不影响后续链路.

---

## 22.4 本轮为什么没有落盘源码改动

改这三处(§22.1 的 handle 传递, §22.2 的参数翻译与声明集过滤)都会动
`cli-bridge/lib/tool-map.ts` / `cli-bridge/lib/upstream/actions.ts` /
`src/proxy/transport/forward-body.ts` ---- 按 `AGENTS.md` 属于**受保护源码**,
同一次提交必须带 Agent Note,并且提交前必须过:

```
npm test && npm run typecheck && npm run check:gates && npm run check:all
```

本轮**环境的 `bash` 与 `glob` 通道故障**(`Error: UNKNOWN: unknown error, write` /
`ripgrep launch failed`),与 §22.2 表格里那 23+3 条失败**是同一类**;
`read` / `edit` / `write` 正常,**不能执行任何命令**.

在这条门禁跑不了的前提下改受保护源码,等于把未经验证的改动推给用户 ----
违反 `AGENTS.md` 的"结论必须来自实测"与"提交前必须全过". 所以本轮交付**诊断与修改方案**,
把落地动作留给环境恢复后的下一轮.

---

## 22.5 复现命令(环境恢复后照做)

```bash
# 1) 落盘前后都能跑的离线复现(零额度消耗)
node /tmp/verify-toolparam.mjs
# -> 下行 tools 只剩官方 read_files
# -> 回程 name=read 但 args={"paths":[...]}
# -> list_directory 回程变成 ls

# 2) handle 轮换复现(远程)
curl -s -b /tmp/rc2.txt "https://freebuff.woa.qzz.io/api/logs?limit=2000" \
| python3 -c "import json,sys;ls=json.load(sys.stdin)['lines'];\
print({(l.get('model'),l.get('assigned')) for l in ls if l.get('msg')=='chat forward model resolved'})"

# 3) 门禁(改动落地后必跑)
npm test && npm run typecheck && npm run check:gates
```
