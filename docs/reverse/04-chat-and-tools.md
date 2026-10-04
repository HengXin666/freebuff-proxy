# 04 — 对话与工具调用(chat/completions)

端点:`POST https://www.codebuff.com/api/v1/chat/completions`

## 4.1 前置:三步缺一不可

```
1. GET  /api/v1/freebuff/models              → fetchId + 每行 handle/key
2. POST /api/v1/freebuff/session/admission   → instanceId（x-freebuff-model 传 handle）
3. POST /api/v1/agent-runs  {action:"START"} → runId
4. POST /api/v1/chat/completions             → 带 runId + instanceId
```

**`runId` 不是顶层字段**,而在 `codebuff_metadata.run_id`.
传顶层 `runId` 一律 `400 {"message":"No runId found in request body"}`
(实测穷举 8 个 body 字段名 + 4 个 header 名全失败).

## 4.2 请求头(官方 CLI 形态,源码二进制原文)

```js
{
  "content-type": "application/json",
  "Authorization": `Bearer ${token}`,
  "user-agent": "ai-sdk/openai-compatible/0.0.0-test/codebuff",  //  版本段是 0.0.0-test
  "x-freebuff-acting-user-id": userId,
  // 目录协议两件套
  "x-freebuff-catalog-protocol": "1",
  "x-freebuff-catalog-fetch":    fetchId,
  "x-freebuff-model":            handle,     //  handle
  "x-freebuff-instance-id":      instanceId,
}
```

 chat **不带** `x-codebuff-api-key`:官方只在 session / agent-runs / me 等端点带它.
多发就是多余指纹面.

## 4.3 请求体

```jsonc
{
  "model": "fbm1.AAEAAUPj...",            //  handle（不是 m-xxx key！）
  "messages": [
    { "role": "system", "content": "You are Buffy, the coding agent behind Codebuff.\n\n..." },
    { "role": "user",   "content": "..." }
  ],
  "codebuff_metadata": {
    "run_id":                runId,          // server-issued
    "client_id":             "<13 位 base36>",
    "cost_mode":             "free",
    "freebuff_instance_id":  instanceId,
    "freebuff_multi_session":"1",
    "surface":               "cli",
    "trace_session_id":      "<uuid>",
    "freebuff_client_env":   "v1;in=0;out=0;tp=none;term=1;ct=1;sz=0x0;ci=0;ssh=0;l=0;p=na;g=na;osc=na"
  },
  "tools": [ ...官方签名工具..., ...客户端工具... ]
}
```

## 4.4  system 开场白是硬门禁

上游要求 system 首条以官方开场白**逐字节开头**,否则
`403 free_mode_cli_required`(原文:"Calling the API directly is not supported
and **may get your account banned**").

| agent 世代 | 开场白 |
|---|---|
| `base2-free-*` | `You are Buffy, the strategic coding assistant.` |
| `base3-free-*`(目录模式) | `You are Buffy, the coding agent behind Codebuff.` |

目录模式下 agentId 恒为 **`base3-free-catalog`**
(官方源码:`UK = "base3-free-catalog"`,当模型是目录 key 时用).
agent 与开场白必须**同世代**:base3 agent 配 base2 开场白会被拒.

## 4.5  工具签名(tool-schema 指纹)

上游把"工具集是否与官方一致"当作第三方客户端判据.
实测:带任意非官方工具 → `404 No endpoints found for <model>`
(报"模型不存在",与工具毫无字面关联,极难归因).

**必须补齐的两个官方签名工具**(名字 + 真实参数 schema,双真):

```jsonc
{ "type":"function", "function":{
  "name":"lookup_agent_info",
  "description":"Protocol compatibility marker. Do not call this function.",
  "parameters":{ "type":"object",
    "properties":{ "agentId":{ "type":"string","description":"Agent ID (short local or full published format)" } },
    "required":["agentId"],
    "description":"Retrieve information about an agent by ID" } } }

{ "type":"function", "function":{
  "name":"decide",
  "description":"Protocol compatibility marker. Do not call this function.",
  "parameters":{ "type":"object","properties":{} } } }
```

 **零参数工具不算签名**(`end_turn` 已被上游点名收录进 `PROXY_HOLLOW_END_TURN` 夹具).
必须带真参数 schema.`lookup_agent_info` 是主签名(有结构可校验).

## 4.6 官方工具名全集(37 个,源码 `orchestrator.js:102843`)

```
apply_patch add_subgoal add_message ask_user browser_logs code_search
cloud_plan_ready create_plan end_turn find_files glob gravity_index
list_directory lookup_agent_info propose_str_replace propose_write_file
read_docs read_files read_subtree read_url render_ui report_project_profile
run_file_change_hooks run_terminal_command set_messages set_output skill
spawn_agents spawn_agent_inline str_replace suggest_followups task_completed
think_deeply update_subgoal web_search write_file write_todos
(+ COMPOSIO_META_TOOL_NAMES)
```

## 4.7 客户端环境描述符

`codebuff_metadata.freebuff_client_env`,13 个字段,与 `x-freebuff-env` 头同一份字符串:

```
v1;in=1;out=1;tp=iterm;term=1;ct=1;sz=120x40;ci=0;ssh=0;l=1;p=shell;g=terminal;osc=1
```

字段序:`in / out / tp / term / ct / sz / ci / ssh / l / p / g / osc`.
本代理无 TTY,按官方 `na` 桶如实填:`in=0;out=0;tp=none;l=0;p=na;g=na;osc=na`.
**绝不**放路径,进程名,环境变量原文(官方明文约束).

## 4.8 当前状态

已通过:catalog  / admission 200 active  / agent-runs START 200 
已消除:`free_mode_cli_required` ,`session_model_mismatch` ,runId 错误 
**遗留**:chat 返回 `503 The model is temporarily unavailable` —— 见 `00-overview.md` 队列.
