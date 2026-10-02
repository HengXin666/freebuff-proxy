# 15 — 协议复核：官方抓包 vs 我们的实现（逐字段）

> 复核对象：
> - **真值**：`docs/reverse/captures/2026-10-03-official-client.jsonl`（88 行，8 个 chat/completions 样本）
> - **待检**：`cli-bridge/upstream.mjs`（当前代码）+ `docs/reverse/captures/dump1..dump4/`（旧版实现的逐字节快照）
> - **资产**：`official-tools.json`（37 工具）、`official-system-prompts.json`（manager 13443 字符 / worker 7918 字符）
>
> 方法：只做本地只读解析，未向 codebuff.com / freebuff.com 发任何请求。
> 所有结论均标注 jsonl **行号**（0-based，与 `CAPTURE-SUMMARY.md` 的 `[n]` 编号一致）。

---

## 0. 先读这段：dump 与当前代码不是同一版（避免误报）

`dump1..dump4` 是**修复前**的旧版快照，与当前 `upstream.mjs` 已经是两套东西。证据：
- dump3 `004-chat.json` 的 UA 是 `ai-sdk/openai-compatible/0.0.0-test/codebuff`（短版），无 `provider` / `tool_choice`，`stream:false`，metadata 里带 `surface` 与 `freebuff_client_env` —— 与 `14-captured-diff.md` §14.2 描述的旧版完全吻合。
- 当前 `upstream.mjs:383-384` 已是三段 UA，`upstream.mjs:370-376` 已有 `provider` / `tool_choice` / `stream`，`upstream.mjs:346-364` 的 metadata 已移除 `surface` / `freebuff_client_env` 并补了 `repo_snapshot` / `llm_step_number`。

所以下面的 A/B/C 分两栏给：**「旧版 dump」**与**「当前代码」**。修正清单（D 章）只对**当前代码仍未对齐**的项开药。

---

## A. 逐字段差异表（按阶段）

### A.0 通用约定

官方请求里有一批头是 **bun 运行时自动加的**，不属于业务头，对比时应排除：
`Connection: keep-alive`、`Host`、`Accept: */*`、`Accept-Encoding: gzip, deflate, br, zstd`、`Content-Length`。
我们当前代码显式发了一个 `accept: */*`（`upstream.mjs:380`），与官方自动值相同，属无害冗余。

---

### A.1 catalog（GET /api/v1/freebuff/models）

| 项 | 官方 | 我们 | 判定 |
|---|---|---|---|
| 请求是否存在于抓包 | **不存在** | 有 | ⚠️ **证据缺口** |

抓包全文检索 `freebuff/models` 命中 **0 次**（88 行全量 grep）。catalog 请求发生在客户端进程启动早期，早于 mitm 挂载，因此**这一跳没有真值可比对**。
当前 `upstream.mjs:179-183` 只发 `Authorization` + `x-freebuff-catalog-protocol: 1` + 设备签名三头。
⚠️ 结论：**catalog 这一跳的头部正确性目前无法用本次抓包证实或证伪**，任何"已对齐"的说法都缺证据。要补真值需重启客户端后重抓。

---

### A.2 admission（POST /api/v1/freebuff/session/admission）

真值行号：**line 8**（request）、line 10（response 200）、line 34/54（后续重买）。

**官方完整头部（line 8，逐项）**：

| 头 | 值 |
|---|---|
| `Authorization` | `Bearer 0cd9d1d3-...` |
| `x-fb-timezone` | `Asia/Shanghai` |
| `x-freebuff-catalog-fetch` | `fbf1.AAGq0C5lYSih...` |
| `x-freebuff-catalog-protocol` | `1` |
| `x-freebuff-client` | `desktop` |
| `x-freebuff-desktop-attempt-id` | `0ba618c7-27f4-4f5e-97f9-b8bbfed5937d` |
| `x-freebuff-device-key` | `YP21Eug4HHmST2REeo2iBn` |
| `x-freebuff-device-sig` | `o8sBmZEmQGwCuWje...` |
| `x-freebuff-device-ts` | `1790965858915` |
| `x-freebuff-first-tab-discount` | `0` |
| `x-freebuff-install-id` | `5a989c7b-c374-41bb-aecc-ba47e4a3a2b3` |
| `x-freebuff-instance-id` | `e1be7199-331e-4622-b5a9-0a2cfe8aecc1` |
| `x-freebuff-model` | `fbm1.AAEAAUPkLF6HpwLl...`（handle） |
| `x-freebuff-multi-session` | `1` |
| `x-freebuff-purchase-continuity` | `1` |
| `x-freebuff-wallet-spend-limit` | `0` |

**我们的（当前 `upstream.mjs:246-262`）**：

