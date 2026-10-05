# AGENTS.md -- freebuff-proxy 项目开发约定(用户要求, 违反即返工)

> 本文件是项目最高优先级开发约定.任何代码/部署/文档改动前先读这里.
> 用户明确强调: **不要每次来回折腾,不要浪费用户时间**.一次说清,一次做对.
## 本文件规则 (硬性)
1. **禁止未经允许编辑本文件**: 未经用户明确指示, 不得修改/追加/重写本文件任何内容.
2. **记忆禁止写回**: 过程记忆/运行状态/功能清单/教训日志一律落盘到 `data/`,`docs/` 等数据目录,
   严禁写入本文件.本文件只保留开发约定.
3. 本文件目标 ≤150 行; 新增约定需先征得用户同意, 并压缩替换旧内容.
## 项目定位
OpenAI 兼容的 Freebuff/Codebuff **免费额度反向代理**.卖点: **超级轻量** + **一键 Docker 部署**
+ **一切管理都在前端页面**.
### 定位红线(用户明确裁决, 永久有效)
- **BYOK 永久禁止**: 不得实现自备 key 通道(provider=`openrouter`/`openai-compatible`), 代码/提案/
  文档里都不得把它当出路重提(官方源码里存在 `normalizeByokBaseUrl` 也不得据此提出).
- **只做免费链路**, 不绕道第三方 provider. **只做用户当前要求的任务**, 不顺带提替代方案.
## 语言与运行时(2026-10-05 起)
- **全仓 TypeScript, 零 `.js`/`.mjs`/`.cjs`**: 受控文件全是 `.ts`, Node 22 原生直跑, 不引入打包器/
  转译器. 引用本仓文件**一律写 `.ts`**.
- 前端 `dashboard/**` 是 `.ts` 源, 服务端 `src/web/static.ts` 用 Node 内置 `stripTypeScriptTypes` 剥类型
  后直投浏览器 ---- 浏览器侧没有构建链. 类型检查 = `npm run typecheck`; `tsconfig.json` /
  `tsconfig.dashboard.json` / `tsconfig.checkjs.json` 各约束一层.
## 铁律(用户明确要求)
1. **轻量优先, 禁止加无用东西**: 镜像 = `node:22-alpine` + 仅 2 个运行时依赖(`undici`/`yaml`),
   保持现状. `docker-compose.yml` 保持最小(`image`/`container_name`/`restart`/`network_mode`/
   `environment`/`volumes`), 默认 `image: ghcr.io/hengxin666/freebuff-proxy:latest`(发版自动推送,
   `docker compose up -d` 免构建), `build: .` 仅本地开发/离线场景. **禁止**: `NETWORK_MODE` 变量,
   `init`,`extra_hosts`,`stop_grace_period`,重复的 healthcheck,多余的模块/依赖.
2. **网络模式 host**(Docker 官方方案, 解决"容器访问宿主机 127.0.0.1 代理"): `network_mode: host`,
   容器与宿主机共享网络栈. **host 模式下禁止写 `ports`**(官方文档: `-p` 被忽略并告警). 应用直接监听
   宿主 `0.0.0.0:${PORT}`, 经 `FREEBUFF_PROXY_PORT: "${PORT:-8787}"` 生效. 本机代理在控制台[代理设置]
   直接填 `http://127.0.0.1:<端口>`, 无需网关 IP / `host.docker.internal`.
3. **一切配置走前端页面, 禁止让用户改配置文件**: 代理(全局池)→ 前端[代理设置], 加/删/测试/保存
   **立即生效**, 持久化 `/data/proxies.json`; 账号 → 前端导入 JSON / 浏览器登录回调(服务端轮询,
   **不在容器内开浏览器**); 用户 → 前端用户管理(建/删/改密/重置 Key); 管理员密码 → `.env` 或首次
   启动日志. `config.yaml` 只作兜底默认值, 不是日常操作入口. 用户原话: "正常人谁会天天改配置,
   都是在前端页面操作的."
4. **不要向用户索要配置, 不要反复折腾**: 遇环境差异先自查代码/文档/日志, 能自己验证的自己验证再给
   结论; 交付前本地端到端验证(见[测试与验证]), 不把问题丢给用户.
