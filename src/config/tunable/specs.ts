/**
 * 可调项真源: 配置里除 server.host / server.port 之外的每一项, 都在这张表里.
 *
 * ## 为什么要有这张表
 *
 * 用户裁决(2026-10-05): config.yaml 只留 server.host / server.port,
 * 其余全部在前端设置页可调. 这句话要落地, 需要三处同时知道"有哪些项,各自什么类型,
 * 限度多少,默认值是什么":
 *
 *   - 后端 /api/settings 的读快照与写校验(src/web/routes/control/settings.ts);
 *   - 前端设置页控件的生成(dashboard/views/proxy/*);
 *   - 启动装配: 把 /data/settings.json 合并进 config(bin/serve/boot/stores.ts).
 *
 * 三处各写一份 = 改一处忘一处的经典形态(本仓已有先例: 同一组阈值被写进两处,
 * 变成"文档说 300, 脚本判 500", 而两边都看起来是对的). 因此这三处只从本表取.
 *
 * ## 生效方式: 保存后重启
 *
 * 用户裁决(2026-10-05): 设置保存后提示"需要重启生效", 而不是逐项做运行时可改.
 * 这让实现保持干净 ---- 启动时把 settings.json 深合进 config, 于是全仓
 * config.limits.xxx / config.session.xxx 的读取点一行都不用改,
 * 也不必为每项写 getter(现有 accountMaxConcurrency / accountSchedulingMode /
 * idleReleaseSec / maxNewSessionsPerRequest 三个实时 getter 保持原样继续工作).
 *
 * 代价是明确的: 保存后要重启才生效 ---- 所以前端必须显式提示这一点,
 * 否则用户会以为"保存了却没反应".
 */

/** 一个可调项的声明. */
export interface TunableSpec {
  /** 点分路径(相对 config 根), 如 limits.slotWaitMs. */
  path: string
  /** 值类型: 决定校验与前端控件. */
  type: 'boolean' | 'integer' | 'string' | 'stringList' | 'enum'
  /** enum 的合法取值. */
  values?: readonly string[]
  /** integer 的下限/上限. */
  min?: number
  max?: number
  /** 0 是否表示"关闭"(前端文案会据此说明). */
  zeroMeansOff?: boolean
  /** 归属分组(前端按组渲染卡片). */
  group: 'upstream' | 'session' | 'limits' | 'logging' | 'web' | 'users' | 'server'
  /** 中文短标签(前端显示). */
  label: string
}

/**
 * 可调项清单.
 *
 * 口径: 除了 server.host / server.port(用户裁决只留这两项在 config.yaml),
 * 以及下列"不该让前端改"的例外之外, DEFAULTS 里的每一项都必须在这里登记:
 *
 *   - server.dataDir  --  数据目录是进程级定位(settings.json 自己就在里面),
 *     能改它等于"用自己所在的位置重新定位自己", 循环依赖; 它由 env/挂载决定.
 *   - upstream.apiBase / upstream.channel -- apiBase 之所以硬编码是踩过事故的
 *     (见 src/config/defaults.ts 的 UPSTREAM_API_BASE 注释); channel 的 legacy
 *     值已废弃, 只剩 official, 在设置页给一个"只有一个有效值"的下拉是噪音.
 *   - upstream.credentialsDir -- 与控制台[账号]页的导入/登录回调路径强耦合,
 *     改错会让已导入账号"消失"(读的是另一个目录). 它由 dataDir 推导.
 *
 * 覆盖性由门禁 scripts/gates/checks/guard/tunables.ts 双向校验: 本表缺项,
 * 或表里有 DEFAULTS 已删除的陈旧项, 都会红.
 */