| 头 | 官方 | 我们 | 严重度 | 说明 |
|---|---|---|---|---|
| `x-fb-timezone` | ✅ 有 | ❌ **无** | **高** | 抓包里出现 12 次（session/admission 恒定带）。`03-session-admission.md` §3.2 也写了 `freebucksTimeZoneHeaders()`，但代码没发 |
| `x-freebuff-desktop-attempt-id` | ✅ 有（每次新 UUID） | ❌ **无** | **高** | 抓包 6 次。line 8 = `0ba618c7...`、line 54 = `471ab8ff...`，**每次不同**。它的语义是"一次购买尝试"，与退款/槽位判定直接相关（见 §E.3） |
| `x-freebuff-instance-id` | `e1be7199-331e-4622-b5a9-0a2cfe8aecc1`（**裸 UUID**） | `cli:<uuid>` | **高** | ⚠️ 官方**从无 `cli:` 前缀**，且 line 8 / 34 / 54 三次 admission **复用同一个** `e1be7199`。我们是每次新建 `cli:` id —— 见 §E.1，这直接对应"购买被退款作废" |
| `x-freebuff-takeover-instance-id` | 抓包 0 次 | 我们有（`upstream.mjs:259`） | 中 | 官方源码常量存在，但**本次抓包从未出现**，属推测性实现 |
| `x-freebuff-catalog-protocol` / `-fetch` / `client` / `install-id` / `model` / `wallet-spend-limit` / `first-tab-discount` / `purchase-continuity` / `multi-session` | ✅ | ✅ | — | 一致 |
| 设备签名三头 | ✅ | ✅ | — | 一致（若配置给了 keyId/privateKey） |

**旧版 dump（`dump2/002-admit-0.json`）额外确认**：同样缺 `x-fb-timezone` 与 `x-freebuff-desktop-attempt-id`，且 instance 是 `cli:ef2d2765-...`。

---

### A.3 agent-runs（POST /api/v1/agent-runs）

真值行号：**line 11**（START）、line 32（FINISH）、line 36（START）、line 58、65、74。

**官方完整头部（line 11，逐项）**：

| 头 | 值 |
|---|---|
| `Authorization` | `Bearer 0cd9d1d3-...` |
| `x-freebuff-acting-user-id` | `ce620a8c-f4a2-4973-85e7-435950d6a988` |
| `Content-Type` | `application/json` |

**就这三个业务头。没有别的。**

| 头 | 官方 | 我们（`upstream.mjs:285-292`） | 严重度 |
|---|---|---|---|
| `x-codebuff-api-key` | ❌ **无** | ✅ 有（值=token） | **中** | 抓包全文 `x-codebuff-api-key` 命中 **0 次**。这是我们唯一一处主动多发它；`04-chat-and-tools.md` §4.2 也警告过"多发就是多余指纹面" |
| `x-freebuff-catalog-protocol` | ❌ 无 | ✅ 有 | 低 |
| `x-freebuff-catalog-fetch` | ❌ 无 | ✅ 有 | 低 |
| 设备签名三头 | ❌ **无** | ✅ 有 | 低 | agent-runs 官方不签名（6 个样本全部无签名头） |
| `x-freebuff-acting-user-id` | ✅ | ✅ | — |

**请求体对比（决定性）**：

| 字段 | 官方 | 我们 | 严重度 |
|---|---|---|---|
| `agentId` | line 11/58 = **`freebuff-desktop-autorun`**；line 36 = **`freebuff-desktop-thread-local-v3`** | `base3-free-catalog`（`upstream.mjs:282` 默认） | **高** |
| `ancestorRunIds` | `[]` | `[]` | — |
| `action` | `START` / `FINISH` | 只发 `START` | **中** |

⚠️ `base3-free-catalog` 是 **CLI 世代**的 agentId（来自 `04-chat-and-tools.md` §4.4）。官方 desktop 用的是 `freebuff-desktop-autorun`（manager 决策层）与 `freebuff-desktop-thread-local-v3`（worker 对话层），**两个不同的 agentId 对应两层**。这是"协议混用"的第三处实证（前两处是 system 开场白与 metadata 键）。

**FINISH 缺失**：line 32/65/74 官方在完成时回写 FINISH，带 `totalSteps`、`status:"completed"`、以及每步的 `messageId`（如 `chatcmpl-b5d11c1e`）。我们只 START 不 FINISH —— run 在上游悬挂，且 `agent-runs` 的步数/消息 ID 闭环断裂。

---

### A.4 chat（POST /api/v1/chat/completions）

真值行号：manager 层 = **line 14 / 26 / 60 / 72**；worker 层 = **line 38 / 42 / 45 / 56**。
8 个样本的头部集合**完全一致**（已逐个校验，diff 为空集）。