5. **数据全在 `/data`(挂载宿主机 `./data`)**, 删容器不丢数据. 首次启动自动生成 `config.yaml`,
   entrypoint 以 root 初始化属主后降权到 `node`.
## 代码质量红线(17 条门禁, 违反即返工)
```bash
node scripts/gates/run.ts          # 全部 17 条 · node scripts/gates/run.ts <lane> 按 lane 跑
```
- **体量**: 后端 ≤300 行/文件, 前端 ≤500 行/文件, 同目录 ≤5 个受控文件(唯一例外 `src/` 顶层 12 个,
  已知且故意保留). **结构**: 单函数 ≤80 行; 导出符号必须有 JSDoc 且 `@param`/`@returns` 与签名一致.
- **文本**: 注释与文档禁全角标点(逐文件棘轮, 只许降),禁 emoji/颜文字,注释里禁 markdown 语法;
  格式六条(缩进/行尾/末尾换行/BOM/CRLF/行宽). **契约**: 路由分流表,上游契约快照,响应契约快照,
  i18n 各有独立门禁对账.
- **棘轮**: `.gates/*.json` 是"有多严"的基线, 只许降不许涨; 重录唯一入口是门禁 `--update`(语义是
  "承认这次变化", 不是"让门禁通过"), 且必须说明理由. **纪律**: 断言必须**可证伪** ---- 写完测试后
  临时破坏实现, 确认它变红, 再还原.
## 代理(重点)
- **全局代理池** `upstream.proxies` 由前端[代理设置]管理, 改动立即生效.
- **用户只需添加一个/多个代理**, 账号到代理的分配是**系统内部分配**(稳定哈希: 同一账号同一出口,
  保持 session IP 稳定; 某代理失败自动回落池内下一个) ---- **禁止**在前端要求用户按账号配置出口.
- 优先级: 账号显式 `proxy`(凭据文件字段, 仅内部支持)> 全局池 > `upstream.proxy` > `HTTP(S)_PROXY` > 直连.
- **代理测试** `POST /api/proxy/test`: 输出出口 IP / 国家 / 延迟 / codebuff 状态; 报错必须带底层原因码
  (ENOTFOUND/ECONNREFUSED/ETIMEDOUT).
- 容器内 `127.0.0.1` = 容器自己; 访问宿主机代理用 docker 网关 IP 或 `host.docker.internal`(前者优先).
## 额度 / 配额 / 负载均衡
- 前端展示上游 `rateLimitsByModel`(每模型 `已用/上限/重置时间`); 额度仅在 admit/活跃 session 时返回.
  另提供**只读探测刷新** `POST /api/accounts/probe`(只 GET, 不创建 session, 不占额度); 导入账号后自动探测.
- **切号规则**: 账号级故障(`rate_limited`/`spend_limited`/`ip_capped`/`banned`/403/5xx/startAgentRun
  失败/网络超时)整号冷却换下一个; `model_unavailable` 只冷却该模型; **4xx 客户端错误不换号**; 槽位类
  (`purchase_capacity`/`purchase_in_use`/`premium_slot_taken`)与 **503** 只跳过不冷却.
- **两本账是并行的两道闸门**(一手实测: 一笔会话 units `0.1→1.1` **且** Freebucks `5→0`):
  `session_units`(`rateLimitsByModel.recentCount`, 上限 6, **小数**)与 **Freebucks(每日池 + 余额)** 各自
  独立扣费, 调度**两道都要过**(`units_exhausted`/`freebucks_exhausted` 各自成立). **Freebucks 才是上游
  真正的拒付判据**(units 充足时仍可能因 `freebucksShortfall` 被 `rate_limited`), **绝不能拆掉**.
- **一次 admit = 买断一小时**: 这一小时内继续发请求**边际成本为 0**; 早退 DELETE **不退 Freebucks**
  (只回 `freebucksRefundPending`), 所以**付费时段内绝不为空闲释放**. 详见
  `notes/architecture/2026-09-14-paid-hour-hold.md`,`docs/design/freebucks-strategy.html`.
- **换号有成本**: 单请求最多新建 `limits.max_new_sessions_per_request`(默认 2)条会话; 复用热 session
  与被拒的 admit 不占预算; 非账号级瞬时故障先同账号重试一次.
