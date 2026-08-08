# AGENTS.md — freebuff-proxy 项目开发约定（用户要求，违反即返工）

> 本文件是项目最高优先级开发约定。任何代码/部署/文档改动前先读这里。
> 用户明确强调：**不要每次来回折腾、不要浪费用户时间**。一次说清、一次做对。

## 项目定位
OpenAI 兼容的 Freebuff/Codebuff **免费额度反向代理**。核心卖点：
**超级轻量** + **一键 Docker 部署** + **一切管理都在前端页面**。

## 铁律（用户明确要求）

1. **轻量优先，禁止加无用东西**
   - 镜像 = `node:22-alpine` + 仅 2 个运行时依赖（`undici` / `yaml`），保持现状。
   - `docker-compose.yml` 保持最小：`build / image / container_name / restart /
     network_mode / environment / volumes`，外加端口说明见下。
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
   - 用户 → 前端用户管理（建/删/改密/重置 Key/粘性策略）。
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
- 多账号池自动切号：`rate_limited / spend_limited / ip_capped / banned` 整号冷却并换下一个；`model_unavailable` 只冷却该模型。
- **配额感知负载均衡**：限额模型按「剩余额度越多越优先、用满降权」，轮询兜底，冷却排除。
- **不限量模型豁免**：目录 `pool: 'unlimited'` 的模型（`deepseek/deepseek-v4-flash`、`mimo/mimo-v2.5`）
  **不参与配额切换**（不因上游 rateLimit 条目切号），前端显示「不限」。

## Session 行为

- 创建 session 才扣额度 → **活跃 session 尽量复用**（同模型同账号优先，避免重复 admit 占额度）。
- 换模型先释放旧 session；gate 错误（session_expired/superseded/waiting room 等）自动 re-admit **一次**。

## Web 控制台

登录 / 用户管理（admin 角色）/ 账号导入与浏览器登录回调 / 测试对话（playground）/
总览（账号池、额度、请求分布、冷却、代理出口）/ **代理设置**（全局池管理）。

## CI / 部署

- GitHub Actions（`.github/workflows/docker-image.yml`）：push main/tag → test + typecheck + 构建推送 GHCR；
  pull_request 只测不推；带 GHA 缓存。
- **教训**：`secrets` 不允许出现在 step 级 `if:`，需先提升为 workflow 级 `env` 再用 `env.X` 判断。
- 升级方式：`git pull && docker compose up -d --build`。

## 测试与验证（提交前必须全过）

```bash
npm test            # smoke（mock 上游：切号/粘性/配额/flash 豁免/代理池/probe/代理测试）
npm run typecheck
docker compose config --quiet
docker build .
```

- 改动网络/代理/部署相关，必须本地起容器端到端验证（healthz / 登录 / 导入 / 探测 / 代理测试 / 真实对话）后再提交。
- 真实账号验证注意：admit 会消耗每日额度，尽量用 GET 探测或控制次数。

## 当前状态（截至 2026-08-08）

- [x] 轻量镜像 + compose 一键部署 + /data 持久化 + GitHub Actions 构建
- [x] Web 控制台：登录、用户管理、账号导入/浏览器回调、playground、额度/请求/冷却/出口展示
- [x] 多账号池 + 配额感知负载均衡 + 不限量模型（flash/mimo）豁免
- [x] 全局代理池（config 层）+ 代理测试 + 账号级 proxy 覆盖
- [ ] **前端「代理设置」全局池管理**（持久化 `/data/proxies.json`、保存立即生效、无需重启）—— 用户最高优先级待办