**官方完整头部（line 14，逐项）**：

| 头 | 值 |
|---|---|
| `Authorization` | `Bearer 0cd9d1d3-...` |
| `Content-Type` | `application/json` |
| `User-Agent` | `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2` |
| `x-freebuff-acting-user-id` | `ce620a8c-f4a2-4973-85e7-435950d6a988` |
| `x-freebuff-catalog-fetch` | `fbf1.AAGq0C5lYSih...` |
| `x-freebuff-device-key` | `YP21Eug4HHmST2REeo2iBn` |
| `x-freebuff-device-sig` | `6i9jKBK8qzGnoKzQ...`（每次不同） |
| `x-freebuff-device-ts` | `1790965859441` |

**这就是全部。官方 chat 只有 8 个业务头。**

| 头 | 官方 | 我们（`upstream.mjs:378-393`） | 严重度 |
|---|---|---|---|
| `x-freebuff-instance-id` | ❌ **无**（在 metadata 里） | ✅ 有 | **高** | 官方把实例标识放在 `codebuff_metadata.freebuff_instance_id`，**不在头部** |
| `x-freebuff-model` | ❌ **无** | ✅ 有 | **高** | 官方 chat 头不带 model（model 只在请求体顶层） |
| `x-freebuff-catalog-protocol` | ❌ **无** | ✅ 有 | **高** | ⚠️ 官方 chat **不带**协议版本头，只带 `catalog-fetch` |
| `x-freebuff-client` | ❌ **无** | ✅ 有 | 中 | 抓包 18 次出现，但**全在 session/admission，chat 一次没有** |
| `x-freebuff-install-id` | ❌ **无** | ✅ 有 | 中 | 同上 |
| `user-agent` | 三段完整 | ✅ 三段完整 | — | 当前代码已修（旧版 dump 是短版） |
| `x-freebuff-catalog-fetch` | ✅ | ✅ | — | 一致 |
| `x-freebuff-acting-user-id` | ✅ | ✅ | — | 一致 |
| 设备签名三头 | ✅ | ✅ | — | 一致 |

⚠️ **方向性结论**：头部这一项我们不是"少了"，而是**多了 5 个**。`04-chat-and-tools.md` §4.2 列的 chat 头清单（含 `x-freebuff-catalog-protocol` / `x-freebuff-model` / `x-freebuff-instance-id`）**与官方抓包矛盾**，那份清单是从 CLI 文档推的，desktop 侧不成立。

---

### A.5 GET session（附带核对）

- 普通查询（line 1/4/5/6/7）：带 `x-fb-timezone`、`x-freebuff-include-unused-rate-limits: 1`。
- 心跳（line 17/29/82）：**改带 `x-freebuff-heartbeat: 1`，且不带 `x-fb-timezone`**，也不带 `include-unused-rate-limits`。

当前 `upstream.mjs:192-208` 的 `getSession()` **两种混在一起发**（同时带 `include-unused-rate-limits` 又无 heartbeat），且缺 `x-fb-timezone`。严重度：中（影响 session 状态判读，不直接导致 chat 失败）。

---

## B. 请求体结构对比

### B.1 顶层字段集合

官方 8 个样本的顶层键**恒为 7 个**（已逐个校验）：

```
model, codebuff_metadata, provider, messages, tools, tool_choice, stream
```

| 顶层键 | 官方 | 当前代码 | 判定 |
|---|---|---|---|
| `model` | handle `fbm1.AAEAAUPkLF6H...` | `row.handle` | ✅ |
| `codebuff_metadata` | ✅ | ✅ | ✅ |
| `provider` | ✅ | ✅ | ✅ 已按层区分 |
| `messages` | ✅ | ✅ | 结构差异见 B.4 |
| `tools` | ✅ | ✅ | **内容**差异见 B.3 |
| `tool_choice` | ✅ | ✅ 硬编码 `auto` | ⚠️ 见下 |
| `stream` | `true`（全部 8 个） | 默认 `true` | ✅ |
| `temperature` / `max_tokens` / `stop` / `reasoning_effort` | **全部不存在** | 无 | ✅ |

⚠️ **没有顶层 `reasoning_effort`** —— 见 C 章。

⚠️ `tool_choice` 不是恒为 `auto`：line 14/26/38/42/45/60/72 = `auto`，但 **line 56 = `"required"`**（worker 第 4 步，强制收口调工具）。当前 `upstream.mjs:375` 硬编码 `auto`。严重度：中（会在"模型该收尾却继续说话"的场景行为偏离）。

### B.2 `codebuff_metadata` 键集合

**官方 9 键（worker 层，line 38）**：

