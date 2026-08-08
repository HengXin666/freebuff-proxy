# freebuff-proxy

OpenAI 兼容的 **Freebuff 授权反代**。

下游 Agent 只需要标准的 `base_url + api_key + model`；本服务负责：

1. Freebuff / Codebuff **身份凭证**
2. **免费 session 准入**（`/api/v1/freebuff/session`）
3. 在请求中注入 `cost_mode=free` 与 `freebuff_instance_id`
4. **流式 / 非流式响应原样透传**

## 快速开始

```bash
cd freebuff-proxy
npm install
cp config.example.yaml config.yaml
# 编辑 config.yaml：
#   - 可选 server.api_keys（Agent 访问反代的门禁；本机可留空）
#   - 上游：npm run login → credentials/<email>.json（可多次 login 多账号）

npm run login
npm start
```

健康检查：

```bash
curl -s http://172.17.0.1:28287/healthz
```

## 下游 Agent 接入

调用示例（模型由 Agent 决定）：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-proxy-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-5.6-luna",
    "stream": true,
    "messages": [{"role":"user","content":"你好"}]
  }'
```

## 行为说明

### 授权

- **Freebuff 上游**：仅 `npm run login` → `credentials/<email>.json`（请求带 `Authorization` + `x-codebuff-api-key`）
- **Agent → 反代**：配置了 `server.api_keys`
- **非 loopback 绑定**：必须配置 `server.api_keys`，否则 `serve` 拒绝启动

### 模型列表

`GET /v1/models` 返回 Freebuff **线上 model id**（无别名），例如：

- `deepseek/deepseek-v4-flash`
- `deepseek/deepseek-v4-pro`
- `openai/gpt-5.6-luna`
- `minimax/minimax-m3`
- `mimo/mimo-v2.5`
- `z-ai/glm-5.2`（邀请解锁）

响应为 OpenAI 兼容 `{ object: "list", data: [...] }`。条目含非标准字段 `pool` / `available` / `access_tiers` 供 Agent 选择。若能探测到当前账号 `accessTier=limited`，full-only 模型会标 `available: false`。

### Session

对 `POST /v1/chat/completions`：

1. 读取请求里的 `model`（必填）
2. 自动 `POST /api/v1/freebuff/session`（按该 model 占 1 小时槽）
3. 注入：

```json
{
  "model": "<upstream-model>",
  "codebuff_metadata": {
    "cost_mode": "free",
    "freebuff_instance_id": "<instanceId>",
    "run_id": "...",
    "client_id": "..."
  }
}
```

4. 其余字段 **原样保留** 转发到 `https://codebuff.com/api/v1/chat/completions`
5. 上游响应（含 SSE 流）**原样写回**

换模型时会先释放旧 session 再 admit 新 model。

session gate（`session_expired` / `session_superseded` / waiting room 等）会自动 re-admit **一次**（可配置 `limits.max_auto_retry_on_session_error`）。

### 其它路由

| 路径 | 作用 |
|------|------|
| `GET /healthz` | 存活 |
| `GET /v1/models` | Freebuff 可用模型目录（线上 id；可带当前 access tier） |
| `GET /v1/freebuff/status` | 当前用户与 session 快照 |
| `GET /v1/freebuff/accounts` | 账号列表与冷却状态 |
| `POST /v1/freebuff/session/end` | 释放 session |
| `POST /v1/chat/completions` | 主路径（session + 透传） |
| `* /v1/*`（非 chat） | 映射到上游 `/api/v1/*`，只注入 Freebuff 鉴权 |

## 凭据（多账号 · 单轨）

```text
credentials/
  you@example.com.json
```

```bash
npm run login    # 每号一次 → credentials/<email>.json
```

**自动切号**：每个补全请求按可用性选号；`rate_limited` / `spend_limited` / `banned` 等整号冷却并换下一个；`model_unavailable` 仅冷却该 model。对下游透明。

## 命令

```bash
npm start        # 启动反代
npm run login    # 浏览器登录并保存凭据
npm run doctor   # 检查配置 / 凭据 / 上游连通
npm test
```

可选：`node bin/*.js --config /path/to.yaml`。

## 配置

见 [config.example.yaml](./config.example.yaml)。

| 项 | 唯一来源 |
|----|----------|
| Freebuff 登录态 | `npm run login` → `credentials/<email>.json` |
| Agent 门禁 | `server.api_keys`（可选；非 loopback 必填） |
| 上游 API/登录 URL | `upstream.api_base` / `login_base` |
| 监听地址 | `server.host` / `port`（可用 `FREEBUFF_PROXY_HOST`/`PORT` 覆盖） |
| 并发上限 | `limits.max_concurrent_requests`（仅 chat completions） |
| 配置文件路径 | 默认 `./config.yaml` 或 `FREEBUFF_PROXY_CONFIG` |

## 限制（官方免费层现实）

- Luna 等 premium：大约每天 6×1 小时 session（共享 premium 池）
- Flash：CLI full 访问下次数更松，仍有 spend / IP / 容量限制
- 同账号多端会 `superseded`
- 地区 / VPN / 封禁由上游决定
- 本项目 **不** 绕过风控，也 **不** 保证无限额度

协议细节见 `../freebuff-api-notes/`。
