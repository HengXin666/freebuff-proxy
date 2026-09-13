# AGENTS.md — freebuff-proxy 项目开发约定（用户要求，违反即返工）

> 本文件是项目最高优先级开发约定。任何代码/部署/文档改动前先读这里。
> 用户明确强调：**不要每次来回折腾、不要浪费用户时间**。一次说清、一次做对。

## 本文件规则 (硬性)

1. **禁止未经允许编辑本文件**: 未经用户明确指示, 不得修改/追加/重写本文件任何内容。
2. **记忆禁止写回**: 过程记忆、运行状态、功能清单、教训日志等一律落盘到项目数据目录
   (`data/`、`docs/` 等), 严禁写入本文件。本文件只保留开发约定。
3. 本文件目标 ≤150 行; 新增约定需先征得用户同意, 并压缩替换旧内容。

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
- 多账号池自动切号：`rate_limited / spend_limited / ip_capped / free_mode_rate_limited / banned` 整号冷却并换下一个；`model_unavailable` 只冷却该模型。上游报错（chat 429 限流 / 5xx / 403 账号级封禁 / startAgentRun 失败 / 网络超时）冷却当前账号并继续轮询下一个；4xx 客户端错误不换号。
- **两本账，早退都退**：`session_units`（`rateLimitsByModel.recentCount`，上限 6）与 **Freebucks（每日池 + 余额）** 都在提前 DELETE 时**按实际占用时长退还未用部分**（`freebucksRefund`）。`freebucksRefundPending` = **结算未完成**（要用同一个 `instanceId` 重放 DELETE 取回执），**不是"不退"**——必须持续重放追问，绝不在 pending 时丢弃句柄。早退因此**既腾槽位又省钱**（见 `docs/account-scheduling-and-refund.md` §3，2026-09-13 结论反转）。
- **换号有成本（每条会话都从 admit 起按整小时计价，但早退会把未用部分退回来）**：单个下游请求最多新建 `limits.max_new_sessions_per_request`（默认 2）条会话；复用热 session 与被上游拒绝的 admit 不占预算；换号前先把失败账号的会话早退 DELETE **腾出槽位并取回未用时长**；非账号级瞬时故障（网络抖动）先同账号重试一次，不新建会话。
- **`free_mode_capacity_deferred`（"Free mode is briefly at capacity"）不冷却**：是免费模式瞬时容量排队，上游自己说 "will be retried automatically"，实测同 session 立即重试即恢复（flash 尤常见）。优先复用当前热 session 重试，绝不为此无谓新建 session 或把账号钉死。
- gate 错误（session_expired/superseded/waiting_room 等）：先同账号 re-admit 一次（不冷却），连续两次仍失败才升级为换号冷却。
- **session 轮询 GET 跳过在途请求**：上游同一个号同一时间只能一个客户端在线，轮询若撞上正在进行的 chat 会干扰/顶掉活跃会话，因此有请求在途时本轮刷新跳过。
- **粘性优先调度（drain, not rotate）**：Freebuff 会话是**无状态**的（每次请求由客户端带全量历史），
  **不做 conversation_id 粘性/分组/记忆**。选号排序 = 同模型热 session > 已用过的账号（最近用过的优先）
  > **从未用过的账号（排最后，只有已用账号都不可用/满员排队超时才启用）**；上游把"轮换健康账号"
  直接当账号农场特征，而每次 admit 都要起一条计费会话（早退会退未用部分，但仍应少换），所以**绝不主动把并发平摊到多个账号**。
  冷启动的“选号 + admit”必须串行化，同一账号的并发请求只创建一个 session。
  **并发上限是"溢出"阈值而非"换号"阈值**：单账号在途流数达到 `accountMaxConcurrency`（默认 2）时，
  新请求先在该账号上有界排队（超时 `account_busy` 后再换下一个账号），**不为了并发去启用新账号**。
- 没有同模型热 session 时：优先冷账号（无活跃 session）而不是替换别的模型的热 session（避免同一账号
  反复 release/admit）；同一层级内已用账号 > 未用账号、最近用过的优先、轮询打破平局；
  限流/封禁/网络或上游故障仍冷却当前账号并切下一个。
- **Flash / MiMo 纳入每日配额**：`deepseek/deepseek-v4-flash`、`mimo/mimo-v2.5`
  不再硬编码为不限量；前端和 API 始终以上游 `rateLimitsByModel` 的实时 `recentCount / limit / resetAt` 为准。

## Session 行为