```json
{
  "freebuff_instance_id":     "e1be7199-331e-4622-b5a9-0a2cfe8aecc1",
  "freebuff_multi_session":   "1",
  "freebuff_reasoning_effort":"max",
  "trace_session_id":         "6b5550f5-5127-4d45-bc98-1056e520b10e",
  "repo_snapshot":            "{\"gitAvailable\":false,...}",
  "llm_step_number":          "1",
  "run_id":                   "15a99052-1d8e-43f0-8ee9-b058344cb17e",
  "client_id":                "92jgxqouweo",
  "cost_mode":                "free"
}
```

**官方 8 键（manager 层，line 14）** = 上面去掉 `freebuff_reasoning_effort`。

| 键 | 官方 | 当前代码 | 严重度 |
|---|---|---|---|
| `surface` | ❌ 不存在 | ✅ 已移除 | ✅ 已修（旧 dump 有） |
| `freebuff_client_env` | ❌ 不存在 | ✅ 已移除 | ✅ 已修（旧 dump 有） |
| `repo_snapshot` | ✅ JSON **字符串** | ✅ 有（硬编码全 0） | **中**，见下 |
| `llm_step_number` | ✅ 字符串，**随轮次递增** | ✅ 但**硬编码 `"1"`** | **中** |
| `freebuff_reasoning_effort` | ✅ 仅 worker 层 | ✅ 条件加入 | ✅ |
| `trace_session_id` | ✅ **同一 run 内恒定** | ❌ 每次 `crypto.randomUUID()` | **中** |
| `client_id` | 11 位 base36（`0mrb3znwuim` / `92jgxqouweo` / `2qgozlgk45r`） | `Math.random().toString(36).slice(2,15)` → 长度不定（≤13） | 低 |
| `run_id` / `cost_mode` / `freebuff_instance_id` / `freebuff_multi_session` | ✅ | ✅ | ✅ |

**`repo_snapshot` 的真实取值（关键）**：

- manager 层（line 14/26）：`fileCount: 0, testFileCount: 0`
- worker 层（line 38/42/45/56）：`{"gitAvailable":false,"repositoryVisibility":"unknown","fileCount":69,"fileCountIsLowerBound":false,"testFileCount":5,"changedFileCount":0,"changedFileScanTruncated":false}`

⚠️ 官方**两层取不同的快照**（manager 是"无仓库"视角，worker 是真实项目 69 文件 / 5 测试文件）。当前 `upstream.mjs:353-361` 统一硬编码 `fileCount: 0` → 若走 worker 层就与官方不符。严重度：中（属于"仓库感知"信号，是上游判断真实客户端的软证据之一）。

**`llm_step_number` 递增实证**：line 38=1 → 42=2 → 45=3 → 56=4（同一个 `run_id: 15a99052`）。manager 同理 line 14=1 → 26=2。当前代码固定 `"1"` → 多轮对话时每一步都声称是第 1 步。

**`trace_session_id` 恒定实证**：line 14 与 line 26 同为 `a43f616d-ad39-487c-a898-7bf57a4d5afb`（run `95125a5e`）；line 38/42/45/56 同为 `6b5550f5-...`（run `15a99052`）。**一个 run 一个 trace id**，不是一次请求一个。

### B.3 `tools` 数组

| 层 | 官方 | 我们 | 严重度 |
|---|---|---|---|
| **manager** | **1 个**：`decide`，**完整真实 schema**（`read` / `decision`(enum run\|stop) / `why` / `input`(含 skill/label/prompt/purpose enum) / `declined` / `expectedGain`(0-3) / `confidence`(0-1) / `evidence`，`required: [decision,why,expectedGain,confidence,evidence]`）—— line 14 | 旧 dump：3 个（含无参 `decide`）。当前代码：`useOfficial` 仅 `layer==='worker'` 时为真，**manager 层回落到调用方传入的 `tools`** | **高** |
| **worker** | **37 个真实工具**（`official-tools.json`，与 line 38 逐字节一致）：`read_files, str_replace, write_file, run_terminal_command, code_search, glob, list_directory, write_todos, run_file_change_hooks, end_turn, web_search, read_url, report_project_profile, suggest_prompts, ask_questions, read_thread_context, request_elevation, register_preview, preview_open, preview_status, preview_close, preview_press, preview_scroll, preview_wait, preview_resize, preview_set_color_scheme, preview_recording_start, preview_recording_stop, preview_snapshot, preview_screenshot, preview_click, preview_type, preview_navigate, preview_evaluate, preview_logs, browser_check, write_doc` | 当前代码 worker 层已加载 `official-tools.json`（`upstream.mjs:336-337`） | ✅ 已修 |

