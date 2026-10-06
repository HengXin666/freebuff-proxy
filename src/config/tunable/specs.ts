/**
 * 可调项真源: 配置里除 server.host / server.port 之外的每一项, 都在这张表里.
 *
 * 本表描述每项的路径, 类型, 取值范围与默认值; 三处消费方只从本表取:
 *
 *   - 后端 /api/settings 的读快照与写校验(src/web/routes/control/settings.ts);
 *   - 前端设置页控件的生成(dashboard/views/proxy/**);
 *   - 启动装配: 把 /data/settings.json 合并进 config(bin/serve/boot/stores.ts).
 *
 * 生效方式: 启动时把 settings.json 深合进 config, 保存后需重启生效;
 * 前端在保存时提示这一点.
 * 见 .agents/notes/implemented/architecture/2026-10-05-config-tunables-via-console.md
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
  /**
   * 凭据项: 明细永不回显 ---- GET 只回[有没有设置]这个布尔, 前端
   * 渲染成留空即不改的密码框. 见 ./store.ts 的 snapshotTunables 与
   * secretsOf.
   */
  secret?: boolean
}

/**
 * 可调项清单.
 *
 * 口径: 除 server.host / server.port 与下列例外之外, DEFAULTS 里的每一项
 * 都必须在这里登记:
 *
 *   - server.dataDir  --  数据目录是进程级定位(settings.json 自己就在里面),
 *     由 env / 挂载决定.
 *   - upstream.apiBase / upstream.channel -- apiBase 是硬编码常量(见
 *     src/config/defaults.ts 的 UPSTREAM_API_BASE 注释); channel 只有 official
 *     一个有效值, 不需要在设置页出现.
 *   - upstream.credentialsDir -- 由 dataDir 推导, 且与控制台[账号]页的
 *     导入/登录回调路径强耦合.
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
  { path: 'users.defaultAdminPassword', type: 'string', secret: true, group: 'users', label: '默认管理员密码' },
  { path: 'server.apiKeys', type: 'stringList', secret: true, group: 'server', label: '下游访问 Key' },
])

/**
 * 明确"不"让前端改的路径 ---- 门禁据此判"未登记项"是否属于豁免.
 *
 * 每条在 TUNABLES 的文档注释里给出归属说明.
 */
export const NOT_TUNABLE: readonly string[] = Object.freeze([
  'server.host', // 只留在 config.yaml
  'server.port', // 同上
  'server.dataDir', // 进程级定位, 由 env / 挂载决定(见 TUNABLES 文档注释)
  'upstream.apiBase', // 硬编码常量
  'upstream.channel', // 只有 official 一个有效值
  'upstream.credentialsDir', // 由 dataDir 推导
  // 代理池的入口在[代理设置]页(独立 store: /data/proxies.json, 含加/删/测试/保存).
  // 登记进本表会让同一个值出现两个入口, 因此排除在本表之外.
  'upstream.proxy',
  'upstream.proxies',
  /**
   * 下面三项已在前端可调, 且保存立即生效: 它们走 /data/settings.json 的实时
   * getter 通道(见 bin/serve.ts 的 getAccountConcurrency / getSessionSettings),
   * 不登记进本表以避免同一个值出现两个入口.
   *
   * config.yaml 里这几项仍保留默认值语义: 控制台未保存过时消费点回落 config 值
   * (见 src/session/core/lease.ts 的 ?? config...).
   */
  'session.idleReleaseSec',
  'limits.accountMaxConcurrency',
  'limits.maxNewSessionsPerRequest',
])
