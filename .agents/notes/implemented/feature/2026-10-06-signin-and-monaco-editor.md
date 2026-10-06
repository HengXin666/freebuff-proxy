# Agent Note: 一键/自动签到 + 官方端点白名单的一处扩到 streak + Monaco 编辑器

Status: implemented

## Problem

用户提出三项: (1) 提示词编辑器要 VSCode 同款 + One Dark Pro; (2) 总览页一键签到
(所有存活账号一轮, 18 小时内防抖), 设置页自动签到(默认关, 25 小时间隔);
(3) 相关的 `GET /api/streak` 与 `freebucksDailyBonus` 语义.

排查后发现三件事都需要先定真相:

**一, "签到"在这个上游不存在一个可调的接口.** 客户端全仓只有一处 streak 调用:
`GET /api/v1/freebuff/streak`(`createDesktopStreak.fetch`), **只读**, 报告
streak / todayUsed / todayCredited / freebucksDailyBonus / nextResetAt /
bonusExpiresAt. 真正的[签到]由官方文案定义的动作触发:
"+{freebucksDailyBonus} to your daily allowance with each day's first message"
---- 即**当天第一条消息**.

**二, 该端点不在我们的抓包里.** 抓包时段(2026-10-03)没覆盖到它, 所以
`REQUIRED_ENDPOINTS` 里没有它. 但项目铁律是"客户端没发过的请求全部不能用"
(`docs/reverse/20`), 于是这里出现一个真冲突: 用户授予的新能力 vs 既定纪律.

**三, 签到要花钱.** `admit = 买断一小时`
(`.agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md`),
发一条消息会按整小时单价预扣. 所以"一键签到"绝不能无脑对每个账号发消息.

## Decision

**端点**: 新增 `EP_STREAK = '/api/v1/freebuff/streak'`, 并**把出处写进常量注释**
(客户端产物里 streak service 的 fetch 原文), 同时把
`REQUIRED_ENDPOINTS` 的成员分成两类: 抓包生成的那批, 与[产物里确认存在但
抓包时段未覆盖]的这一条. 契约门禁通过(7 个端点全部登记).

**成本纪律放在最前面**: `runSignInRound` 的顺序固定为
先读 streak -> `alreadySignedToday()` 为真则跳过 -> 才发最小消息.
状态读不到时记 `streak_unavailable` 失败, **不猜也不试** ----
"读不到就盲发一次"会让每个异常账号都白花一小时的钱.

**签到动作**: `ensureSession`(优先复用热会话, 已买过的那一小时不重复扣费)
+ 一条 `hi` 的最小 chat. 模型优先选 `freebucks.prices` 里单价为 0 的.

**防抖**: 手动 18h / 自动 25h, 判据落在服务端 `data/signin.json`
(`SignInStore.manualAllowed/autoDue`), 刷新页面绕不过; 前端只把剩余时间画出来.

**自动签到默认关闭**: 它要发消息(有成本), 替用户默认打开是错的.
调度器每轮重读 `autoSignInEnabled`, 关了不用重启.
间隔取 25 而非 24 小时: 签到按[太平洋日]重置, 24 小时整会在跨时区/夏令时边界
上出现"同一自然日触发两次".

**编辑器**: `dashboard/vendor/monaco/` 放 Monaco 的**最小集合**(loader +
editor.main + worker + JSON 高亮 + One Dark Pro 主题, 约 4.2MB);
`dashboard/lib/editor.ts` 封装加载与降级(加载失败回落原生 textarea);
主题取自 `@shikijs/themes` 的官方 `one-dark-pro`, 直接喂 `defineTheme`.

## Alternatives considered

**只用只读的 `GET /api/v1/freebuff/streak` 当作"签到".** 否决: 它只报告状态,
不产生签到. 把它当签到等于给用户一个永远显示"没签上"的按钮.

**新建一个我们自己的 `POST /api/signin` 打上游的签到端点.** 否决: 上游没有
这个端点. 客户端产物里 streak 只有一个 GET, 任何 POST 都是我们凭空造的形态 ----
正是 `docs/reverse/20` 要根除的那类流量.

**一键签到不读状态, 直接对每个账号发一条消息.** 否决: 会重复付费.
已签过的账号再发一次, 那一小时的钱照扣, 而 streak 不会再加.
先读后发的顺序是本决策里唯一不可退让的部分.

**把自动签到默认打开.** 否决: 它花钱. 默认值该选最省的那个, 让用户显式开启.

**Monaco 走 CDN 而不是 vendor.** 否决: 控制台常在没有外网的环境里跑,
CDN 拉不到时提示词编辑器变白板 ---- 而那正是排障最需要的输入框.

**不引 Monaco, 用 CodeMirror 或纯 textarea.** 否决: 用户明确要求
"VSCode 同款的编辑器 + One Dark Pro 主题". textarea 保留为降级路径.

**把 Monaco 全量 `min/` 一起 vendored(14MB).** 否决: 其中 7MB 是 language
server, 640KB 是 40+ 种语言高亮 ---- 而这个编辑器只编辑纯文本提示词.
只留 editor 核心 + JSON, 压到 4.2MB.

## Consequences

- `/api/signin`(GET 状态 / POST 一键签到)与 `data/signin.json` 新增;
  自动签到调度挂在 `bin/serve.ts` 的 `startSideTasks`(端口监听之后才起).
- 手动签到 18h 防抖, 自动 25h; 两者都默认不花钱(已签跳过 + 自动默认关).
- `dashboard/vendor/monaco/` 进仓约 4.2MB, 并在 `scripts/gates/rules.ts` 的
  `TIERS.exempt` 与 `tsconfig.dashboard.json` 的 `exclude` 里同时豁免 ----
  少了任一处, 门禁或类型检查都会把它扫进来(实测: 不排除会灌进 3.7 万条类型错误).
- 依 `dir-files` / `sizes` / `functions` 三条红线拆了若干文件
  (proxy/switches/, rpc/streak.ts, settings/read.ts 等), 见各文件头.