⚠️ **worker 层已对齐、manager 层没有**：`upstream.mjs:336` 的 `useOfficial = layer === 'worker' && ...`。若走 manager 层，`tools` 仍是调用方传的签名工具（无参 `decide` + `lookup_agent_info`）。而 `04-chat-and-tools.md` §4.5 明确写了"零参数工具不算签名，已被上游点名收录进 `PROXY_HOLLOW_END_TURN` 夹具"。

⚠️ 顺带纠正 `04-chat-and-tools.md` §4.6：那份"官方工具名全集 37 个"列的是 **CLI 世代**的名字（`apply_patch` / `add_subgoal` / `spawn_agents` / `think_deeply` ...），与本次抓包的 desktop 37 个**交集很小**。抓包的 37 个里**没有** `apply_patch`、**没有** `lookup_agent_info`、**没有** `think_deeply`；反而有 17 个 `preview_*` 浏览器预览工具。→ **`lookup_agent_info` 在 desktop 世代根本不存在**，把它当"主签名工具"是错的。

工具 schema 粒度差异（旧 dump 实证）：我们的 `write_file` 是 `{path, content}`；官方的是 `{path(相对项目根, minLength 1), instructions, content}` 且带 `$schema: http://json-schema.org/draft-07/schema#` 和长篇 description 示例。→ **工具 schema 逐字段不同**，不只是名字。

### B.4 `messages` 结构

| 项 | 官方 | 我们 | 严重度 |
|---|---|---|---|
| system 开场白（manager） | `You are Buffy, the auto-run agent behind Freebuff Desktop. You decide what one tab does next.` —— **13443 字符** | `official-system-prompts.json.manager` | ✅ 字节一致（实测 `s == manager` 为 True，line 14/26/60/72） |
| system 开场白（worker） | `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: ...` —— **7918 字符**，含 `Current date: October 3, 2026.` | `official-system-prompts.json.worker` | ✅ 字节一致（line 38/42/45/56） |
| system 是否带上下文 | **是**：manager 内含 mission、workspace state、transcript summary、resource evidence、以及末尾 `USER_TURN_MARKER:`；worker 内含 `<repository_stats>` / `<changed_file_paths>` 占位符 + `Current date` | 模板照抄 + `renderWorkerSystem()` 填充日期与空 stats | ⚠️ 见 E.2 |
| system 位置 | `messages[0]`，且**用户不能覆盖**（我们 filter 掉了用户的 system） | ✅ 同 | ✅ |
| user 的 `content` 形态 | manager 层是**数组** `[{"type":"text","text":"# Current state\n\n- effort: 3/5\n..."}]`（line 14 messages[1]，207 字符） | 纯字符串 | 中 |
| assistant 消息 | 带 `reasoning_content` 字段（官方把思考链回灌进历史），部分 `content` 为空串 + `tool_calls` | 无 `reasoning_content` | 中 |
| tool 消息 | `{role:"tool", tool_call_id:"_dxzoLGAPvY", content:"{...}"}` —— tool_call_id 是下划线前缀的 base64ish 短 id | 结构同 | ✅ |

---

## C. 思考强度（reasoning effort）

### C.1 传哪里？—— **`codebuff_metadata.freebuff_reasoning_effort`**，不是顶层

全量 grep 88 行：字符串 `reasoning_effort` 只出现在 **line 38 / 42 / 45 / 56 的 `req_body`**，且**全部 4 处都是 `freebuff_reasoning_effort`（metadata 内）**，顶层 `"reasoning_effort"` 命中 **0 次**。

```jsonc
// line 38 codebuff_metadata（原文片段）
"freebuff_reasoning_effort": "max"
```

且请求体顶层键集合恒为 7 个（B.1），**不含 `reasoning_effort`**。

⚠️ **这与 `05-thinking-effort.md` §5.2 的结论直接冲突**。那份文档说"在**请求体顶层**发 `reasoning_effort`（OpenAI 兼容字段名）"，依据是源码的缓存归一化字段列表。**抓包证伪了它**：desktop 链路走的是 metadata 内的私有键。两者可共存的可能解释是"上游两条归一化路径都认"，但**能被抓包证实的只有 metadata 这一条**。

### C.2 取值域

抓包样本只有 **`"max"`** 一个值（4 次，全部 worker 层）。枚举全集无法从本次抓包证实——只能沿用 `05` §5.1 的源码枚举 `["minimal","low","medium","high","xhigh","max","ultra"]`，并标注**未经抓包证实**。

⚠️ manager 层（line 14/26/60/72）**从不发** `freebuff_reasoning_effort`。即：思考强度是 worker 对话层的属性，manager 决策层不带。

### C.3 与 catalog `efforts` 的关系