- 创建 session 才扣额度 → **同模型活跃 session 始终优先复用**，避免重复 admit 占额度。
- **无会话记忆/分组**：`conversation_id` 不决定账号；同模型请求由热 session 优先策略统一调度。
- 同一个 `instanceId` 支持并发 chat；后台 session GET 在有请求在途时仍必须跳过，避免客户端身份/轮询干扰活跃会话。
- 新模型优先使用空闲（冷）账号；没有空闲账号而必须复用同一账号时，先释放旧 session。gate 错误（session_expired/superseded/waiting room 等）自动 re-admit **一次**。
- **空闲自动释放**：会话在途归零后空闲超过 `session.idle_release_sec`（默认 60s，控制台「额度保护」可调）就早退 `DELETE`——**既腾出该账号的上游会话槽位**（一个账号同时只有一条 session 且绑定模型），**也把未用时长对应的 Freebucks 退回来**（挂着的空闲会话在按小时计价）。DELETE 必须带 `x-freebuff-instance-id`（否则上游 400 `instance_required`，删不掉也追不回那笔预扣）。有请求排队等待该会话时不得释放。

## Web 控制台

登录 / 用户管理（admin 角色）/ 账号导入与浏览器登录回调 / 测试对话（playground）/
总览（账号池、额度、请求分布、冷却、代理出口）/ **代理设置**（全局池管理）。

## CI / 部署

- GitHub Actions（`.github/workflows/docker-image.yml`）：push main/tag → test + typecheck + 构建推送 GHCR；
  pull_request 只测不推；带 GHA 缓存。
- **教训**：`secrets` 不允许出现在 step 级 `if:`，需先提升为 workflow 级 `env` 再用 `env.X` 判断。
- 升级方式：`git pull && docker compose pull && docker compose up -d`。

## 版本管理（硬性，发版必读）

1. **唯一版本真源 = `package.json` 的 `version` 字段**。本地开发/测试以它为准。
2. **每次发版必须先 bump 版本号**，流程固定为：
   ```bash
   npm version patch|minor|major   # 自动 bump package.json + git commit + 打 v* tag
   git push origin main --tags
   ```
   **禁止**：bump 版本与打 tag 分开做、或跳过 `npm version` 直接手动改 version 后打 tag——
   两者不一致会被流水线门禁拦下。
3. **流水线强制门禁**：CI 的 `check-version` job 校验 git tag（`v*`）与 package.json 版本必须一致，
   不一致直接 fail。这就是「发版必须更新版本号」的硬保障，不需要人工提醒。
4. **镜像内版本号由流水线硬编码**：`build-push` 在 docker build 前跑
   `node scripts/inject-version.mjs --version <tag版本> --repo <仓库>`，
   生成 `dashboard/version.json`（含 version + repo + commit sha）写进镜像。
   前端 header 的 `vX.Y.Z` 徽章就是读它——**镜像里显示什么版本完全由流水线决定**，
   与本地文件无关；本地没有 version.json 时前端 fallback 显示 `dev`。
5. `dashboard/version.json` 是构建产物（.gitignore 已忽略），**禁止手工编辑/提交**；
   要改版本只能走 `npm version` + 重新构建。

## 测试与验证（提交前必须全过）

```bash
npm test            # smoke（mock 上游：session 复用/并发冷启动/冷却换号/代理池/probe/代理测试）
npm run typecheck
docker compose config --quiet
docker build .
```

- 改动网络/代理/部署相关，必须本地起容器端到端验证（healthz / 登录 / 导入 / 探测 / 代理测试 / 真实对话）后再提交。
- 真实账号验证注意：admit 会消耗每日额度，尽量用 GET 探测或控制次数。

---

# Agent Notes — 决策记录

非平凡改动的定义: 改变行为、架构、跨文件的契约、流程或工具、测试策略, 或任何落盘 / 线上 / 配置格式。
每一次非平凡改动都在**同一次提交里**新增或更新一篇 Agent Note; 纯机械的局部编辑豁免。

1. 改一个声明之前, 先找它旁边引用的 note —— `.agents/notes/<lifecycle>/<class>/<file>.md` 路径,
   通常写在注释或 JSDoc 里。先读它: 它记着已经否决过什么、为什么。
2. 优先更新已经拥有那条决策的 note。过时的事实**就地重写**, 不要追加变更历史;
   绝不把一篇 note 改写成另一条决策 —— 要取代它, 并双向互链。
3. 新方向从 `.agents/notes/proposed/{class}/` 开始; 落地时在同一提交里移到
   `implemented/{class}/`, 用现在时陈述, 并从它约束的代码里引用它 (见第 1 条)。
4. 每一篇 active note 都带 `## Alternatives considered`, 其中必须有"什么都不做 / 复用现有"
   这一项, 且每个被否掉的选项都要先给出它最强的理由, 再否决。
5. note 被完全取代时用 `notes:archive` 归档; rejected 提案不再能拦住一个
   有人可能重犯的错误时, 直接删除。

推送前跑 `npm run verify-notes`。受保护的源码改动若同一次改动里没有 note, 门禁会失败;
要刻意豁免, 写 `.agents/notes/NOTE-EXEMPT.md`, 内容为 `note-exempt: <为什么这次不需要 note>`。
规则细节见 `.agents/notes/AGENTS.md`。
