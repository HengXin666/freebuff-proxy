# AGENTS.md — freebuff-proxy 项目开发约定(用户要求, 违反即返工)

> 本文件是项目最高优先级开发约定.任何代码/部署/文档改动前先读这里.
> 用户明确强调: **不要每次来回折腾,不要浪费用户时间**.一次说清,一次做对.

## 本文件规则 (硬性)

1. **禁止未经允许编辑本文件**: 未经用户明确指示, 不得修改/追加/重写本文件任何内容.
2. **记忆禁止写回**: 过程记忆,运行状态,功能清单,教训日志等一律落盘到项目数据目录
   (`data/`,`docs/` 等), 严禁写入本文件.本文件只保留开发约定.
3. 本文件目标 ≤150 行; 新增约定需先征得用户同意, 并压缩替换旧内容.

## 项目定位
OpenAI 兼容的 Freebuff/Codebuff **免费额度反向代理**.核心卖点:
**超级轻量** + **一键 Docker 部署** + **一切管理都在前端页面**.

### 定位红线(用户明确裁决, 永久有效)

- **BYOK 永久禁止**: 不得实现自备 key 通道(provider=`openrouter`/`openai-compatible`),
  代码/提案/文档里都不得把它当出路重提(官方源码里存在 `normalizeByokBaseUrl` 也不得据此提出).
- **只做免费链路**, 不绕道第三方 provider.
- **只做用户当前要求的任务**, 不顺带提替代方案.

## 铁律(用户明确要求)

1. **轻量优先, 禁止加无用东西**
   - 镜像 = `node:22-alpine` + 仅 2 个运行时依赖(`undici` / `yaml`), 保持现状.
   - `docker-compose.yml` 保持最小: `image / container_name / restart /
     network_mode / environment / volumes`; 默认 `image: ghcr.io/hengxin666/freebuff-proxy:latest`
     (发版自动推送, `docker compose up -d` 免构建), `build: .` 仅本地开发/离线场景.
   - **禁止**: `NETWORK_MODE` 变量,`init`,`extra_hosts`,`stop_grace_period`,
     重复的 healthcheck(Dockerfile 里已有),多余的 docker 模块/依赖.

2. **网络模式: host(Docker 官方方案, 解决"容器访问宿主机 127.0.0.1 代理")**
   - `network_mode: host`, 容器与宿主机共享网络栈.
   - **host 模式下禁止写 `ports`**(官方文档: `-p` 被忽略并告警 `Published ports are
     discarded when using host network mode`)。应用直接监听宿主 `0.0.0.0:${PORT}`,
     通过 `FREEBUFF_PROXY_PORT: "${PORT:-8787}"` 让 `PORT` 生效; 访问 `http://<机器IP>:<PORT>`.
   - 本机代理在控制台[代理设置]直接填 `http://127.0.0.1:<端口>` 即可, 无需网关 IP /
     `host.docker.internal`.

3. **一切配置走前端页面, 禁止让用户改配置文件**
   - 代理(全局池)→ 前端[代理设置]: 加/删/测试/保存**立即生效**, 持久化 `/data/proxies.json`.
   - 账号 → 前端导入 JSON / 浏览器登录回调(服务端轮询, **不在容器内开浏览器**).
   - 用户 → 前端用户管理(建/删/改密/重置 Key).
   - 管理员密码 → `.env` 或首次启动日志.
   - `config.yaml` 只作兜底默认值, 不是日常操作入口.
   - 用户原话: "正常人谁会天天改配置, 都是在前端页面操作的."

4. **不要向用户索要配置,不要反复折腾**
   - 遇到环境差异: 先自查代码/文档/日志, 能自己验证的自己验证, 再给结论.
   - 每次交付前本地端到端验证(见[测试与验证]), 不把问题丢给用户.

5. **数据全在 `/data`(挂载宿主机 `./data`)**, 删容器不丢数据.
   首次启动自动生成 `config.yaml`, entrypoint 以 root 初始化属主后降权到 `node`.