- 抓包里 catalog 请求缺失（A.1），所以**"发的值必须落在该模型 `efforts` 数组内"这条规则无法用本次抓包验证**。
- 可确证的只有：`max` 对本次会话绑定的模型（`m-096e75164d`，line 10/57 回执 `model` 字段）是被接受的。
- 建议：继续沿用 `05` §5.5 的"从 catalog 读 `efforts`、未声明则不发"，但**发送位置改为 `codebuff_metadata.freebuff_reasoning_effort`**，且**只在 worker 层发**。

### C.4 与 `normalizeReasoningFields` 的关系

仓库 `src/proxy.js` 的归一化"只能发一个思考字段"仍成立（防的是顶层 `reasoning` + `reasoning_effort` 打架）。但它**不该拦 metadata 里的 `freebuff_reasoning_effort`** —— 那是一个不同命名空间的参数。需确认归一化逻辑不误删 metadata 键。

---

## D. 严重程度排序的修正清单

> "不修就会失败"的判据：该差异落在上游已知的第三方客户端判据面上（工具集指纹 / system 门禁 / 身份头 / agent 世代），或已被历史实测证明会导致 428 / 404 / 403。

### P0 — 不修基本必然失败

| # | 改成什么 | 依据（行号） |
|---|---|---|
| **1** | **chat 头部删掉 5 个**：`x-freebuff-catalog-protocol`、`x-freebuff-model`、`x-freebuff-instance-id`、`x-freebuff-client`、`x-freebuff-install-id`。实例标识改由 `codebuff_metadata.freebuff_instance_id` 承载（已在）。保留：`Authorization` / `Content-Type` / 三段 UA / `x-freebuff-acting-user-id` / `x-freebuff-catalog-fetch` / 设备签名三头。 | line 14 / 26 / 38 / 42 / 45 / 56 / 60 / 72 头部集合恒为 8 项，逐个校验 diff 为空集 |
| **2** | **`x-freebuff-instance-id` 改成裸 UUID，且整个进程生命周期内复用同一个**（不要 `cli:` 前缀，不要每次新建）。admission 与 chat 的 metadata 用**同一个值**。 | line 8 / 34 / 54 三次 admission 全为 `e1be7199-331e-4622-b5a9-0a2cfe8aecc1`；line 38 metadata 同为 `e1be7199` |
| **3** | **agent-runs 的 `agentId` 按层改**：manager → `freebuff-desktop-autorun`；worker → `freebuff-desktop-thread-local-v3`。同时**删掉** `x-codebuff-api-key` / `x-freebuff-catalog-protocol` / `x-freebuff-catalog-fetch` / 设备签名三头。 | line 11 `{"action":"START","agentId":"freebuff-desktop-autorun","ancestorRunIds":[]}`；line 36 `freebuff-desktop-thread-local-v3`；line 11 头部仅 3 个业务头 |
| **4** | **manager 层的 `tools` 必须用官方真实 `decide` schema**（含 `required: [decision, why, expectedGain, confidence, evidence]`，1 个工具，不是 3 个）。删除 `lookup_agent_info` —— 它在 desktop 世代不存在。 | line 14 `tools`（1 个）；line 38 的 37 个工具名中无 `lookup_agent_info` |

### P1 — 大概率影响判定

| # | 改成什么 | 依据（行号） |
|---|---|---|
| **5** | **admission 补 `x-fb-timezone: Asia/Shanghai`** 与 **`x-freebuff-desktop-attempt-id: <每次新 uuid>`**。attempt-id 每次购买尝试独立生成。 | line 8 / 34 / 54 均带 `x-fb-timezone`；`x-freebuff-desktop-attempt-id` line 8 = `0ba618c7...`、line 54 = `471ab8ff...`（不同） |
| **6** | **补 FINISH**：run 结束时 POST agent-runs `{"action":"FINISH","runId":...,"status":"completed","totalSteps":N,"directCredits":0,"totalCredits":0,"steps":[{id,stepNumber,credits,childRunIds,messageId,status,startTime}]}`，`messageId` 取流式响应里的 `chatcmpl-*` id。 | line 32 / 65 / 74（三次 FINISH，均带 steps[].messageId） |
| **7** | **`llm_step_number` 按轮次递增**（字符串 "1","2","3"...），同一 run 内持续累加。 | line 38=1 → 42=2 → 45=3 → 56=4（同 run `15a99052`）；line 14=1 → 26=2 |
| **8** | **`trace_session_id` 一个 run 一个**，不要每请求随机。 | line 14 与 26 同为 `a43f616d-...`；line 38/42/45/56 同为 `6b5550f5-...` |
| **9** | **`repo_snapshot` 分层取值**：manager 层全 0；worker 层填真实项目统计（`fileCount` / `testFileCount` 等），不要统一硬编码 0。 | line 14（fileCount 0）vs line 38（`fileCount:69, testFileCount:5`） |
| **10** | **`reasoning_effort` 只走 `codebuff_metadata.freebuff_reasoning_effort`，且仅 worker 层**。移除任何顶层 `reasoning_effort` 的发送路径。 | line 38/42/45/56 metadata 内；顶层 7 键集合无此字段（grep 顶层命中 0） |

