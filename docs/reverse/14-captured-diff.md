# 14 — 抓包实证：官方客户端 vs 我们的请求（逐字段 diff）

> 方法：用 `HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=...` 启动官方客户端
>（`--proxy-server` 对 bun 子进程无效，只有渲染进程的广告请求会走），
> 再用 mitmproxy 解密。抓到 `POST /api/v1/chat/completions → 200` 的真实样本
> （请求体 19338 / 20316 字节）。
>
> **本章全程只操作客户端 UI，未从代理侧发任何上游请求。**

## 14.1 官方 chat 请求体顶层结构

```jsonc
{
  "model": "fbm1.AAEAAUPkLF6H...",       // catalog handle
  "codebuff_metadata": { ... },
  "provider": { "allow_fallbacks": true },   // ⚠️ 我们没有
  "messages": [ system(13417 字符), user, ... ],
  "tools": [ decide ],                        // ⚠️ 只有 1 个
  "tool_choice": "auto",                      // ⚠️ 我们没有
  "stream": true                              // ⚠️ 我们用 false
}
```

**没有** `temperature` / `max_tokens` / `stop` / `reasoning_effort`（这些是 undefined）。

## 14.2 逐字段 diff（官方 desktop vs 我们的 cli-bridge）

| 字段 | 官方 desktop | 我们 | 判定 |
|---|---|---|---|
| **system 开场白** | `You are Buffy, the auto-run agent behind Freebuff Desktop. You decide what one tab does next.`（**13417 字符**，含 mission / workspace state / transcript） | `You are Buffy, the coding agent behind Codebuff.`（base3 **CLI** 版） | ❌ **错的世代与身份** |
| `provider` | `{"allow_fallbacks": true}` | 无 | ❌ 缺 |
| `tool_choice` | `"auto"` | 无 | ❌ 缺 |
| `stream` | `true` | `false` | ❌ 不一致 |
| `tools` | 1 个 `decide`（带完整参数 `read/decision/why/input/declined/expectedGain`） | `lookup_agent_info` + `decide` + 用户工具 | ❌ 形态不同 |
| metadata 键 | `freebuff_instance_id, freebuff_multi_session, trace_session_id, **repo_snapshot**, **llm_step_number**, run_id, client_id, cost_mode` | 多了 `surface`、`freebuff_client_env`；少了 `repo_snapshot`、`llm_step_number` | ❌ 双向不一致 |
| chat UA | `ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2` | `ai-sdk/openai-compatible/0.0.0-test/codebuff`（少两段） | ❌ 不完整 |
| admission 额外头 | `x-fb-timezone: Asia/Shanghai`、`x-freebuff-desktop-attempt-id: <uuid>` | 无 | ❌ 缺两个 |
| admission UA | `Bun/1.4.2` | （未发该头形态） | ❌ |

## 14.3 ⚠️ 核心结论：我们混用了「CLI 协议」与「desktop 会话」

这是用户怀疑的"web 端协议冲突"的**实质**（不是 web，是 CLI vs desktop）：

- 我们的 `system` 用的是 **base3 CLI** 的开场白（"coding agent behind Codebuff"）。
- 但我们的会话是用 **desktop** 身份建的（`x-freebuff-client: desktop`、
  admission 走 desktop 的槽位/购买流程）。
- 官方 desktop 的实际开场白是**完全不同的一句**（"auto-run agent behind
  Freebuff Desktop"），而且长达 13KB，内含 mission、workspace state、
  transcript summary、resource evidence 等。

**身份自相矛盾 → 上游判定异常 → 428 / 503 / 封号。**

这解释了一件事：为什么我们改 `surface` 从 `cli` 到 `desktop` 也没用 ——
我们改的只是 metadata 里一个官方**根本没有**的键（`surface` 不在官方
metadata 键集里），真正的开场白一直是 CLI 那句。

## 14.4 附带确认

- 客户端工具调用真实生效：操作 UI 发"创建文件"后，
  `/tmp/capture-proof.txt` 真实落盘（17 字节 `captured-by-mitm`）。
- 抓到的两次 chat 都是 **auto-run 决策调用**（`tools: [decide]`），
  不是用户对话轮次；用户对话轮次的请求体尚未抓到（需继续观察）。
- 官方 metadata **没有** `freebuff_client_env` 与 `surface` ——
  这两个是我们从 CLI 文档/第三方实现抄来的，desktop 侧不用。

## 14.5 修正清单（按优先级）

1. **system 开场白**：改用 desktop 的 auto-run 版本（且它带大段上下文，
   不是一句固定文本 —— 需要研究其模板来源）。
2. 补 `provider: { allow_fallbacks: true }`、`tool_choice: "auto"`、`stream: true`。
3. 补 `repo_snapshot`、`llm_step_number`；移除 `surface`、`freebuff_client_env`。
4. chat UA 补完整三段。
5. admission 补 `x-fb-timezone`、`x-freebuff-desktop-attempt-id`。

## 14.6 复现命令

```bash
# mitm 必须用 request 钩子才能拿到请求体（流式响应不缓存）
mitmdump -s dump2.py -p 8899 --set confdir=~/.mitmfreebuff --set body_size_limit=1m
# 客户端必须用环境变量代理（--proxy-server 对 bun 无效）
env HTTP_PROXY=http://127.0.0.1:8899 HTTPS_PROXY=http://127.0.0.1:8899 \
    ./Freebuff-*.AppImage --remote-debugging-port=9333 --ignore-certificate-errors
```