- **`free_mode_capacity_deferred` 不冷却**(瞬时容量排队, 同 session 重试即恢复); gate 错误
  (session_expired/superseded/waiting_room)先同账号 re-admit **一次**, 仍失败才换号冷却.
- **session 轮询 GET 在有请求在途时跳过**(否则干扰活跃会话).
- **粘性优先调度(drain, not rotate)**: 选号排序 = 同模型热 session > 已用过的账号 > 从未用过的账号
  (最后); **绝不主动把并发平摊到多个账号**(上游把轮换账号当农场特征, 且每次 admit 都买断一小时).
  并发上限是"溢出"阈值, 不是"换号"阈值 ---- 满了先有界排队(`account_busy` 后才换号). 无同模型热
  session 时优先**冷账号**, 未用账号排最后; 同层内已用 > 未用, 最近用过的优先.
- **Flash / MiMo 纳入每日配额**: `deepseek/deepseek-v4-flash`,`mimo/mimo-v2.5` 不再硬编码为不限量;
  前端和 API 始终以上游 `rateLimitsByModel` 的实时 `recentCount / limit / resetAt` 为准.
## Session 行为 / Web 控制台
- **同模型活跃 session 始终优先复用**(创建才扣额度); 无会话记忆/分组, `conversation_id` 不决定账号.
- 同一 `instanceId` 支持并发 chat; 后台 session GET 在有请求在途时**必须跳过**.
- **付费时段内不释放**; 到期后按 `session.idle_release_sec` 释放以腾出槽位. DELETE 必须带
  `x-freebuff-instance-id`. 实现在 `session-manager._armIdleRelease` + `inPaidWindow()`.
- 控制台: 登录 / 用户管理(admin) / 账号导入与浏览器登录回调 / 测试对话(playground) / 总览(账号池,
  额度, 请求分布, 冷却, 代理出口) / **代理设置**(全局池管理).
## CI / 部署
- GitHub Actions(`.github/workflows/docker-image.yml`): push main/tag → test + typecheck + 构建推送
  GHCR; pull_request 只测不推; 带 GHA 缓存. **教训**: `secrets` 不允许出现在 step 级 `if:`, 需先提升
  为 workflow 级 `env` 再用 `env.X` 判断. 升级: `git pull && docker compose pull && docker compose up -d`.
## 版本管理(硬性, 发版必读)
- **[发版]= 打 `v*` tag + 发布 GitHub Release**. 只 bump 版本号不打 tag, 或只打 tag 不发 release,
  都不算完成. 流程: `npm version patch|minor|major` → `git push origin main --tags` →
  `gh release create vX.Y.Z --notes-file -`. Release notes 必须写清**修了什么,为什么,升级方式**;
  协议/判据有变化附实测证据. **不要把 `npm version --dry-run` 当预演**(实测它会照样改文件/建提交/打 tag).
- **唯一版本真源 = `package.json` 的 `version`**. **禁止**跳过 `npm version` 手动改 version 后打 tag.
  CI 的 `check-version` job 校验 git tag(`v*`)与该字段一致, 不一致直接 fail.
- **镜像内版本号由流水线硬编码**: `build-push` 跑 `node scripts/release/inject-version.ts --version
  <tag版本> --repo <仓库>` 生成 `dashboard/version.json` 写进镜像; 前端 `vX.Y.Z` 徽章读它, 本地没有时
  fallback 显示 `dev`. 该文件是构建产物(.gitignore 已忽略), **禁止手工编辑/提交**.
## 测试与验证(提交前必须全过)
```bash
npm test             # smoke(mock 上游: session 复用/并发冷启动/冷却换号/代理池/probe/代理测试)
npm run typecheck && npm run check:gates   # 17 条代码质量红线
npm run check:all                          # 契约 + catalog + typecheck + smoke
docker compose config --quiet && docker build .
```
- 改动网络/代理/部署相关, 必须本地起容器端到端验证(healthz / 登录 / 导入 / 探测 / 代理测试 / 真实
  对话)后再提交. 真实账号验证注意: admit 会消耗每日额度, 尽量用 GET 探测或控制次数.
