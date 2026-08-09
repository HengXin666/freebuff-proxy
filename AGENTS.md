# AGENTS.md — freebuff-proxy 项目开发约定（用户要求，违反即返工）

> 本文件是项目最高优先级开发约定。任何代码/部署/文档改动前先读这里。
> 用户明确强调：**不要每次来回折腾、不要浪费用户时间**。一次说清、一次做对。

## 项目定位
OpenAI 兼容的 Freebuff/Codebuff **免费额度反向代理**。核心卖点：
**超级轻量** + **一键 Docker 部署** + **一切管理都在前端页面**。

## 铁律（用户明确要求）

1. **轻量优先，禁止加无用东西**
   - 镜像 = `node:22-alpine` + 仅 2 个运行时依赖（`undici` / `yaml`），保持现状。
   - `docker-compose.yml` 保持最小：`image / container_name / restart /
     network_mode / environment / volumes`；默认 `image: ghcr.io/hengxin666/freebuff-proxy:latest`
     （发版自动推送，`docker compose up -d` 免构建），`build: .` 仅本地开发/离线场景。
   - **禁止**：`NETWORK_MODE` 变量、`init`、`extra_hosts`、`stop_grace_period`、
     重复的 healthcheck（Dockerfile 里已有）、多余的 docker 模块/依赖。

2. **网络模式：host（Docker 官方方案，解决"容器访问宿主机 127.0.0.1 代理"）**
   - `network_mode: host`，容器与宿主机共享网络栈。
   - **host 模式下禁止写 `ports`**（官方文档：`-p` 被忽略并告警 `Published ports are
     discarded when using host network mode`）。应用直接监听宿主 `0.0.0.0:${PORT}`，
     通过 `FREEBUFF_PROXY_PORT: "${PORT:-8787}"` 让 `PORT` 生效；访问 `http://<机器IP>:<PORT>`。
   - 本机代理在控制台「代理设置」直接填 `http://127.0.0.1:<端口>` 即可，无需网关 IP /
     `host.docker.internal`。

3. **一切配置走前端页面，禁止让用户改配置文件**
   - 代理（全局池）→ 前端「代理设置」：加/删/测试/保存**立即生效**，持久化 `/data/proxies.json`。
   - 账号 → 前端导入 JSON / 浏览器登录回调（服务端轮询，**不在容器内开浏览器**）。
   - 用户 → 前端用户管理（建/删/改密/重置 Key）。
   - 管理员密码 → `.env` 或首次启动日志。
   - `config.yaml` 只作兜底默认值，不是日常操作入口。
   - 用户原话："正常人谁会天天改配置，都是在前端页面操作的。"

4. **不要向用户索要配置、不要反复折腾**
   - 遇到环境差异：先自查代码/文档/日志，能自己验证的自己验证，再给结论。
   - 每次交付前本地端到端验证（见「测试与验证」），不把问题丢给用户。

5. **数据全在 `/data`（挂载宿主机 `./data`）**，删容器不丢数据。
   首次启动自动生成 `config.yaml`，entrypoint 以 root 初始化属主后降权到 `node`。

## 代理（重点）

- **全局代理池** `upstream.proxies`，由前端「代理设置」管理，改动立即生效。
- **用户只需要添加一个/多个代理**，账号到代理的分配是**系统内部分配**（稳定哈希：
  同一账号同一出口，保持 session IP 稳定；某代理连接失败自动回落池内下一个）——
  **禁止**在前端要求用户按账号配置出口（用户明确反对）。
- 优先级：账号显式 `proxy`（凭据文件字段，仅内部支持）> 全局池 > `upstream.proxy` > `HTTP(S)_PROXY` env > 直连。
- **代理测试**：`POST /api/proxy/test`，输出出口 IP / 国家 / 延迟 / codebuff 状态；
  前端可测任意代理或已配置代理。用户曾因代理"是否有效"不明确而质疑，测试功能必须可用、报错要带底层原因码（ENOTFOUND/ECONNREFUSED/ETIMEDOUT）。
- 容器内 `127.0.0.1` = 容器自己；访问**宿主机代理**用 docker 网关 IP（`docker network inspect bridge` 查，通常 172.17.0.1）或 `host.docker.internal`（两者都要求代理监听 0.0.0.0）。
- **不要**把 `host.docker.internal` 当首选教用户用（曾误导用户，被明确批评）。

## 额度 / 配额 / 负载均衡