## 代理(重点)

- **全局代理池** `upstream.proxies`, 由前端[代理设置]管理, 改动立即生效.
- **用户只需要添加一个/多个代理**, 账号到代理的分配是**系统内部分配**(稳定哈希:
  同一账号同一出口, 保持 session IP 稳定; 某代理连接失败自动回落池内下一个)——
  **禁止**在前端要求用户按账号配置出口(用户明确反对).
- 优先级: 账号显式 `proxy`(凭据文件字段, 仅内部支持)> 全局池 > `upstream.proxy` > `HTTP(S)_PROXY` env > 直连.
- **代理测试**: `POST /api/proxy/test`, 输出出口 IP / 国家 / 延迟 / codebuff 状态;
  报错必须带底层原因码(ENOTFOUND/ECONNREFUSED/ETIMEDOUT).
- 容器内 `127.0.0.1` = 容器自己; 访问宿主机代理用 docker 网关 IP 或 `host.docker.internal`
  (前者优先, 后者曾被批评为误导).

## 额度 / 配额 / 负载均衡

- 前端展示上游 `rateLimitsByModel`(每模型 `已用/上限/重置时间`); 额度仅在 admit/活跃 session 时由上游返回.
- 提供**只读探测刷新**(`POST /api/accounts/probe`, 只 GET,不创建 session,不占额度); 导入账号后自动探测.
- 切号规则: 账号级故障(`rate_limited`/`spend_limited`/`ip_capped`/`banned`/403/5xx/startAgentRun 失败/网络超时)
  整号冷却换下一个; `model_unavailable` 只冷却该模型; **4xx 客户端错误不换号**;
  槽位类(`purchase_capacity`/`purchase_in_use`/`premium_slot_taken`)与 **503** 只跳过不冷却.
- **两本账是并行的两道闸门**(一手实测: 一笔会话 units `0.1→1.1` **且** Freebucks `5→0`):
  `session_units`(`rateLimitsByModel.recentCount`, 上限 6, **小数**)与 **Freebucks(每日池 + 余额)**
  各自独立扣费, 所以调度**两道都要过**(`units_exhausted` / `freebucks_exhausted` 各自成立).
   **Freebucks 才是上游真正的拒付判据**(units 充足时仍可能因 `freebucksShortfall` 被 `rate_limited`),
  **绝不能拆掉**.
- **一次 admit = 买断一小时**; 这一小时内继续发请求**边际成本为 0**;
  早退 DELETE **不退 Freebucks**(只回 `freebucksRefundPending`), 所以**付费时段内绝不为空闲释放**.
  详见 `notes/architecture/2026-09-14-paid-hour-hold.md`,`docs/freebucks-strategy.html`.
- **换号有成本**: 单请求最多新建 `limits.max_new_sessions_per_request`(默认 2)条会话;
  复用热 session 与被拒的 admit 不占预算; 非账号级瞬时故障先同账号重试一次.
- **`free_mode_capacity_deferred` 不冷却**(瞬时容量排队, 同 session 重试即恢复);
  gate 错误(session_expired/superseded/waiting_room)先同账号 re-admit **一次**, 仍失败才换号冷却.
- **session 轮询 GET 在有请求在途时跳过**(否则干扰活跃会话).
- **粘性优先调度(drain, not rotate)**: 选号排序 = 同模型热 session > 已用过的账号 >
  从未用过的账号(最后); **绝不主动把并发平摊到多个账号**(上游把轮换账号当农场特征,
  且每次 admit 都买断一小时).并发上限是"溢出"阈值, 不是"换号"阈值
  —— 满了先有界排队(`account_busy` 后才换号).
- 无同模型热 session 时: 优先**冷账号**, 未用账号排最后; 同层内已用 > 未用,最近用过的优先.
- **Flash / MiMo 纳入每日配额**: `deepseek/deepseek-v4-flash`,`mimo/mimo-v2.5`
  不再硬编码为不限量; 前端和 API 始终以上游 `rateLimitsByModel` 的实时 `recentCount / limit / resetAt` 为准.

