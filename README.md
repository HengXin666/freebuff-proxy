# freebuff-proxy

> 发布与更新日志：[Releases](https://github.com/HengXin666/freebuff-proxy/releases)

OpenAI 兼容的 **Freebuff / Codebuff 免费额度反向代理**，支持 **多账号自动切号 + 热 session 优先调度**、**Web 控制台**（用户管理 + 浏览器登录回调）、**上游代理**，并附带 **一键 Docker Compose 部署** 与 **GitHub Actions 镜像构建**。

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
- [多账号池与热 session 优先调度](#多账号池与热-session-优先调度)
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
├── credentials/           # Freebuff 账号凭据（每账号一个 <账号ID>.json，见下）
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
4. 服务端收到回调后把凭据保存到 `/data/credentials/<账号ID>.json`，控制台自动刷新。

> 账号以 **Freebuff 用户 `id` 唯一标识**（老数据无 `id` 时回落邮箱）。即使 GitHub 和 Google
> 登录使用**同一个邮箱**，Freebuff 也会返回不同的 `id`，两个账号会并存互不覆盖（历史上按邮箱
> 存文件会导致互相覆盖）。旧版 `<email>.json` 文件会在首次读取时自动迁移为 `<id>.json`。
>
> 也支持「导入账号」：从旧环境导出的 `{"email":"...","authToken":"..."}` JSON 可直接
> 粘贴导入（如同时导入了同邮箱的 GitHub/Google 两个账号，请带上各自的 `"id"` 以免互相覆盖）。

### 用户管理（管理员）

- 创建 / 删除用户，设置角色（`admin` / `user`）。
- 每个用户独立 `sk-fb-...` API Key，可复制 / 重置。
- 修改密码。
- 下游 Agent 用**某个用户的 API Key** 接入（Bearer token），流量统一走**热 session 优先**调度。

---

## 多账号池与热 session 优先调度

### 账号池自动切号

- 在 `/data/credentials/` 放入多个账号（通过控制台逐个添加或导入）。
- 每次请求按可用性选号：`rate_limited` / `spend_limited` / `ip_capped` / `free_mode_rate_limited` / `banned` 整号冷却并自动换下一个；`model_unavailable` 只冷却该账号上的该模型。
- **chat/completions 阶段上游报错自动换号**：429 限流（如 `free_mode_rate_limited`）、5xx、
  403 账号级封禁都会按上游 `Retry-After` 冷却当前账号并**换号重试**（最多试到账号数，封顶 5 次），
  而不是把错误直接甩给下游；4xx 客户端错误（400/401/404/422）不换号。
- 冷却信息（状态、剩余时间、原因）在控制台「总览」实时可见，可手动「解除冷却」。

### 热 session 优先调度

Freebuff 免费会话是**无状态**的：上游每次请求都会收到**全量消息历史**（客户端自己携带），
不存在"服务端记住某个 conversation"的概念；但 admit 会占用按时长结算的免费次数，因此代理按
**最少新建 session**的目标调度：

- **免费模型暴力分散（默认开）**：控制台「负载均衡设置 → 免费模型分散到不同账号」可关。
  免费模型不心疼额度：请求**轮转分散到不同账号**（优先空闲槽位、在途少、轮询公平），
  不再钉死单个热 session——**单账号被占死/卡住不再拖垮全部请求**，且多账号并行吞吐更高；
  每个账号各持一个热 session，轮转到时复用。关闭则恢复"最省额度"的热 session 优先调度；
- 优先复用同模型的活跃 session；`conversation_id` / `thread_id` / `user` / `client_id` 不参与选号；
- **账号并发上限可配**：默认 1:1（一个账号同一时间只转发一条 SSE 流）。可在控制台
  「负载均衡设置」调整（1..16），实测同一 `instanceId` 支持多条并发 chat 流，调大后
  一个账号可同时转发多条响应；达到上限的请求按热 session 排队，超时
  （`limits.account_chat_wait_ms`）后换到下一个可用账号。总览里每个账号显示
  `并发(在途/上限)` 实时监控；
- **会话临近过期提前切换**：剩余时间低于 `session.re_admit_lead_sec`（默认 60s）的
  会话不再承接新请求，re-admit 换全新会话——避免请求发到马上过期的会话上、中途卡住
  （响应明显变慢/挂起）。**切换是平滑的**：旧会话若正被在途 SSE 流使用，会先等在途流
  结束后才释放重建，绝不把正在传输的连接掐断；流式 idle 超时按会话剩余时间收敛，
  过期后上游若不再吐数据会更快被掐断；
- **代理切换不断流**：前端「代理设置」保存全局代理池/账号出口变更后**立即生效**——
  新请求走新出口；旧 runtime 的 session 在后台等所有在途 SSE 结束后再优雅释放，正在
  传输的流不受影响。排队等锁期间发生切换的请求会自动无冷却重新选号（走新出口），
  不会撞上已失效的旧会话；
- 冷启动的选号与 admit 已原子化：多个并发请求同时到达也只创建一个 session；
- 没有同模型热 session 时，优先选择没有活跃 session 的账号，避免提前释放其他模型的可用时段；
- 多个同层级账号只在平局时轮询；**冷却中的账号跳过**；
- 上游报错（gate 错误如 `session_expired` / `superseded`）自动同号 re-admit 重试一次；
  429 限流 / 5xx / 403 账号级封禁则**冷却当前账号并换下一个账号**重试（最多试到账号数，封顶 5 次），
  4xx 客户端错误（400/401/404/422）不换号。

控制台「总览」顶部显示各账号实际请求占比、活跃 session 与冷却状态。

### 查看额度（每日免费 session）

Freebuff 免费层按 **模型 × 每日** 限次（上游返回 `rateLimitsByModel`，如
`limit: 6 / recentCount: 已用 / resetAt: 重置时间`，按太平洋日重置）。

> ⚠️ 2026-08-09 实时探测：`deepseek/deepseek-v4-flash` 与
> `mimo/mimo-v2.5` 已重新出现在上游 `rateLimitsByModel` 中（当前为 6 次/天）。
> 代理不再对它们做不限量豁免，始终以上游实时返回的限额为准。

- 控制台「总览」每个账号有一列 **额度（今日）**：所有限额模型都显示 `已用/上限` 与重置时间（`已用满` 红色、`≤2` 黄色、正常绿色）。
- 额度在 **admit 时自动抓取**（上游仅在 session 活跃时返回）；活跃 session 每 30s 轮询刷新，session 结束后保留最后一次缓存值直到下次 admit。
- `recentCount` 可能是小数：admit 时先预占 1 小时额度，提前释放后按实际占用时长结算（实测最小步进为 `0.1`）。因此复用热 session 比平均铺开账号更省额度。
- 同样可通过 `GET /v1/freebuff/status` 或 `GET /v1/freebuff/accounts` 拿到每个账号的 `quota`。

### 工具签名兼容

控制台「总览 → 免费额度策略」提供「工具签名兼容」开关，默认开启。开启时，代理会在非空
`tools` 列表末尾补充 Freebuff 官方工具名 `end_turn`，避免工具请求被识别为外来工具集；关闭时
原样转发客户端工具列表。切换后立即生效并持久化到 `/data/settings.json`，无需重启。

### 极简路由（路由模式）

控制台「总览 → 免费额度策略」提供「**极简路由（路由模式）**」开关，默认关闭。开启后，代理在
转发每个 chat 请求前按 [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)
（dsh-router-standard preset，P1-P30 实测）的请求协议改写请求：

1. **persona 注入**：按会话首个用户消息自动分类任务 → `spec`（修复/排查，计划-集体）、
   `react`（构建/开发，执行-个体）、`weak`（模糊任务，模型自分类，按模型选最优：
   Pro=spec 句，Flash=neutral+classify），并把极简 persona 置于请求最前。
   客户端原本的 system 消息保留在其后（极简但不丢客户端上下文）。
2. **首轮核心工具面**：历史里还没有 `assistant tool_calls` 时，把 `tools` 裁剪到该模式的
   核心工具集（spec 读优先 `read/edit/glob/grep`，react 写优先 `read/write/edit`）+ `bash/pwsh`；
   首个工具调用之后自动放行全部工具（首轮锚定，路径提交后不再干预）。
   **工具保证**：客户端给了工具就绝不裁空（核心集裁剪为空则保留原工具集，模型始终能调用
   工具）；Freebuff 特殊签名工具 `end_turn` 始终保留（上游凭它保留请求模型/额度）。
3. **近距离引导（weak 模式）**：最后一个用户消息后追加一条固定引导文本——简单任务快速收敛、
   复杂任务（长文本/架构词）深度收敛；固定文本保持上游缓存命中（92-94%）。
4. **路由风格（思维链）**：可把路由钉死到某条思维链——`spec` = we/let's 集体计划链、
   `react` = let me 执行链、`weak` = 模型自分类、`auto` = 按任务自动分类（默认）。
   we/let's 链的锚定方式按模型自适应：
   - **v4-pro**：persona 远距锚定即生效（persona 后附加
     `Plan and reason collectively: use first-person plural (we / let's).`）；
   - **v4-flash（fast）**：远距锚定反噬（实测 we 9→0），改在用户消息后**近距注入**
     `... Begin your reasoning with "We".` 做首 token 自锚定（P15 机制），
     实测工具化多轮会话中 we/let's 链稳定出现（we=4~6, let's=3, let me=0）；
     锚定在**工具循环轮次同样注入**（最后一条是 tool 结果也追加，实测 turn2
     we=8/let's=6/let me=1，不会衰减回 let me）。

同一套路由在客户端（DSH 侧）注入时，经过翻译层/中间代理可能被改写或丢弃而"不生效"；
本开关让代理兜底执行路由协议，与客户端是否安装路由插件无关。切换后立即生效并持久化到
`/data/settings.json`，无需重启。free-mode 门禁不受影响：改写后的第一条 system 消息仍以
`You are Buffy, the strategic coding assistant.` 开头，`end_turn` 签名工具照常补充。

> 提示：路由改写面向所有走 `/v1/chat/completions` 的客户端。若你的 Agent 自带路由预设，
> 建议关闭本开关（客户端已注入）；若 Agent 的路由经代理链"失效"，开启本开关由代理兜底。

---

## 基准测试与验证（Benchmark）

> **目标模型**：本项目的极简路由面向 **`deepseek/deepseek-v4-flash`（V4 Fast）**，
> 同时给出 `deepseek/deepseek-v4-pro` 的对照数据。判定思维链的特征词：
> `we` / `let's`（计划-集体）vs `let me`（执行-个体）在模型思维链（`reasoning_content`）
> 中的出现次数。

### 测试归属（谁做的）

| 测试 | 执行者 | 环境 |
|---|---|---|
| **理论实验 P1–P30**（persona 轴三行为带、近距离引导、首 token 自锚定等） | [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) 作者 **yjh051108** | 官方 API，`thinking.enabled + reasoning_effort=max`，21 点 × n=2 探针 |
| **本项目真实上游验证**（we/let's vs let me 实测） | freebuff-proxy 维护者（本仓库），使用真实 Freebuff 账号 | 本机部署 freebuff-proxy → `codebuff.com` 上游，流式抓取 `reasoning_content` 词频统计 |
| **合规/回归测试**（free-mode 门禁 + 路由改写） | freebuff-proxy 项目 `test/smoke.mjs`（自动化，mock 上游） | CI / `npm test`，覆盖 Buffy 门禁标记、`end_turn` 签名、reasoning 归一化、路由改写不变量 |

> 说明：真实上游验证为有限样本（每条件 n=1~3 次请求，热 session 复用，admit 次数受每日
> 免费额度限制），结果用于指示性对比，非严格统计实验；严格的行为学实验以 dsh-routing-suite
> 的 P1–P30 为准（Pro 为测量主体）。

### 思维链实测结果（本项目，真实上游）

同一任务「从零开发一个待办事项网页应用」/「修复崩溃 bug」，同一账号热 session：

| 模型 | 路由风格 | 任务 | we | let's | let me | 备注 |
|---|---|---|---|---|---|---|
| **v4-flash**（目标） | 关 | 构建 | 0 | 0 | 2~6 | 默认 let me 主导 |
| **v4-flash** | **spec**（近距锚定） | 构建 | 4~6 | 3 | 0（多数轮次） | we/let's 集体链出现；个别轮次切执行语域（方差） |
| **v4-flash** | **spec** + **标准模式客户端**（35K 完整系统提示） | 构建 | 11 | 2 | 16 | 链出现但被完整系统提示稀释（混合语域） |
| **v4-flash** | react | 构建 | 0 | 0 | 2~6 | let me 执行链 |
| **v4-flash** | auto（命中 spec） | 修复 | 3 | 0 | 0 | 集体链 |
| v4-pro（对照） | 关 | 构建 | 0 | 0 | 6 | 模型自带 doer 风格 |
| v4-pro（对照） | spec | 修复 | 7~12 | 2~4 | 0 | we/let's 集体链稳定 |
| v4-pro（对照） | react | 构建 | 0 | 0 | 4~6 | let me 执行链 |

结论：**钉死 `spec` 即把 we/let's 集体思维链路由到 v4-flash**（与 `react` 形成同模型
同任务下的语域翻转）；`auto` 让修复类任务自动命中该链。v4-flash 上必须走近距锚定，
远距（system 内）锚定会反噬——这也是本实现按模型自适应锚定位置的原因。

### 客户端模式怎么选（实测指引）

| 客户端预设 | 是否走代理 | 效果 |
|---|---|---|
| 官方 **minimal**（极简模式） | 可直连，无需代理 | **纯 we/let's 链**（训练分布自带，实测 we=44/let's=18）；代价是工具面极小（约 2 个工具），代理能力受限 |
| 官方 **standard**（标准模式） | **推荐走代理**（路由开） | 功能完整（全工具/子代理/工作流）+ 代理兜底注入路由：we/let's 链**出现**（we=11）但被完整系统提示稀释为混合语域；配合「免费模型分散」多账号并行，吞吐更高 |
| 自定义路由预设（如 router-standard） | **不要**与代理路由同时开 | 两层路由互相打架（实测客户端 weak 引导 × 代理 spec 锚定 → 模型走中性语域） |

> 想要**最纯的 we/let's 链**：客户端选 minimal。想要**完整能力 + 代理的稳定性/并行**：
> 客户端选 standard，代理开极简路由（spec），接受混合语域；或客户端 minimal + 代理
> 双保险（minimal 自带链，代理兜底注入）。

---

## 幽灵连接治理与重启兜底

### 上游卡死自动掐断（不再有幽灵连接）

上游流式响应偶尔会出现"发了一半不再吐数据、也不断开连接"的卡死状态（幽灵连接），
会让该连接永远挂着并拖住后续请求。代理现在对上游响应体做了 **idle 超时兜底**：

- 收到响应头后，只要超过 `limits.stream_idle_timeout_sec`（默认 120 秒）没有新数据块，
  立即取消上游读取并**断开下游连接**，让客户端感知截断后自行重试——而不是无限期挂着；
- 断开后**不冷却该账号**（session 本身可能正常，只是那次传输卡了），下一个请求仍可
  复用同一 session；账号级串行化保证同一个账号不会同时被多个卡死请求叠加占用；
- 后台控制面请求（session / agent-runs 等）的 body 读取同样带超时兜底，杜绝任何路径挂死。

### 客户端断开立即释放账号锁（不再占死全部请求）

客户端中途断开（关页面/取消请求/超时放弃）时，上游流若还挂着，账号 chat 锁会被一直
占用，后续所有请求排队超时——**已修复**：代理同时监听底层 socket 关闭（`req 'close'`
是"请求体读完"事件，不可用作断开信号），断开瞬间中止上游读取并释放账号锁，下一个请求
立即可用。实测断开后 3 秒内恢复服务（修复前要等上游 120s 超时）。配合「免费模型分散」，
单个账号被占死也不会拖垮其它账号。

### 前端一键「全部断开重连」（轻量兜底）

右上角管理员专属「**全部断开重连**」按钮（`POST /api/system/reconnect`）：**比重启更轻量**，
进程不重启，仅释放全部账号的 session（上游 DELETE）并重置账号并发信号量（清空在途计数、
放行排队等待者）。用于清理死任务/幽灵连接等异常状态：

- 正在传输的 SSE 可能被中断，但**下一个请求会自动 re-admit 全新 session**，无需任何手动操作；
- Web 登录态、账号、代理池等全部保持不变；
- 权限：仅 admin 角色可调（非登录返回 401，非 admin 返回 403）。

### 前端一键「重启服务」（终极兜底）

右上角管理员专属「**重启服务**」按钮：服务端收到请求后 spawn 自重启子进程并优雅退出
（释放 session、关闭监听），子进程等待端口释放后无缝接管；Docker 场景下容器主进程退出
也会触发 `restart: unless-stopped` 整容器重建，双保险。

- 重启会中断所有在途连接约几秒，期间前端自动轮询 `/healthz`，恢复后提示并刷新；
- Web 登录态持久化在 `/data/web-sessions.json`，重启后无需重新登录；
- 权限：仅 admin 角色可见/可调（`POST /api/system/restart`），非登录请求返回 401。

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
`credentials/<账号ID>.json#proxy`（内部字段，仅脚本/手工维护，无 UI）> `upstream.proxy` > `HTTP(S)_PROXY` 环境变量 > 直连。

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
| 运行策略 | 控制台「免费额度策略」→ `/data/settings.json`（保存后立即生效） |
| 监听地址 | `server.host` / `port`（`FREEBUFF_PROXY_HOST` / `FREEBUFF_PROXY_PORT` 覆盖） |
| 管理员 | `ADMIN_USERNAME` / `ADMIN_PASSWORD`（或 `users.default_admin_*`） |
| 并发上限 | `limits.max_concurrent_requests` |
| 每账号并发（SSE 流数） | `limits.account_max_concurrency`（默认 1，控制台「负载均衡设置」实时调整） |
| 会话过期提前切换 | `session.re_admit_lead_sec`（默认 60s） |
| 上游流 idle 超时（幽灵连接治理） | `limits.stream_idle_timeout_sec`（默认 120s） |
| 账号级串行化排队上限 | `limits.account_chat_wait_ms`（默认 120000ms） |
| Web 会话有效期 | `web.session_ttl_hours`（默认 168h） |
| 配置文件路径 | 默认 `./config.yaml` 或 `FREEBUFF_PROXY_CONFIG` |
| 数据目录 | 默认 `./data` 或 `FREEBUFF_PROXY_DATA_DIR`（Docker 固定 `/data`） |

---

## 限制（官方免费层现实）

- Luna 等 premium：大约每天 6×1 小时 session（共享 premium 池）。
- Flash：CLI full 访问下次数较松，仍有 spend / IP / 容量限制。
- 同账号由另一个客户端重新 admit 可能触发 `superseded`；同一 `instanceId` 内的并发 chat 流可正常共用。多账号多 IP 场景在「代理设置」配多个代理即可，系统按账号稳定分配出口（见代理支持）。
- 地区 / VPN / 封禁由上游决定。
- 本项目**不**绕过风控，也**不**保证无限额度。
