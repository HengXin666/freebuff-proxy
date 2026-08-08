# freebuff-proxy

OpenAI 兼容的 **Freebuff / Codebuff 免费额度反向代理**，支持 **多账号自动切号**、**按用户粘性会话**、**Web 控制台**（用户管理 + 浏览器登录回调）、**上游代理**，并附带 **一键 Docker Compose 部署** 与 **GitHub Actions 镜像构建**。

下游 Agent 只需要标准的 `base_url + api_key + model`，本服务负责：

1. Freebuff / Codebuff **身份凭证**（多账号池）
2. **免费 session 准入**（`/api/v1/freebuff/session`）
3. 在请求中注入 `cost_mode=free` 与 `freebuff_instance_id`
4. **流式 / 非流式响应原样透传**

---

## 目录

- [一键部署（Docker Compose）](#一键部署docker-compose)
- [数据与持久化（/data 挂载）](#数据与持久化data-挂载)
- [GitHub Actions 自动构建镜像](#github-actions-自动构建镜像)
- [Web 控制台：登录 / 用户管理 / 添加账号回调](#web-控制台登录--用户管理--添加账号回调)
- [多账号池与粘性会话](#多账号池与粘性会话)
- [代理支持](#代理支持)
- [下游 Agent 接入](#下游-agent-接入)
- [命令 / 本地开发](#命令--本地开发)
- [配置参考](#配置参考)
- [限制](#限制)

---

## 一键部署（Docker Compose）

镜像非常轻量：`node:22-alpine` + 仅 2 个 JS 运行时依赖（`undici` / `yaml`），整体约几十 MB。

```bash
git clone https://github.com/HengXin666/freebuff-proxy.git
cd freebuff-proxy

# （可选）按需配置管理员密码、代理、端口
cp .env.example .env
# 编辑 .env：建议设置 ADMIN_PASSWORD

# 一键启动（自动拉取 GHCR 预构建镜像，无需本地构建）
docker compose up -d
```

启动后：

```bash
# 查看首次启动的管理员密码（若未在 .env 设置 ADMIN_PASSWORD）
docker compose logs freebuff-proxy | grep -A4 "首次启动"
```

浏览器打开 `http://<宿主机IP>:<PORT，默认8787>/`，用管理员账号登录，在「总览 → + 添加账号」里完成 Freebuff 登录回调（见下文），即可开始使用。

> 网络为 host 模式（Docker 官方方案）：容器与宿主机共享网络栈，应用直接监听宿主 `0.0.0.0:<PORT>`，
> 无需 docker 端口映射（host 模式下 `ports` 会被忽略）；`PORT` 可在 `.env` 调整。

常用命令：

```bash
docker compose ps            # 状态
docker compose logs -f       # 日志
docker compose restart       # 重启
docker compose pull          # 拉取最新镜像
docker compose down          # 停止（数据保留在 ./data）
```

> 升级方式：`git pull && docker compose pull && docker compose up -d`（数据都在 `./data`，不动）。

### 想本地构建？（可选，开发调试用）

默认使用 GHCR 预构建镜像（发版 `v*` tag 时自动推送，`latest` + 版本号 tag，如 `1.0.0`，semver 去 `v` 前缀）。
想自己构建的话，把 compose 里的 `image: ghcr.io/hengxin666/freebuff-proxy:latest` 换成 `build: .`：

```yaml
build: .
```

```bash
docker compose up -d --build
```

---

## 数据与持久化（/data 挂载）

所有状态都落在宿主机 `./data`（容器内 `/data`），**删除容器 / 升级镜像都不丢数据**：

```text
data/
├── config.yaml            # 首次启动自动生成，可直接编辑（重启生效）
├── credentials/           # Freebuff 账号凭据（每账号一个 <email>.json）
├── users.json             # Web 控制台用户（密码 scrypt 哈希）
├── web-sessions.json      # Web 登录会话
└── login-flows.json       # 浏览器登录回调流程（重启不丢）
```

- 首次启动自动把 `config.example.yaml` 复制为 `/data/config.yaml`，无需手动创建。
- `docker-entrypoint.sh` 以 root 初始化 `/data` 属主后自动降权到 `node`(1000) 运行。
- 凭据、用户、会话均以 `0600` 权限写入，**建议对 `./data` 做好备份与访问控制**。

---

## GitHub Actions 自动构建镜像

`.github/workflows/docker-image.yml`：

- **push 到 `main` / `master`**：跑测试（`npm test` + `npm run typecheck`）→ Docker Buildx 构建 → 推送 `ghcr.io/<repo>:latest`、`:sha-<hash>`、`:<branch>` 等 tag。
- **打 `v*` tag**：额外推送 `:<version>`、`:<major>.<minor>` 语义化 tag。
- **pull_request**：只跑测试，不推送（防止 PR 污染镜像）。
- **手动触发**：Actions 页面 → Run workflow。
- **可选 Docker Hub**：在仓库 Secrets 配置 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 后会自动同时推送 Docker Hub。

构建使用 `docker/build-push-action` 的 GHA 缓存（`cache-from/to: type=gha`），后续构建秒级缓存。

---

## Web 控制台：登录 / 用户管理 / 添加账号回调

控制台是零依赖原生 JS 单页应用，内置在镜像中（`/`），无需额外部署。

### 登录

- 首次部署自动创建管理员（`ADMIN_USERNAME`，默认 `admin`）。
- 设置了 `ADMIN_PASSWORD` 则用固定密码；**未设置则随机生成，仅首次启动打印在 `docker compose logs` 里**（强烈建议登录后改密并写入 `.env`）。
- 普通用户由管理员在「用户管理」中创建，登录后可查看自己的 API Key 并测试对话。

### 添加 Freebuff 账号（浏览器回调，不在容器内打开浏览器）

容器内**不会**尝试打开浏览器。流程：

1. 管理员在「总览 → + 添加账号」发起登录；
2. 服务端向 Freebuff 申请 CLI 登录链接并返回；
3. **在你自己电脑的浏览器**打开该链接完成登录授权（页面会持续轮询显示状态）；
4. 服务端收到回调后把凭据保存到 `/data/credentials/<email>.json`，控制台自动刷新。

> 也支持「导入账号」：从旧环境导出的 `{"email":"...","authToken":"..."}` JSON 可直接粘贴导入。

### 用户管理（管理员）

- 创建 / 删除用户，设置角色（`admin` / `user`）。
- 每个用户独立 `sk-fb-...` API Key，可复制 / 重置。
- 修改密码、设置粘性会话策略（见下）。
- 下游 Agent 用**某个用户的 API Key** 接入时，该用户的粘性策略自动生效。

---

## 多账号池与粘性会话

### 账号池自动切号

- 在 `/data/credentials/` 放入多个账号（通过控制台逐个添加或导入）。
- 每次请求按可用性选号：`rate_limited` / `spend_limited` / `ip_capped` / `free_mode_rate_limited` / `banned` 整号冷却并自动换下一个；`model_unavailable` 只冷却该账号上的该模型。
- **chat/completions 阶段返回 429 限流**（如 `free_mode_rate_limited`，免费模式 30 分钟窗口限制）
  同样会按上游 `Retry-After` 冷却当前账号并**换号重试一次**，而不是把 429 直接甩给下游。
- 冷却信息（状态、剩余时间、原因）在控制台「总览」实时可见，可手动「解除冷却」。

### 会话级负载均衡（不同会话 → 不同账号）

代理按**会话 ID** 把不同对话摊到不同账号，同一对话固定在同一账号，避免所有请求
压在一个账号上触发风控：

- 会话 ID 自动从请求里提取，优先级：`codebuff_metadata.conversation_id` / `thread_id`
  → 显式会话字段（`conversation_id` / `thread_id` / `session_id`）→ 常见会话头
  （`x-conversation-id` / `x-thread-id` / `x-session-id`）→ `user` 字段兜底。
  **不用 `codebuff_metadata.client_id`**：它是客户端安装 ID，对同一客户端恒定，会让所有会话
  共享同一个 key、永远分到同一个账号。
- **新会话**从健康账号里选「当前持有会话数最少」的账号，平局按轮询次序轮流
  （第 1、第 2、第 3…个账号），并立即记忆分配结果（冷却中 / 已用满限额的账号不参与）；
  3 个账号时 12 个新对话会 4/4/4 平均摊开——不用哈希，账号少时哈希碰撞容易
  导致新会话总落到同一个账号；
- **同一会话**后续请求固定走该账号（热 session 复用，避免 `superseded` 与重复 admit）；
  该账号冷却/超额时自动回落到池子，并记住新账号；
- 无会话 ID 的请求（如控制台 playground、只发 `client_id` 的客户端）走池子**轮询选号**：
  请求按 第 1、第 2、第 3…个账号轮流分配，不会因为某账号已有活跃 session 而一直压在上面
  （每个账号自己的 session 在轮到它时仍会被复用，热 session 不丢）。

控制台「总览」顶部负载均衡条显示各账号请求占比；账号表新增「会话」列，显示当前固定到
该账号的会话数，一眼就能看出分布是否均匀。

### 配额感知负载均衡

选号以**轮询**为基准，再叠加配额/冷却约束：

1. **轮询**（round-robin）：无会话 ID 的请求按 第 1、第 2、第 3…个账号轮流分配，
   避免"活跃 session"加分把请求持续吸到同一个账号（旧行为：一个账号 128 次、其余 0 次）；
2. **限额模型**（premium 池，如 luna / v4-pro）叠加「剩余每日额度越多越优先」（`rateLimitsByModel` 的 `limit - recentCount`），已用满的账号当周期内大幅降权；
3. **不限量模型**（unlimited 池，如 `deepseek/deepseek-v4-flash` / `mimo/mimo-v2.5`）**豁免配额逻辑**——不会因为上游返回的 rateLimit 条目而切换账号，避免无谓的 session 替换；
4. 冷却中的账号排除在外。

### 粘性会话（显式指定 / 用户策略）

| 级别 | 说明 |
|------|------|
| `x-sticky-account` 请求头 | 显式指定上游账号邮箱，优先级最高（只作用于该请求） |
| Web 用户的粘性策略 | 管理员可在「用户管理」为每个用户设置 |
| 会话级默认行为 | 见上「会话级负载均衡」：同一会话固定账号、不同会话自动摊开 |

用户的粘性策略三种模式：

- **自动跟随（auto，默认）**：会话级负载均衡——同一会话固定同一账号，不同会话按「最少会话数+轮询」摊到不同账号；账号冷却/限流时自动回落到池子并记住新账号。
- **固定账号（pin）**：始终固定到指定的上游账号（适合只给某个账号配额的场景）。
- **轮询（none）**：完全不做会话粘性，每次都走池子选号。

### 查看额度（每日免费 session）

Freebuff 免费层按 **模型 × 每日** 限次（上游返回 `rateLimitsByModel`，如
`limit: 6 / recentCount: 已用 / resetAt: 重置时间`，按太平洋日重置）。

> ⚠️ 实测（参考 [freebuff2api-workers](https://github.com/pingmike2/freebuff2api-wokers) 的逆向结论）：
> `deepseek/deepseek-v4-flash` 与 `mimo/mimo-v2.5` 属于 **unlimited 池，不限量**，
> 不在每日限额表内。代理据此对这两个模型**豁免配额切换与额度展示**（显示为「不限」绿色徽章）。

- 控制台「总览」每个账号有一列 **额度（今日）**：限额模型显示 `已用/上限` 与重置时间（`已用满` 红色、`≤2` 黄色、正常绿色），不限量模型显示「不限」。
- 额度在 **admit 时自动抓取**（上游仅在 session 活跃时返回）；活跃 session 每 30s 轮询刷新，session 结束后保留最后一次缓存值直到下次 admit。
- 同样可通过 `GET /v1/freebuff/status` 或 `GET /v1/freebuff/accounts` 拿到每个账号的 `quota`。

---

## 代理支持

服务器出网（请求 Freebuff / Codebuff）支持代理。**日常操作全部在控制台「代理设置」里完成**：
一个文本框一行一个代理，保存立即生效并持久化到 `/data/proxies.json`，不用改任何配置文件。

### 前端「代理设置」（唯一日常入口）

控制台「总览 → 代理设置」：

- 文本框里**一行一个代理**（`http://...` / `socks5://...`），点「保存并生效」立即生效、无需重启；
- 持久化到 `/data/proxies.json`（数据全在 `/data`，删容器不丢），重启后自动加载；
- 账号由系统**内部分配**到池内代理（稳定哈希：同一账号始终同一出口，保持 session IP 稳定，不会中途换 IP）；
- 账号分布自动打散到各代理，天然负载均衡；某个代理**连接失败**时自动回落到池内下一个（写日志）；
- **留空保存 = 清空全局池**（走环境变量 / 直连）。

### 兜底配置（一般不用动）

代理优先级：控制台全局池（`/data/proxies.json`）> `config.yaml` 的 `upstream.proxies` > 账号凭据文件
`credentials/<email>.json#proxy`（内部字段，仅脚本/手工维护，无 UI）> `upstream.proxy` > `HTTP(S)_PROXY` 环境变量 > 直连。

`config.yaml` 里的 `upstream.proxies` / `upstream.proxy` 只作**兜底默认值**（控制台保存后会覆盖并优先），
改完需要重启容器才生效——日常加/删代理请在控制台操作。

### 测试代理是否生效

控制台「总览 → 代理测试」：

- 输入代理地址点「测试」（或点「测试已配置代理」测全部已配置项）；
- 结果会显示：**出口 IP + 国家地区**（通过 Cloudflare trace 验证确实走了该代理）、延迟、以及 codebuff 可达状态；
- 看到出口 IP/地区 ≠ 本机 IP，就说明代理生效了。

> 也可以直接 curl 后端接口：`POST /api/proxy/test`，`{"proxy":"http://..."}` 测试指定代理，空 body 测试已配置代理。

### 地址怎么填（host 网络模式默认）

- **host 网络模式（默认）**下容器与宿主机共享网络栈，代理在这台机器上（VPS 本机）直接填
  `http://127.0.0.1:2334`（Clash 只监听 127.0.0.1 也能通，无需开 Allow LAN）；
- 代理在**另一台机器**时填真实 IP（`http://192.168.1.10:2334`），不要用 `host.docker.internal`。

容器健康检查走 `NO_PROXY=127.0.0.1,localhost,172.16.0.0/12`，不受代理影响。

---

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
  - `deepseek/deepseek-v4-flash`（unlimited）
  - `deepseek/deepseek-v4-pro`（premium）
  - `openai/gpt-5.6-luna`（premium）
  - `minimax/minimax-m3`（premium）
  - `mimo/mimo-v2.5`（unlimited）
- **Session**：`POST /v1/chat/completions` 自动按 model 占用 1 小时 free session、注入
  `codebuff_metadata.{cost_mode=free, freebuff_instance_id, run_id, client_id}`，其余字段原样透传；
  遇到 `session_expired` / `session_superseded` / waiting room 等 gate 自动 re-admit 一次（`limits.max_auto_retry_on_session_error`）。
- **其它路由**：

  | 路径 | 作用 |
  |------|------|
  | `GET /healthz` | 存活探针 |
  | `GET /v1/models` | 可用模型目录 |
  | `GET /v1/freebuff/status` | 当前账号与 session 快照 |
  | `GET /v1/freebuff/accounts` | 账号列表与冷却状态 |
  | `POST /v1/freebuff/session/end` | 释放全部 session |
  | `POST /v1/chat/completions` | 主路径（session + 透传） |
  | `* /v1/*`（非 chat） | 映射到上游 `/api/v1/*`，只注入 Freebuff 鉴权 |

---

## 命令 / 本地开发

```bash
npm install
npm run doctor    # 检查配置 / 凭据 / 上游连通
npm start         # 本地启动反代（默认 ./config.yaml，数据在 ./data）
npm run login     # CLI 方式浏览器登录（同样不会在容器内打开浏览器）
npm test          # 冒烟测试（mock 上游，不消耗真实额度）
npm run typecheck
```

可选 `node bin/serve.js --config /path/to/config.yaml`。

---

## 配置参考

Docker 部署时配置位于 `/data/config.yaml`（首次启动自动生成，完整示例见 [config.example.yaml](./config.example.yaml)）。

| 项 | 唯一来源 |
|----|----------|
| Freebuff 登录态 | Web 控制台添加 / `npm run login` → `credentials/<email>.json` |
| Web 用户 / API Key | `/data/users.json`（控制台管理） |
| Agent 门禁 | `server.api_keys`（可选；非 loopback 必填） |
| 上游 API / 登录 URL | `upstream.api_base` / `login_base` |
| 出网代理 | 控制台「代理设置」→ `/data/proxies.json`（账号级 `credentials/<email>.json#proxy`、`upstream.proxy`、`HTTP(S)_PROXY` 仅兜底） |
| 监听地址 | `server.host` / `port`（`FREEBUFF_PROXY_HOST` / `FREEBUFF_PROXY_PORT` 覆盖） |
| 管理员 | `ADMIN_USERNAME` / `ADMIN_PASSWORD`（或 `users.default_admin_*`） |
| 并发上限 | `limits.max_concurrent_requests` |
| Web 会话有效期 | `web.session_ttl_hours`（默认 168h） |
| 配置文件路径 | 默认 `./config.yaml` 或 `FREEBUFF_PROXY_CONFIG` |
| 数据目录 | 默认 `./data` 或 `FREEBUFF_PROXY_DATA_DIR`（Docker 固定 `/data`） |

---

## 限制（官方免费层现实）

- Luna 等 premium：大约每天 6×1 小时 session（共享 premium 池）。
- Flash：CLI full 访问下次数较松，仍有 spend / IP / 容量限制。
- 同账号多端会 `superseded`；多账号多 IP 场景在「代理设置」配多个代理即可，系统按账号稳定分配出口（见代理支持）。
- 地区 / VPN / 封禁由上游决定。
- 本项目**不**绕过风控，也**不**保证无限额度。
