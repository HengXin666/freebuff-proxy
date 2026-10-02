# 10 — 第三方实现考究：lza6/Freebuff-2API

> 考究对象：https://github.com/lza6/Freebuff-2API（Rust 实现，多端：cfworker / desktop / browser-extension / legacy-go）
> 结论：**拒绝采纳**。它走的是我们**早已走过并证伪**的路径（伪装/换栈），
> 且缺协议关键件；其模型列表是本地静态快照而非目录协议。

## 10.1 它做对了什么（值得承认）

它的 `REVERSE_ENGINEERING.md`（248 行）质量很高，三条实测结论与我们独立得出的**一致**，可互为佐证：

1. **四端点链路**：session → agent-runs(START) → chat/completions（注入 `codebuff_metadata`）→ agent-runs(FINISH)。
2. **`run_id` 必须在 `codebuff_metadata` 里**（它明确写了四个字段：`run_id` / `cost_mode` / `client_id` / `freebuff_instance_id`）。
3. **`free_mode_cli_required` 不是 HTTP 头层能绕过的**：它实测 UA 伪装成 `Freebuff-CLI/0.0.105`、补全套 Origin/Referer/Host 头，**全部无效**。

第 3 条尤其有价值——它从另一个方向（Cloudflare Worker）撞到同一个结论，
与我们的实测（缺 system 开场白 + 工具签名才触发 `cli_required`）互补：
**头伪装无用，判据在别处**。

它还记了两条我们没踩但将来会踩的坑：
- `ancestorRunIds` 必须 `[]` 不能 `null`（Go nil 序列化坑），否则 400 `Invalid request body`。
- `free_mode_invalid_agent_hierarchy`：子 run 的祖先只能指根 run，不能塞兄弟 id。

## 10.2 但它缺什么（致命）

| 协议件 | 本仓库 | lza6 | 后果 |
|---|---|---|---|
| **system 开场白** | base2 + base3 双版本 | **完全没有**（grep "Buffy" 零命中） | 必撞 `free_mode_cli_required` |
| **设备签名 Ed25519** | 已实现 | **完全没有** | 请求形态缺官方必带件 |
| **catalog 协议** | 已实现，动态拉目录 | **本地静态快照**（`models.rs` 硬编码 + 快照合并） | 模型 id 与上游实际放行脱节 |
| agent id | `base3-free-catalog`（目录模式） | `base2-free` 写死 | 旧世代，不适配目录模式 |
| 工具签名补全 | 已实现（`lookup_agent_info` + `decide`） | **没有**，原样转发 body | 带 tools 必撞 tool-schema 判据 |

**最关键的一点**：它 `upstream.rs:280` 的 `chat_completions` 只是把 body
原样 `.json(&body)` 发出去，注入 metadata 后**对 tools 不做任何补全**。
而我们实测：带任意非官方工具 → `404 No endpoints found for <model>`，
必须补齐官方签名工具（带真参数 schema）才过。

所以它对"工具调用"的支持是**协议转换层**的（Claude `tool_use` ↔ OpenAI
`tool_calls` 互转，`api.rs:4086-4150` 写得很完整），
但**上游那一跳能否真的产出 tool_calls，它没有证明**。
README 通篇不提上游工具能力，`REVERSE_ENGINEERING.md` 也只讲文本链路。

## 10.3 它的破局点是"换 TLS 栈"，这条路我们不做

它 §三 的结论：

> "检测不在 HTTP 头层，而在 **TLS 指纹层**（Client Hello / JA3）。
> Cloudflare Worker 的 fetch 用 Cloudflare 自己的 TLS 栈……无法通过改头绕过。
> **破局点**：本地 Go 二进制用的是 Go 原生 TLS 栈，指纹不在上游黑名单里，直接通过。"

即它的解法是**换一门语言的 TLS 栈来规避指纹黑名单**。

这与本仓库的定位红线冲突（AGENTS.md：「只做免费链路」「不顺带提定位之外的替代方案」），
而且与我们的实测证据相反：

- 我们实测的封禁是**账号级**（`status: banned`），换栈换出口都救不回来。
- 它自己撞到的 `free_mode_cli_required`，我们已定位真因是
  **system 开场白 + 工具签名缺失**，不是 TLS ——
  它把"换栈后通过了"误归因成"TLS 指纹过关"，
  很可能是换栈的同时别的行为模式也变了（或当时上游判据更松）。

**结论：它是"绕过检测"的思路，我们是"对齐官方协议"的思路。方向不同，不抄。**

## 10.4 可借鉴（仅此）

1. `ancestorRunIds: []` vs `null` 的坑 —— 若本仓库将来支持子 run，这条要记住。
2. `free_mode_invalid_agent_hierarchy` 的 run 树约束 —— 同上。
3. 上游 200 响应体**内嵌** `free_mode_*` 错误码的检测（`upstream_body_error`）：
   它对 200 也扫错误串。本仓库是否有等价处理需确认，若无则值得补
   —— 上游可能 200 回执里夹错误。

## 10.5 裁决

**拒绝采纳。** 理由：

1. 缺 system 开场白与设备签名 —— 带工具请求必需的两件。
2. 模型列表是静态快照，不是目录协议 —— 与上游实际放行脱节。
3. 核心思路是换 TLS 栈绕过检测，与我们的协议对齐路线相反，
   且与"封禁是账号级"的实测证据矛盾。
4. 上游工具调用能力未证明。

**继续沿本仓库现有协议链路推进。**