### P2 — 行为偏离，不直接致死

| # | 改成什么 | 依据（行号） |
|---|---|---|
| **11** | **`tool_choice` 不要恒 `auto`**：最后一轮（需强制收口时）用 `"required"`。 | line 56 `tool_choice: "required"`（其余 7 次 `auto`） |
| **12** | **manager 层 user 消息用 content 数组形态** `[{"type":"text","text":...}]`。 | line 14 `messages[1].content` 是数组 |
| **13** | **历史 assistant 消息回灌 `reasoning_content`**，保持与上游的逐字往返。 | line 38 `messages[2]`/`[4]`/`[7]` 等均带 `reasoning_content` |
| **14** | **`getSession()` 拆两种形态**：普通查询带 `x-fb-timezone` + `x-freebuff-include-unused-rate-limits: 1`；心跳改带 `x-freebuff-heartbeat: 1` 且**不带**这两个。 | line 1（查询）vs line 17/29/82（心跳） |
| **15** | **`client_id` 固定 11 位 base36**（当前 `slice(2,15)` 长度不定）。 | line 14 `0mrb3znwuim`、line 38 `92jgxqouweo`、line 60 `2qgozlgk45r` —— 均为 11 位 |

---

## E. 其他可疑点

### E.1 `cli:` 前缀可能是"购买被退款作废"的直接诱因（对 `12-waiting-room-slot-contention.md` 的补证）

`12` §12.2 记录的现象是"我建的每一个会话都在 `desktopRefunds` 里，amount 10 全额退"，当时归因于槽位竞争 + 出口匿名网络，**退款诱因标注为"尚未确定"**。

本次抓包给出一条此前没有的对照事实：

| | 官方 | 我们 |
|---|---|---|
| instance id 形态 | `e1be7199-331e-4622-b5a9-0a2cfe8aecc1`（裸 UUID） | `cli:72b39b8f-8ecc-43ce-b0aa-aa173b6a439c` |
| 是否跨次复用 | **是**（line 8/34/54 三次 admission 同一值） | 否（每次新建） |
| 是否退款 | **`desktopRefunds` 从未出现在官方回执里**（line 10/57 回执无该字段） | 每次全额退 |

官方那个 `e1be7199` 从 line 8 一路用到 line 56 的 metadata，贯穿整场会话。而我们的 `cli:` id 每次 admission 都换 —— 上游的"购买归属"账本（§12.4 记的 `desktopPurchases` / `desktopRefunds`）正是按 instance id 记账的。

**这不是定论**（同 IP 的匿名网络信号仍在，两者未分离变量），但它是**目前唯一能从抓包直接读出的、与"退款"强相关的形态差异**，且成本极低 —— 建议在换出口验证前先把这一项对齐，作为单一变量实验。若换掉 `cli:` 后退款消失，`12` 的根因就从"出口信誉"改判为"实例标识形态"。

### E.2 manager system 资产里嵌着**死任务**，直接复用会喂历史任务给上游

`official-system-prompts.json.manager` 的结尾（13443 字符原文末段）：

```
USER_TURN_MARKER: create file /tmp/user-turn-proof.txt containing the text user-turn-captured.

Call the `decide` tool exactly once. Do not write prose outside the tool call.
```

这是抓包当时那一次真实任务（client 里正在跑的 mission）被渲染进了 prompt。它与 worker 层的 `Current date: October 3, 2026.` 同类，都是**动态渲染产物不是模板**。

⚠️ 当前 `upstream.mjs:338-343` 对 manager 层**不做任何渲染**，直接 `sysTpl` 原样发出 → 每一条走 manager 层的请求都在告诉上游"我要建 `/tmp/user-turn-proof.txt`"。必须把 `USER_TURN_MARKER:` 之后到结尾那一段替换为真实 mission，且标注该资产的**采集时间戳**（`Current date` 会随时间失真，worker 层的日期已由 `renderWorkerSystem` 处理，manager 层没有对应处理）。

### E.3 `x-freebuff-desktop-attempt-id` 的语义值得单独盯

它只在 admission 出现（6 次），每次新值。命名上"attempt"对应"一次购买尝试"——很可能就是上游把"同一次尝试的重试"与"多次独立购买"区分开的键。我们完全没有它，意味着我们的重试（`upstream.mjs:245` 的 0/4/8s 退避循环，最多 5 次 POST）在上游看来可能是**5 次独立购买尝试**而不是 1 次尝试的 5 次重试。这与 §E.1 的"每次都扣退一轮"现象在语义上吻合。