export const TUNABLES: readonly TunableSpec[] = Object.freeze([
  // ── 上游 ────────────────────────────────────────────────────────────
  { path: 'upstream.loginBase', type: 'string', group: 'upstream', label: '登录站点' },

  // ── 会话 ────────────────────────────────────────────────────────────
  { path: 'session.releaseOnShutdown', type: 'boolean', group: 'session', label: '退出时释放会话' },
  { path: 'session.reAdmitOnExpire', type: 'boolean', group: 'session', label: '过期前自动重开' },
  {
    path: 'session.reAdmitLeadSec',
    type: 'integer',
    min: 0,
    max: 3600,
    zeroMeansOff: true,
    group: 'session',
    label: '付费模型提前重开(秒)',
  },
  {
    path: 'session.freeModelReAdmitLeadSec',
    type: 'integer',
    min: 0,
    max: 3600,
    zeroMeansOff: true,
    group: 'session',
    label: '免费模型提前重开(秒)',
  },
  { path: 'session.pollIntervalSec', type: 'integer', min: 5, max: 3600, group: 'session', label: '会话轮询间隔(秒)' },
  { path: 'session.admitTimeoutMs', type: 'integer', min: 1000, max: 600_000, group: 'session', label: 'admit 超时(毫秒)' },

  // ── 限额 ────────────────────────────────────────────────────────────
  { path: 'limits.maxConcurrentRequests', type: 'integer', min: 1, max: 1024, group: 'limits', label: '全局并发上限' },
  {
    path: 'limits.slotWaitMs',
    type: 'integer',
    min: 0,
    max: 600_000,
    zeroMeansOff: true,
    group: 'limits',
    label: '全局排队上限(毫秒)',
  },
  {
    path: 'limits.bodyReadTimeoutMs',
    type: 'integer',
    min: 0,
    max: 600_000,
    zeroMeansOff: true,
    group: 'limits',
    label: '读请求体超时(毫秒)',
  },
  {
    path: 'limits.schedulingBudgetMs',
    type: 'integer',
    min: 0,
    max: 600_000,
    zeroMeansOff: true,
    group: 'limits',
    label: '首字节前调度预算(毫秒)',
  },
  {
    path: 'limits.accountChatWaitMs',
    type: 'integer',
    min: 0,
    max: 600_000,
    zeroMeansOff: true,
    group: 'limits',
    label: '账号锁等待(毫秒)',
  },
  { path: 'limits.upstreamTimeoutSec', type: 'integer', min: 10, max: 3600, group: 'limits', label: '上游总超时(秒)' },
  { path: 'limits.streamIdleTimeoutSec', type: 'integer', min: 5, max: 3600, group: 'limits', label: '流式 idle 超时(秒)' },
  {
    path: 'limits.stallCooldownSec',
    type: 'integer',
    min: 0,
    max: 86_400,
    zeroMeansOff: true,
    group: 'limits',
    label: '掐断后冷却(秒)',
  },
  {
    path: 'limits.requestJitterMs',
    type: 'integer',
    min: 0,
    max: 10_000,
    zeroMeansOff: true,
    group: 'limits',
    label: '请求抖动上限(毫秒)',
  },
  {
    path: 'limits.maxAutoRetryOnSessionError',
    type: 'integer',
    min: 0,
    max: 10,
    zeroMeansOff: true,
    group: 'limits',
    label: '会话错误自动重试',
  },

  // ── 日志 ────────────────────────────────────────────────────────────
  {
    path: 'logging.level', type: 'enum', values: ['debug', 'info', 'warn', 'error'],
    group: 'logging', label: '日志级别',
  },
  {
    path: 'logging.ringCap',
    type: 'integer',
    min: 0,
    max: 1_000_000,
    zeroMeansOff: true,
    group: 'logging',
    label: '日志缓冲条数',
  },

  // ── 控制台/用户 ─────────────────────────────────────────────────────
  { path: 'web.cookieSecure', type: 'boolean', group: 'web', label: 'Cookie Secure' },
  { path: 'web.sessionTtlHours', type: 'integer', min: 1, max: 24 * 365, group: 'web', label: '登录有效期(小时)' },
  { path: 'users.defaultAdminUsername', type: 'string', group: 'users', label: '默认管理员用户名' },
  { path: 'users.defaultAdminPassword', type: 'string', group: 'users', label: '默认管理员密码' },
  { path: 'server.apiKeys', type: 'stringList', group: 'server', label: '超级 API Key' },
])

/**
 * 明确"不"让前端改的路径 ---- 门禁据此判"未登记项"是否属于豁免.
 *
 * 每条都要有理由(理由写在 TUNABLES 的文档注释里), 否则门禁会把它报成"漏登记".
 */
export const NOT_TUNABLE: readonly string[] = Object.freeze([
  'server.host', // 用户裁决: 只留在 config.yaml
  'server.port', // 同上
  'server.dataDir', // 进程级定位, 改它是循环依赖(见 TUNABLES 文档注释)
  'upstream.apiBase', // 硬编码真源(踩过部署事故)
  'upstream.channel', // 'legacy' 已废弃, 只剩 official, 无可选性
  'upstream.credentialsDir', // 由 dataDir 推导; 改错会让已导入账号"消失"
  // 代理池已经在前端可调, 只是入口不在[设置]页而在[代理设置]页
  // (它有自己的 store: /data/proxies.json, 有加/删/测试/保存的完整 UI).
  // 放进本表会让设置页出现第二个代理输入框 ---- 同一个值两个入口,
  // 保存顺序不同就会互相覆盖. 因此登记为"不由可调项表管", 理由写在注释里.
  'upstream.proxy',
  'upstream.proxies',
  /**
   * 下面三项已经在前端可调, 而且比"重启生效"更好: 它们走
   * /data/settings.json 的实时 getter 通道, 保存立即生效
   * (见 bin/serve.ts 的 getAccountConcurrency / getSessionSettings).
   *
   * 不登记进 TUNABLES 的理由与代理池同源: 那会让同一个值出现两个入口
   * (实时键 idleReleaseSec 与可调项路径 session.idleReleaseSec),
   * 而两者谁能赢取决于读取顺序 ---- 这类"同值两入口"是配置系统最典型的 bug.
   *
   * 注意 config.yaml 里这几项仍然保留默认值语义: 用户没在控制台保存过时,
   * 消费点回落到 config 里的值(见 src/session/core/lease.ts 的 ?? config...).
   */
  'session.idleReleaseSec',
  'limits.accountMaxConcurrency',
  'limits.maxNewSessionsPerRequest',
])