## Session 行为

- **同模型活跃 session 始终优先复用**(创建才扣额度); 无会话记忆/分组, `conversation_id` 不决定账号.
- 同一 `instanceId` 支持并发 chat; 后台 session GET 在有请求在途时**必须跳过**.
- **付费时段内不释放**; 到期后按 `session.idle_release_sec` 释放以腾出槽位.
  DELETE 必须带 `x-freebuff-instance-id`.实现在 `session-manager._armIdleRelease` + `inPaidWindow()`.

## Web 控制台

登录 / 用户管理(admin 角色)/ 账号导入与浏览器登录回调 / 测试对话(playground)/
总览(账号池,额度,请求分布,冷却,代理出口)/ **代理设置**(全局池管理).

## CI / 部署

- GitHub Actions(`.github/workflows/docker-image.yml`): push main/tag → test + typecheck + 构建推送 GHCR;
  pull_request 只测不推; 带 GHA 缓存.
- **教训**: `secrets` 不允许出现在 step 级 `if:`, 需先提升为 workflow 级 `env` 再用 `env.X` 判断.
- 升级方式: `git pull && docker compose pull && docker compose up -d`.

## 版本管理(硬性, 发版必读)

0. **[发版]= 打 `v*` tag + 发布 GitHub Release**(用户明确约定).
   只 bump 版本号不打 tag,或只打 tag 不发 release, 都不算发版完成.
   完整发版流程:
   ```bash
   npm version patch|minor|major              # bump package.json + commit + 打 v* tag
   git push origin main --tags                # 推提交与 tag(触发 CI 构建推送镜像)
   gh release create vX.Y.Z --title "..." --notes-file -   # 发布 release
   ```
   Release notes 必须写清**修了什么,为什么,升级方式**; 涉及协议/判据变化的附实测证据.

1. **唯一版本真源 = `package.json` 的 `version` 字段**.本地开发/测试以它为准.
   **禁止**跳过 `npm version` 直接手动改 version 后打 tag——两者不一致会被门禁拦下.
2. **流水线强制门禁**: CI 的 `check-version` job 校验 git tag(`v*`)与 package.json 版本必须一致,
   不一致直接 fail.这就是[发版必须更新版本号]的硬保障, 不需要人工提醒.
3. **镜像内版本号由流水线硬编码**: `build-push` 在 docker build 前跑
   `node scripts/release/inject-version.mjs --version <tag版本> --repo <仓库>`,
   生成 `dashboard/version.json`(含 version + repo + commit sha)写进镜像.
   前端 header 的 `vX.Y.Z` 徽章就是读它——**镜像里显示什么版本完全由流水线决定**,
   与本地文件无关; 本地没有 version.json 时前端 fallback 显示 `dev`.
4. `dashboard/version.json` 是构建产物(.gitignore 已忽略), **禁止手工编辑/提交**;
   要改版本只能走 `npm version` + 重新构建.

## 测试与验证(提交前必须全过)

```bash
npm test            # smoke(mock 上游: session 复用/并发冷启动/冷却换号/代理池/probe/代理测试)
npm run typecheck
docker compose config --quiet
docker build .
```

- 改动网络/代理/部署相关, 必须本地起容器端到端验证(healthz / 登录 / 导入 / 探测 / 代理测试 / 真实对话)后再提交.
- 真实账号验证注意: admit 会消耗每日额度, 尽量用 GET 探测或控制次数.
- **额度为 0 不等于账号不可用**: 先看上游会话清单有没有**同模型,未过期**的已付费会话
  (`desktopPurchases[].holderInstanceId`, 含**别的部署**建的) —— 有就接管复用,
  **绝不**因为余额不足跳过该账号.见[按症状查文档]的 *余额不足* 行.

---

## 按症状查文档(先读这里, 再动手)

> 遇到下列情况**先读对应文档**, 不要凭直觉改代码 —— 这些坑都踩过, 结论与反例都在文档里.
> 路径相对仓库根; `notes` 指 `.agents/notes/implemented/`.