### E.4 我们完全没有"陪伴流量"—— 客户端行为画像缺口

官方客户端在 88 行里除了核心 4 跳，还持续发出：

| 端点 | 行号 | 说明 |
|---|---|---|
| `HEAD /`（探活） | 0/2/15/16/19/20/23/24/27/28/49/50/67/68/78/79/84/85/86/87 | 20 次，UA `Bun/1.4.2` |
| `POST /api/logs`（遥测） | 9/12/39/40/62/63/76/77/80/81 | 带 `version:"0.0.156"`、`surface:"desktop"`、`harnessId:"codebuff"`、各类 `desktop.*` 事件 |
| `GET /api/v1/ads/proposal` | 21/22/69/70 | freebuff.com，带 `workspace` + `surface=desktop` |
| `POST /api/ads` | 43/46/53/61 | freebuff.com |
| `POST /api/v1/ads/impression` | 47/48 | |
| `GET /api/v1/project-profile` | 52/55 | 带 `project_key=local:8b16bd640fa6dbe3855ba6e680fc2639` |

我们的实现只有 4 跳，零遥测、零广告、零 project-profile、零探活。**一个只发核心请求、从不打日志也不拉广告的客户端，在行为画像上是高度异常的**。`04-chat-and-tools.md` §4.5 记录的"带任意非官方工具 → 404 No endpoints found"说明上游确实做形态判定，那么"缺少这一切"同样可能是判据面。

⚠️ 这一项**不建议立刻照抄**（会引入对 `/api/logs` 的上报依赖与隐私面），但应明确记录为画像缺口：若前 4 项 P0/P1 全对齐后仍失败，这是下一层要试的变量。

### E.5 三个"回执事实"附带确认（与协议无关，但影响调度）

- line 10/57 回执：`countryCode: "JP"`、`countryBlockReason: "country_not_allowed"`、`ipPrivacySignals: null`。line 83 追加 `countryVerified: false`、`verificationReason: "region_locked"`。→ 官方客户端自己也在 JP 出口上跑，且**带 `country_not_allowed` 依然拿到 200 active 并完成 8 次 chat**。这说明"国家不允许"这个标记**不阻断**会话 —— 与 `03` §3.6 的"ban 是账号级"是两回事，别把 `countryBlockReason` 当拒绝判据。
- line 10 `prices`：`m-096e75164d: 15`，且 `offPeak` 22:00-06:00 UTC 降到 10。→ 本次会话买的正是这个模型，与 `12` §12.4 记的"账号被钉在 `m-00032eaeec`"不同账号不同命，别把 `requestedModel` 钉死当成普遍规律。
- admission 回执带 `remainingMs`（line 10 = 1659584 ≈ 27.7min，line 57 = 1582004）而 `expiresAt - admittedAt` 是整 1 小时。→ 抓包启动时会话**已经跑了半小时**，即 line 3 的 `status:"none"` 之后 line 8 才买到。这印证 `03` §3.4 的 `purchase_capacity` 排队。

### E.6 与 `04-chat-and-tools.md` 的三处直接矛盾（建议就地修订该文档）

1. §4.2 的 chat 头清单含 `x-freebuff-catalog-protocol` / `x-freebuff-model` / `x-freebuff-instance-id` —— 抓包里 chat **一个都没有**。
2. §4.5 把 `lookup_agent_info` 称为"主签名工具" —— desktop 37 工具里**没有它**。
3. §4.6 的"官方工具名全集 37 个"是 **CLI 世代**名单，与 desktop 的 37 个几乎不重叠。

三者同源：那份文档来自 CLI 源码推断，而本次真值是 desktop 抓包。**以抓包为准**。

### E.7 catalog 一跳无真值（复核边界声明）

如 A.1 所述，`freebuff/models` 在抓包中 0 次命中。本报告的 A.2–A.4 / B / C 章结论均有抓包行号支撑；**唯一无法证实的阶段是 catalog**。当前 `upstream.mjs:177-190` 的 catalog 实现（只带 `Authorization` + `catalog-protocol` + 签名）**状态未定**，不是"已确认正确"。

---

## F. 复核边界

- 全程只读本地文件，未向 codebuff.com / freebuff.com / 任何上游发请求。
- 未修改 `cli-bridge/` 与 `src/` 下任何文件；本报告是本次唯一新增文件。
- 所有"官方"结论来自单一抓包样本（1 个账号、1 个客户端版本 v0.0.156、1 个时段）。`freebuff_reasoning_effort` 的取值域、catalog 阶段头部、manager 层 tools 在其它任务类型下是否恒为 1 个 `decide`，均**只有单一样本支撑**，属可证伪项。
