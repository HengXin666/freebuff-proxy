/**
 * 全局常量真源: 跨文件复用的时间/大小/上限/协议前缀.
 *
 * 同一数值出现在多处时只在这里定义一次 ---- 分散定义改一处忘一处的后果是
 * 两处对不上, 而两边都看起来是对的.
 */

/** 时间(毫秒). */
export const MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const

/** 时间(秒). */
export const SEC = {
  minute: 60,
  hour: 3_600,
  day: 86_400,
} as const

/** 日志相关. */
export const LOG = {
  ringCapDefault: 5_000,
  ringCapMax: 1_000_000,
  bufferQueryLimitDefault: 200,
} as const

/** 上游协议头/前缀. */
export const HEADERS = {
  instanceId: 'x-freebuff-instance-id',
  takeoverInstanceId: 'x-freebuff-takeover-instance-id',
  heartbeat: 'x-freebuff-heartbeat',
  catalogFetch: 'x-freebuff-catalog-fetch',
  catalogProtocol: 'x-freebuff-catalog-protocol',
  model: 'x-freebuff-model',
  /** 目录模型句柄前缀(服务端签名, 客户端无法自造). */
} as const

/** 目录模型句柄前缀. */
export const MODEL_HANDLE_PREFIX = 'fbm1.'

/** 持久化数据文件名(全部落在 dataDir 下). */
export const DATA_FILES = {
  users: 'users.json',
  sessions: 'sessions.json',
  accountState: 'account-state.json',
  settings: 'settings.json',
  proxies: 'proxies.json',
  customModels: 'custom-models.json',
  webSessions: 'web-sessions.json',
  loginFlows: 'login-flows.json',
  catalogCache: 'catalog-cache.json',
} as const