| 症状 / 场景 | 先读 |
|---|---|
| 模型名/标识对不上,映射错模型,清单匹配不上 | `docs/reverse/19-catalog-is-the-model-list.md` + `notes/architecture/2026-10-04-model-name-three-layers.md`.**唯一真源** = `CatalogHolder.keyForName`(支持目录 key / 上游 legacy id / 可读名), 上层入口 `AccountRuntimes.resolveModelAlias` / `displayNameFor`.禁止另写映射 |
| 余额不足 / 明明有额度却 429 / 有会话不复用 | `notes/architecture/2026-10-04-session-inventory-from-upstream.md`.先查上游 `desktopPurchases` 并 takeover 复用 |
| 上游 503 / "model is temporarily unavailable" | `docs/reverse/07-503-root-cause.md`.**模型侧**问题, 不得冷却账号(会把唯一有钱的号踢出池子) |
| 账号被封 / 排查封禁原因 | `docs/reverse/06-ban-forensics.md`,`docs/reverse/08-second-ban-and-byok.md` |
| 工具集 / 客户端自带工具 / foreign client 警告 | `docs/reverse/18-channel-guide-and-tool-mapping.md`(含 §4.1 单变量实测),`docs/reverse/04-chat-and-tools.md` |
| session 建不起来 / purchase_claim_released / purchase_capacity | `docs/reverse/03-session-admission.md`,`docs/reverse/12-waiting-room-slot-contention.md` |
| 付费时段不能换模型 / 早退退不退款 | `notes/architecture/2026-09-14-paid-hour-hold.md`,`notes/architecture/2026-09-14-two-ledgers-parallel-gates.md` |
| 请求头/形态与官方不符,通道选择 | `docs/reverse/21-client-request-reference.md`,`notes/architecture/2026-10-03-official-channel-rpc-delegation.md` |
| 该不该发请求给上游(零自动探测) | `docs/reverse/20-upstream-endpoint-whitelist.md` |

**验证方法论(硬性)**: 结论必须来自**实测**(远程日志 / 直连上游回执 / 单变量对照),
不得只凭源码推断 —— 本仓已多次出现"源码看起来该如此,实测相反".
断言必须**可证伪**: 写完测试后临时破坏实现, 确认它变红, 再还原.

---

# Agent Notes — 决策记录

非平凡改动的定义: 改变行为,架构,跨文件的契约,流程或工具,测试策略, 或任何落盘 / 线上 / 配置格式.
每一次非平凡改动都在**同一次提交里**新增或更新一篇 Agent Note; 纯机械的局部编辑豁免.

1. 改一个声明之前, 先找它旁边引用的 note —— `.agents/notes/<lifecycle>/<class>/<file>.md` 路径,
   通常写在注释或 JSDoc 里.先读它: 它记着已经否决过什么,为什么.
2. 优先更新已经拥有那条决策的 note.过时的事实**就地重写**, 不要追加变更历史;
   绝不把一篇 note 改写成另一条决策 —— 要取代它, 并双向互链.
3. 新方向从 `.agents/notes/proposed/{class}/` 开始; 落地时在同一提交里移到
   `implemented/{class}/`, 用现在时陈述, 并从它约束的代码里引用它 (见第 1 条).
4. 每一篇 active note 都带 `## Alternatives considered`, 其中必须有"什么都不做 / 复用现有"
   这一项, 且每个被否掉的选项都要先给出它最强的理由, 再否决.
5. note 被完全取代时用 `notes:archive` 归档; rejected 提案不再能拦住一个
   有人可能重犯的错误时, 直接删除.

推送前跑 `npm run verify-notes`.受保护的源码改动若同一次改动里没有 note, 门禁会失败;
要刻意豁免, 写 `.agents/notes/NOTE-EXEMPT.md`, 内容为 `note-exempt: <为什么这次不需要 note>`.
规则细节见 `.agents/notes/AGENTS.md`.
