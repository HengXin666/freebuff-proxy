# 下游 Agent 接入与开放 API

> 本文是 [freebuff-proxy](../README.md) 的详细文档之一。chat/completions 行为、全部路由表、开放 API 批量导入/删除账号。
> 快速上手 / 一键部署请看 [主页 README](../README.md)。
## 下游 Agent 接入

调用示例（模型由 Agent 决定，`base_url` 指向本服务，API Key 用 Web 用户自己的 Key 或 `server.api_keys`）：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-fb-xxxxxxxx（控制台里你自己的 Key）" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "stream": true,
    "messages": [{"role":"user","content":"你好"}]
  }'
```

### 行为说明

- **授权**：`server.api_keys`（超级 Key）或 Web 用户 API Key 均可；非 loopback 绑定且两者皆无时拒绝启动。
- **模型列表**：`GET /v1/models` 返回 Freebuff 线上 model id（含 `pool` / `available` / `access_tiers` 等附加字段），例如：
  - `deepseek/deepseek-v4-flash`（daily）
  - `deepseek/deepseek-v4-pro`（premium）
  - `openai/gpt-5.6-luna`（premium）
  - `minimax/minimax-m3`（premium）
  - `mimo/mimo-v2.5`（daily）
- **Session**：`POST /v1/chat/completions` 自动按 model 复用或占用 1 小时 free session、注入
  `codebuff_metadata.{cost_mode=free, freebuff_instance_id, run_id, client_id}`，其余字段原样透传；
  同一个 session 支持并发 chat 流；
  遇到 `session_expired` / `session_superseded` / waiting room 等 gate 自动 re-admit 一次（`limits.max_auto_retry_on_session_error`）。
- **其它路由**：

  | 路径 | 作用 |
  |------|------|
  | `GET /healthz` | 存活探针 |
  | `GET /v1/models` | 可用模型目录 |
  | `GET /v1/freebuff/status` | 当前账号与 session 快照 |
  | `GET /v1/freebuff/accounts` | 账号列表与冷却状态 |
  | `POST /v1/freebuff/accounts/import` | **开放 API 导入账号**（Bearer API Key，单/批量，导入后自动探测预热） |
  | `DELETE /v1/freebuff/accounts` | **开放 API 删除账号**（按 email/id/key，空 body 清空全部） |
  | `POST /v1/freebuff/session/end` | 释放全部 session |
  | `POST /v1/chat/completions` | 主路径（session + 透传） |
  | `* /v1/*`（非 chat） | 映射到上游 `/api/v1/*`，只注入 Freebuff 鉴权 |

### 开放 API 账号导入（Open API）

`/v1` 面新增账号管理端点，与下游 Agent 共用同一套 **Bearer API Key**（`server.api_keys` 超级 Key 或 Web 用户自己的 `sk-fb-...`），无需登录控制台即可脚本化运维账号池。

**导入账号** `POST /v1/freebuff/accounts/import`：

```bash
# 单个账号
curl http://127.0.0.1:8787/v1/freebuff/accounts/import \
  -H "Authorization: Bearer sk-fb-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","authToken":"<freebuff CLI token>","id":"<freebuff 用户ID（可选）>","name":"<昵称（可选）>"}'

# 批量导入（数组 或 {"accounts":[...]} 或 {"json":"..."}）
curl http://127.0.0.1:8787/v1/freebuff/accounts/import \
  -H "Authorization: Bearer sk-fb-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d @accounts.json   # [{"email":...,"authToken":...}, ...]
```

- `authToken` 即 Freebuff 登录令牌（Web 会话 `__Secure-next-auth.session-token` 值，或 CLI 登录返回的 token，二者对上游 API 均有效，`/api/v1/me` 实测 200）。
- 带 `id` 可避免 GitHub/Google 同邮箱账号互相覆盖（按 `id` 存文件）；不带则按邮箱。
- 导入后自动 `invalidate` 旧缓存 + 只读探测刷新（不占额度）。
- 响应 `{ok, imported:[{key,email,id}], failures, total}`。

**删除账号** `DELETE /v1/freebuff/accounts`：

```bash
# 按 email / id / key 删除单个
curl -X DELETE http://127.0.0.1:8787/v1/freebuff/accounts \
  -H "Authorization: Bearer sk-fb-xxxxxxxx" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'

# 空 body = 清空所有账号（先释放 session 再删凭据）
curl -X DELETE http://127.0.0.1:8787/v1/freebuff/accounts \
  -H "Authorization: Bearer sk-fb-xxxxxxxx"
```

> 也兼容旧格式 `{"email":"...","authToken":"..."}`（Web 端粘贴导入）。