- 前端展示上游 `rateLimitsByModel`（每模型 `已用/上限/重置时间`）；额度仅在 admit/活跃 session 时由上游返回。
- 提供**只读探测刷新**（`POST /api/accounts/probe`，只 GET、不创建 session、不占额度）；导入账号后自动探测。
- 多账号池自动切号：`rate_limited / spend_limited / ip_capped / free_mode_rate_limited / banned` 整号冷却并换下一个；`model_unavailable` 只冷却该模型。上游报错（chat 429 限流 / 5xx / 403 账号级封禁 / startAgentRun 失败 / 网络超时）一律冷却当前账号并继续轮询下一个，**试完所有账号（预算=账号数+1，封顶 5 次）才把错误返回给用户**；4xx 客户端错误不换号。
- **`free_mode_capacity_deferred`（"Free mode is briefly at capacity"）不冷却**：是免费模式瞬时容量排队，上游自己说 "will be retried automatically"，实测同 session 立即重试即恢复（flash 尤常见）。优先复用当前热 session 重试，绝不为此无谓新建 session 或把账号钉死。
- gate 错误（session_expired/superseded/waiting_room 等）：先同账号 re-admit 一次（不冷却），连续两次仍失败才升级为换号冷却。
- **session 轮询 GET 跳过在途请求**：上游同一个号同一时间只能一个客户端在线，轮询若撞上正在进行的 chat 会干扰/顶掉活跃会话，因此有请求在途时本轮刷新跳过。
- **热 session 优先调度**：Freebuff 会话是**无状态**的（每次请求由客户端带全量历史），
  **不做 conversation_id 粘性/分组/记忆**；但创建 session 会消耗按时长结算的次数，因此选号必须优先复用
  同模型活跃 session。实测同一个 `instanceId` 支持多个并发 chat 流（两路同时 `200` 并完整 `[DONE]`），
  并发不需要主动铺到多账号。冷启动的“选号 + admit”必须串行化，多个并发请求只创建一个 session。
- 没有同模型热 session 时：优先无活跃 session 的账号；仅当所有可用账号都被其他模型占用时才替换旧模型。
  同一层级内用轮询打破平局；限流/封禁/网络或上游故障仍冷却当前账号并切下一个。
- **Flash / MiMo 纳入每日配额**：`deepseek/deepseek-v4-flash`、`mimo/mimo-v2.5`
  不再硬编码为不限量；前端和 API 始终以上游 `rateLimitsByModel` 的实时 `recentCount / limit / resetAt` 为准。

## Session 行为

- 创建 session 才扣额度 → **同模型活跃 session 始终优先复用**，避免重复 admit 占额度。
- **无会话记忆/分组**：`conversation_id` 不决定账号；同模型请求由热 session 优先策略统一调度。
- 同一个 `instanceId` 支持并发 chat；后台 session GET 在有请求在途时仍必须跳过，避免客户端身份/轮询干扰活跃会话。
- 新模型优先使用空闲账号；没有空闲账号而必须复用同一账号时，先释放旧 session。gate 错误（session_expired/superseded/waiting room 等）自动 re-admit **一次**。

## Web 控制台

登录 / 用户管理（admin 角色）/ 账号导入与浏览器登录回调 / 测试对话（playground）/
总览（账号池、额度、请求分布、冷却、代理出口）/ **代理设置**（全局池管理）。

## CI / 部署

- GitHub Actions（`.github/workflows/docker-image.yml`）：push main/tag → test + typecheck + 构建推送 GHCR；
  pull_request 只测不推；带 GHA 缓存。
- **教训**：`secrets` 不允许出现在 step 级 `if:`，需先提升为 workflow 级 `env` 再用 `env.X` 判断。
- 升级方式：`git pull && docker compose pull && docker compose up -d`。

## 测试与验证（提交前必须全过）

```bash
npm test            # smoke（mock 上游：session 复用/并发冷启动/冷却换号/代理池/probe/代理测试）
npm run typecheck
docker compose config --quiet
docker build .
```

- 改动网络/代理/部署相关，必须本地起容器端到端验证（healthz / 登录 / 导入 / 探测 / 代理测试 / 真实对话）后再提交。
- 真实账号验证注意：admit 会消耗每日额度，尽量用 GET 探测或控制次数。

## 当前状态（截至 2026-08-09）

- [x] 轻量镜像 + compose 一键部署 + /data 持久化 + GitHub Actions 构建
- [x] Web 控制台：登录、用户管理、账号导入/浏览器回调、playground、额度/请求/冷却/出口展示
- [x] 多账号池 + **热 session 优先调度**（无 conversation 粘性；同模型串行/并发均复用；冷启动只 admit 一次；新模型优先空闲账号）+ Flash/MiMo 实时每日配额 + **全链路故障转移**（chat/run/网络错误都换号，试完所有账号才报错；capacity_deferred 不冷却；gate 同号重试后升级换号）
- [x] 前端「代理设置」全局池管理：多行代理、保存立即生效、持久化 `/data/proxies.json`、重启自动加载、无需重启
- [x] 全局代理池（config 层兜底）+ 代理测试（出口 IP/国家/延迟/codebuff 状态、底层原因码）+ 账号级 proxy 仅内部字段（无 UI）
