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

# 一键构建并启动
docker compose up -d --build
```

启动后：

```bash
# 查看首次启动的管理员密码（若未在 .env 设置 ADMIN_PASSWORD）
docker compose logs freebuff-proxy | grep -A4 "首次启动"
```

浏览器打开 `http://<宿主机IP>:8787/`，用管理员账号登录，在「总览 → + 添加账号」里完成 Freebuff 登录回调（见下文），即可开始使用。

常用命令：

```bash
docker compose ps            # 状态
docker compose logs -f       # 日志
docker compose restart       # 重启
docker compose down          # 停止（数据保留在 ./data）
docker compose pull          # 拉取远程镜像（配置好 registry 后）
```

### 使用 GHCR 预构建镜像

GitHub Actions 会在 push 到 `main` / 打 `v*` tag 时自动构建并推送到
`ghcr.io/<你的账号>/freebuff-proxy`。可直接替换 compose 中的 `build: .` 为：

```yaml
image: ghcr.io/HengXin666/freebuff-proxy:latest
```

```bash
docker compose pull && docker compose up -d
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
- 每次请求按可用性选号：`rate_limited` / `spend_limited` / `ip_capped` / `banned` 整号冷却并自动换下一个；`model_unavailable` 只冷却该账号上的该模型。
- 冷却信息（状态、剩余时间、原因）在控制台「总览」实时可见，可手动「解除冷却」。

### 配额感知负载均衡

选号不是纯随机，而是综合打分：

1. 已有该模型活跃 session 的账号 **优先**（创建 session 才扣额度，活跃 session 尽量复用）；
2. **限额模型**（premium 池，如 luna / v4-pro）按「剩余每日额度越多越优先」（`rateLimitsByModel` 的 `limit - recentCount`），已用满的账号当周期内大幅降权；
3. **不限量模型**（unlimited 池，如 `deepseek/deepseek-v4-flash` / `mimo/mimo-v2.5`）**豁免配额逻辑**——不会因为上游返回的 rateLimit 条目而切换账号，避免无谓的 session 替换；
4. 同等条件下**轮询**（round-robin）分摊；冷却中的账号排除在外。

控制台「总览」顶部有各账号选号占比的负载均衡条（每次成功 admit 计入对应账号），便于观察分布是否均匀。

### 粘性会话（按用户 / 按 Key）

同一个对话最好固定在一个上游账号，避免换号导致 session 被 `superseded`。支持三级粘性：

| 级别 | 说明 |
|------|------|
| `x-sticky-account` 请求头 | 显式指定上游账号邮箱，优先级最高 |
| Web 用户的粘性策略 | 管理员可在「用户管理」为每个用户设置 |
| 超级 Key 记忆 | 用 `server.api_keys` 的请求记住最后一次成功的账号 |

用户的粘性策略三种模式：

- **自动跟随（auto，默认）**：记住该用户最近一次成功使用的账号，下次请求优先尝试；账号冷却时自动回落到池子。
- **固定账号（pin）**：始终固定到指定的上游账号（适合只给某个账号配额的场景）。
- **轮询（none）**：不粘性，走池子轮询。

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

服务器出网（请求 Freebuff / Codebuff）支持代理，配置方式按优先级：

1. **全局代理池（推荐，多代理）**：在 `/data/config.yaml` 里配一组代理，所有账号共享这个池子：

   ```yaml
   upstream:
     proxies:
       - http://user:pass@127.0.0.1:7890
       - socks5://127.0.0.1:1080
   ```

   - 每个账号按**稳定哈希**分配到池内某个代理（同一账号始终同一出口，保持 session IP 稳定，不会中途换 IP）；
   - 账号分布自动打散到各代理，天然负载均衡；
   - 某个代理**连接失败**时自动回落到池内下一个（写日志）；
   - 控制台「总览」每个账号会显示实际生效的**出口**（池内第几个 / 哪个 URL）。
2. **账号专属代理（可选高级覆盖）**：某个账号要固定走独立代理时，控制台「总览 → 改出口」或编辑凭据文件：

   ```json
   // data/credentials/<email>.json
   { "email": "you@example.com", "authToken": "...", "proxy": "http://user:pass@127.0.0.1:7890" }
   ```

   该账号所有请求走自己的代理（优先于全局池）；改后缓存运行时自动重建、立即生效。
3. **全局单代理 / 环境变量**：`upstream.proxy: http://...`，或 `.env` / compose 里设 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（undici `EnvHttpProxyAgent`，`NO_PROXY` 放行内网）。

以上都未配置时直连。

### 测试代理是否生效

控制台「总览 → 代理测试」：

- 输入代理地址点「测试」（或点「测试已配置代理」测全部已配置项）；
- 结果会显示：**出口 IP + 国家地区**（通过 Cloudflare trace 验证确实走了该代理）、延迟、以及 codebuff 可达状态；
- 看到出口 IP/地区 ≠ 本机 IP，就说明代理生效了。

> 也可以直接 curl 后端接口：`POST /api/proxy/test`，`{"proxy":"http://..."}` 测试指定代理，空 body 测试已配置代理。

### 代理地址怎么写（重要）

**默认 host 网络模式**：容器与宿主机共享网络栈，代理跑在这台机器（本机 / VPS 宿主机）时，
配置里**直接写 `127.0.0.1`**，和 VPS 上任何进程一样，Clash 只监听 127.0.0.1 也能通：

```yaml
# /data/config.yaml
upstream:
  proxies:
    - http://127.0.0.1:2334        # 代理就在本机/本 VPS 时
```

代理在**另一台机器**时，填它的真实 IP：

```yaml
upstream:
  proxies:
    - http://192.168.1.10:2334     # 局域网/公网都行，和其他容器里的写法一致
```

> 如果用了 `NETWORK_MODE=bridge`（默认桥接网络）：容器内 `127.0.0.1` 是容器自己，访问宿主机代理要用
> docker 网关 IP（`docker network inspect bridge` 查，通常 172.17.0.1）或 compose 已映射的
> `host.docker.internal`。

容器健康检查走 `NO_PROXY=127.0.0.1,localhost,172.16.0.0/12`（docker 网关/内网段默认不走代理），不受影响。

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
| 出网代理 | 账号级 `credentials/<email>.json#proxy` > `upstream.proxy` > `HTTP(S)_PROXY` / `NO_PROXY` |
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
- 同账号多端会 `superseded`；多账号多 IP 场景建议为每个账号配独立出口（见代理支持）。
- 地区 / VPN / 封禁由上游决定。
- 本项目**不**绕过风控，也**不**保证无限额度。