- **额度为 0 不等于账号不可用**: 先看上游会话清单有没有**同模型, 未过期**的已付费会话
  (`desktopPurchases[].holderInstanceId`, 含**别的部署**建的) ---- 有就接管复用, **绝不**因余额不足跳过.
## 按症状查文档(先读这里, 再动手)
> 遇到下列情况**先读对应文档**, 不要凭直觉改代码. 路径相对仓库根; `notes` 指
> `.agents/notes/implemented/`; 文档总入口 = `docs/README.md`.

| 症状 / 场景 | 先读 |
|---|---|
| 模型名/标识对不上, 映射错模型, 清单匹配不上 | `docs/reverse/19-catalog-is-the-model-list.md` + `notes/architecture/2026-10-04-model-name-three-layers.md`. **唯一真源** = `CatalogHolder.keyForName`, 上层入口 `AccountRuntimes.resolveModelAlias` / `displayNameFor`. 禁止另写映射 |
| 余额不足 / 明明有额度却 429 / 有会话不复用 | `notes/architecture/2026-10-04-session-inventory-from-upstream.md`. 先查 `desktopPurchases` 并 takeover 复用 |
| 上游 503 / "model is temporarily unavailable" | `docs/reverse/07-503-root-cause.md`. **模型侧**问题, 不得冷却账号 |
| 账号被封 / 排查封禁原因 | `docs/reverse/06-ban-forensics.md`,`docs/reverse/08-second-ban-and-byok.md` |
| 工具集 / 客户端自带工具 / foreign client 警告 | `docs/reverse/18-channel-guide-and-tool-mapping.md`(含 §4.1 单变量实测),`docs/reverse/04-chat-and-tools.md` |
| session 建不起来 / purchase_claim_released / purchase_capacity | `docs/reverse/03-session-admission.md`,`docs/reverse/12-waiting-room-slot-contention.md` |
| 付费时段不能换模型 / 早退退不退款 | `notes/architecture/2026-09-14-paid-hour-hold.md`,`notes/architecture/2026-09-14-two-ledgers-parallel-gates.md` |
| 请求头/形态与官方不符, 通道选择 | `docs/reverse/21-client-request-reference.md`,`notes/architecture/2026-10-03-official-channel-rpc-delegation.md` |
| 该不该发请求给上游(零自动探测) | `docs/reverse/20-upstream-endpoint-whitelist.md` |
| 文档该放哪 / 改文档要注意什么 | `docs/README.md`(分类 + 三条硬约定 + 真源地图) |
| 门禁红了 / 判据与棘轮怎么用 | `docs/quality/code-quality-landscape.md` + `node scripts/gates/run.ts --list` |

**验证方法论(硬性)**: 结论必须来自**实测**(远程日志 / 直连上游回执 / 单变量对照), 不得只凭源码推断
---- 本仓已多次出现"源码看起来该如此, 实测相反".

# Agent Notes -- 决策记录
非平凡改动(改变行为/架构/跨文件契约/流程或工具/测试策略/落盘或线上格式)必须在**同一次提交里**新增
或更新一篇 Agent Note; 纯机械的局部编辑豁免.
- 改声明前先找它旁边引用的 note(`.agents/notes/<lifecycle>/<class>/<file>.md`), 先读它记着否决过什么.
- **一篇 note 只管一条决策**; 事实移动(路径/名字/默认值)就地重写, 绝不改写成另一条决策 ---- 要取代它
  就双向互链. 新方向从 `proposed/{class}/` 起, 落地时同提交移到 `implemented/{class}/`.
- 每篇 active note 必带 `## Alternatives considered`, 其中必须有"什么都不做 / 复用现有", 且每个被否选项
  先给最强理由再否决. 完全取代用 `notes:archive`; 拦不住重犯的 rejected 提案直接删.
- 推送前跑 `npm run verify-notes`. 受保护源码(见 `.agents/notes.config.json` 的 `coverage.guarded`)改动
  若同一次改动里没有 note, 门禁会失败; 要刻意豁免写 `.agents/notes/NOTE-EXEMPT.md`, 内容为
  `note-exempt: <为什么这次不需要 note>`. 规则细节见 `.agents/notes/AGENTS.md`.
