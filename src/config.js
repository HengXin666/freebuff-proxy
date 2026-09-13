import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { sanitizeProxyList } from './util/json-store.js'

/**
 * @typedef {object} ProxyConfig
 * @property {{host: string, port: number, apiKeys: string[], dataDir: string}} server
 * @property {{apiBase: string, loginBase: string, credentialsDir: string | null, proxy: string | null, proxies: string[]}} upstream
 * @property {{cookieSecure: boolean, sessionTtlHours: number}} web
 * @property {{defaultAdminUsername: string, defaultAdminPassword: string | null}} users
 * @property {{releaseOnShutdown: boolean, reAdmitOnExpire: boolean, reAdmitLeadSec: number, freeModelReAdmitLeadSec: number, pollIntervalSec: number, admitTimeoutMs: number, idleReleaseSec: number}} session
 * @property {{maxConcurrentRequests: number, slotWaitMs: number, bodyReadTimeoutMs: number, accountMaxConcurrency: number, upstreamTimeoutSec: number, streamIdleTimeoutSec: number, accountChatWaitMs: number, maxAutoRetryOnSessionError: number, stallCooldownSec: number, maxNewSessionsPerRequest: number, requestJitterMs: number}} limits
 * @property {{level: 'debug' | 'info' | 'warn' | 'error'}} logging
 */

const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    /** Optional Agent gate. Empty = open (OK on loopback only). */
    apiKeys: [],
    /** All persistent state (credentials, users, sessions, login flows). */
    dataDir: './data',
  },
  upstream: {
    apiBase: 'https://codebuff.com',
    loginBase: 'https://freebuff.com',
    /** null → <dataDir>/credentials (legacy ./credentials kept as fallback) */
    credentialsDir: null,
    /** Explicit proxy URL, e.g. http://user:pass@host:7890. Env HTTP(S)_PROXY used otherwise. */
    proxy: null,
    /** 全局代理池（多代理）：账号按稳定哈希分配到池内某个代理；连接失败自动回落下一个。 */
    proxies: [],
  },
  web: {
    cookieSecure: false,
    sessionTtlHours: 24 * 7,
  },
  users: {
    /** First-run admin (created when no admin exists). */
    defaultAdminUsername: 'admin',
    /** null → random password printed once in logs (also ADMIN_PASSWORD env). */
    defaultAdminPassword: null,
  },
  session: {
    releaseOnShutdown: true,
    reAdmitOnExpire: true,
    // 会话剩余时间低于该值(秒)时不再承接新请求，提前 re-admit 换新会话，
    // 避免请求发到马上过期的会话上、中途卡住（默认 60s，付费模型适用——
    // 付费会话每次 admit 都计费，尽量用到接近过期）。
    reAdmitLeadSec: 60,
    // 免费模型（pool 非 premium）的提前切换阈值（秒）：会话剩余不足该值时
    // 不再调度到该会话上，提前 re-admit 换全新会话（默认 60s = 1 分钟）。
    // Freebucks 计费（2026-09）：按模型单价（N/h）× 实际占用时长结算，admit
    // 时按整小时预占、提前 DELETE 把未用时长退回（freebucksRefund）。所以提前
    // re-admit 只是把当前这条的剩余时长换成新计费行——尽量少换、够用就复用。
    freeModelReAdmitLeadSec: 60,
    pollIntervalSec: 30,
    admitTimeoutMs: 30_000,
    // 空闲自动释放（秒）：会话在途请求归零后，空闲超过该时长就早退 DELETE。
    // ⚠️ 2026-09-13 实测结论（docs/account-scheduling-and-refund.md §3）：
    // 早退**不退还 Freebucks**。admit 一次 = 实付整小时单价，之后用 3 秒还是
    // 59 分钟扣的一样多；DELETE 只退还 session_units（每日模型额度），不退款。
    // 所以「空闲早退省钱」是错的——频繁释放只会**反复买新会话**。
    // 默认 600s（2026-09-13 由 60s 上调）：把交互式停顿留在同一会话里，
    // 减少 admit 次数（admit 次数 = 花钱次数）。
    // 0 = 关闭释放（最省 admit，会话留到自然过期；代价是换模型要等）。
    // 控制台「额度保护」可调（5s..24h）。
    idleReleaseSec: 600,
  },
  limits: {
    maxConcurrentRequests: 32,
    // 全局请求闸门的排队上限（毫秒）：排满时最多等这么久，超时返回 429
    // server_busy。旧实现无界排队 → 几个卡死的请求就能让整个服务永久不接单。
    slotWaitMs: 15_000,
    // 读请求体的上限（毫秒）：客户端声明 Content-Length 却不再发完（SDK 中断、
    // 半开连接）时，readRequestBody 的 for-await 永不返回，请求会一直占着
    // 全局槽位。超时即放弃该请求（408），从根上消除槽位泄漏。
    bodyReadTimeoutMs: 120_000,
    // 「首字节之前」的总调度预算（毫秒）。本代理在写出响应头之前有多段串行
    // 静默等待（全局槽位 → 账号 chat 锁 → 上游首字节），最坏情况会累加到
    // 几分钟。上游链路前面挂着 Cloudflare（源站 100s 未回响应头即 524），
    // 等待超过这个天花板时客户端只会看到一个「连上了但一直转圈」的连接。
    // 这里给整个调度阶段一个总预算：超了就以 429 scheduling_timeout 快速返回
    // 让客户端重试，绝不静默闷等（默认 45s，明显低于 100s 的 524 悬崖）。
    schedulingBudgetMs: 45_000,
    // 每个账号同一时间最多可转发的 SSE 响应流数（账号并发）。默认 2：
    // 并发请求先挤在同一账号上（粘性优先，换号 = 多买一条 Freebucks 计费会话），
    // 超过该值才溢出到下一个账号。可在控制台「负载均衡」实时调整，立即生效。
    accountMaxConcurrency: 2,
    upstreamTimeoutSec: 600,
    // 上游流式响应 body 的 idle 超时（秒）：收到响应头后若长时间没有新数据块，
    // 视为上游卡死（幽灵连接），主动掐断/换号，避免连接永远挂着。
    // 默认 60s——网络不稳定的上游 1 分钟不吐数据就该切换（用户明确要求）；
    // 慢思考模型（DeepSeek 等）思考期可能 >30s 才出首包，别设太小。
    streamIdleTimeoutSec: 60,
    // 账号级串行化：同一账号同一时间只处理一个 chat。热 session 排队等待的
    // 上限（毫秒，约等于一个完整 idle 超时周期）；超时后换下一个可用账号。
    accountChatWaitMs: 120_000,
    maxAutoRetryOnSessionError: 1,
    // 上游流被掐断（幽灵连接 idle 超时）后，账号的短暂冷却时长（秒）：
    // 该账号刚被掐断过一次，说明上游/网络对该会话不稳定，短期内让新请求
    // 优先去别的账号，避免反复撞上同一条卡死的链路。0 = 不冷却（旧行为，
    // 掐断后下一请求仍可复用该会话）。
    stallCooldownSec: 30,
    // 上游 chat 调用前的随机抖动上限（毫秒）：每次请求前等 [0, N) 的随机时长，
    // 打散机器式等间隔节奏（上游风控按请求节奏指纹自动化；参考项目 SAFE_MODE
    // 默认 200ms）。0 = 关闭（最低延迟）。
    requestJitterMs: 200,
    // 一个下游请求最多新建几个上游会话（Freebucks 计费单位）。
    // 上游按整小时买断计费：admit 一次就扣整小时单价，早退 DELETE **不退**
    // Freebucks（2026-09-13 实测，见 docs/account-scheduling-and-refund.md §3）。旧行为在
    // 报错时把「账号数 +1」个账号挨个 admit 一遍——一次故障就买断好几条整小时
    // （issue #7）。默认 2：首个账号 + 一次换号兜底；复用已有热
    // session 不消耗预算。0 = 不限制（仅保留给调试）。
    maxNewSessionsPerRequest: 2,
  },
  logging: {
    level: 'info',
  },
}

/** YAML snake_case → camelCase. Unknown keys kept as-is. */
const KEY_MAP = {
  api_keys: 'apiKeys',
  api_base: 'apiBase',
  login_base: 'loginBase',
  credentials_dir: 'credentialsDir',
  data_dir: 'dataDir',
  cookie_secure: 'cookieSecure',
  session_ttl_hours: 'sessionTtlHours',
  default_admin_username: 'defaultAdminUsername',
  default_admin_password: 'defaultAdminPassword',
  release_on_shutdown: 'releaseOnShutdown',
  re_admit_on_expire: 'reAdmitOnExpire',
  re_admit_lead_sec: 'reAdmitLeadSec',
  free_model_re_admit_lead_sec: 'freeModelReAdmitLeadSec',
  poll_interval_sec: 'pollIntervalSec',
  admit_timeout_ms: 'admitTimeoutMs',
  max_concurrent_requests: 'maxConcurrentRequests',
  slot_wait_ms: 'slotWaitMs',
  body_read_timeout_ms: 'bodyReadTimeoutMs',
  account_max_concurrency: 'accountMaxConcurrency',
  upstream_timeout_sec: 'upstreamTimeoutSec',
  stream_idle_timeout_sec: 'streamIdleTimeoutSec',
  account_chat_wait_ms: 'accountChatWaitMs',
  scheduling_budget_ms: 'schedulingBudgetMs',
  max_auto_retry_on_session_error: 'maxAutoRetryOnSessionError',
  stall_cooldown_sec: 'stallCooldownSec',
  max_new_sessions_per_request: 'maxNewSessionsPerRequest',
  request_jitter_ms: 'requestJitterMs',
  idle_release_sec: 'idleReleaseSec',
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeKeys(input) {
  if (Array.isArray(input)) return input.map(normalizeKeys)
  if (!isPlainObject(input)) return input
  /** @type {Record<string, any>} */
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (Object.prototype.hasOwnProperty.call(KEY_MAP, key)) {
      out[KEY_MAP[key]] = normalizeKeys(value)
      continue
    }
    // Drop known-removed dual-track keys silently
    if (
      [
        'credentials_path',
        'auth_token',
        'read_local_credentials',
        'codebuff_api_key_env',
        'auto_admit',
      ].includes(key)
    ) {
      continue
    }
    out[key] = normalizeKeys(value)
  }
  return out
}

/** 深拷贝纯对象/数组（DEFAULTS 只含 JSON 可表达的值）。 */
function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain)
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = clonePlain(v)
    return out
  }
  return value
}

/**
 * 深合并：override 覆盖 base。
 *
 * **必须深拷贝 base**（历史 bug）：旧实现用 `{ ...base }` 浅拷贝，当 override 为
 * 空（**没有 config.yaml** 时 fileConfig = {}）嵌套的 session/limits/web/upstream
 * 就与全局 DEFAULTS **共享同一个对象引用**。任何一处 `config.session.xxx = y`
 * 都会污染 DEFAULTS，污染进程内后续所有 loadConfig() 结果（测试套件之间互相串味，
 * 表现为莫名其妙的 "fetch failed" / no_available_account）。有 config.yaml 时因为
 * 递归到嵌套键恰好新建了对象，所以才"看起来正常"——这个 bug 因此潜伏了很久。
 */
function deepMerge(base, override) {
  if (!isPlainObject(override)) return clonePlain(base)
  const out = clonePlain(base)
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else if (value !== undefined) {
      out[key] = clonePlain(value)
    }
  }
  return out
}

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '')
}

export function projectRootFromModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

export function credentialsDir() {
  return path.join(projectRootFromModule(), 'credentials')
}

/**
 * Default credentials dir: <dataDir>/credentials, unless a legacy
 * <projectRoot>/credentials with account files still exists and the new one
 * is empty (keeps pre-/data installs working).
 */
function resolveDefaultCredentialsDir(dataDir) {
  const primary = path.join(dataDir, 'credentials')
  const legacy = credentialsDir()
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(primary)) {
      const files = fs.readdirSync(legacy).filter((f) => f.endsWith('.json'))
      if (files.length > 0) return legacy
    }
  } catch {
    // fall through
  }
  return primary
}

/**
 * @param {string | undefined} configPath
 * @returns {ProxyConfig & { _configPath: string, _configExists: boolean, _dataDir: string }}
 */
export function loadConfig(configPath) {
  const resolvedPath =
    configPath ||
    process.env.FREEBUFF_PROXY_CONFIG ||
    path.join(process.cwd(), 'config.yaml')

  /** @type {Record<string, any>} */
  let fileConfig = {}
  if (fs.existsSync(resolvedPath)) {
    fileConfig = normalizeKeys(parseYaml(fs.readFileSync(resolvedPath, 'utf8')) || {})
  }

  const merged = deepMerge(DEFAULTS, fileConfig)

  // Operational overrides (not Freebuff auth)
  if (process.env.FREEBUFF_PROXY_DATA_DIR) {
    merged.server.dataDir = process.env.FREEBUFF_PROXY_DATA_DIR
  }
  if (process.env.FREEBUFF_PROXY_HOST) merged.server.host = process.env.FREEBUFF_PROXY_HOST
  if (process.env.FREEBUFF_PROXY_PORT) {
    merged.server.port = Number(process.env.FREEBUFF_PROXY_PORT)
  }
  if (process.env.FREEBUFF_PROXY_LOG_LEVEL) {
    merged.logging.level = process.env.FREEBUFF_PROXY_LOG_LEVEL
  }
  if (process.env.ADMIN_USERNAME) merged.users.defaultAdminUsername = process.env.ADMIN_USERNAME
  if (process.env.ADMIN_PASSWORD) merged.users.defaultAdminPassword = process.env.ADMIN_PASSWORD

  merged.upstream.apiBase = stripTrailingSlash(merged.upstream.apiBase)
  merged.upstream.loginBase = stripTrailingSlash(merged.upstream.loginBase)

  if (!Array.isArray(merged.server.apiKeys)) merged.server.apiKeys = []
  merged.server.apiKeys = merged.server.apiKeys.map(String).filter(Boolean)

  // 代理列表：只留"能当 URL 用"的非空字符串。脏值（null/数字/对象/畸形 URL）
  // 原样留下会在构造出网 agent 时抛 ERR_INVALID_URL —— 那是启动路径上的崩溃。
  // 兼容历史写法 [{ url: "http://..." }]（早期文档里的对象形态）。
  if (!Array.isArray(merged.upstream.proxies)) merged.upstream.proxies = []
  merged.upstream.proxies = sanitizeProxyList(
    merged.upstream.proxies.map((u) =>
      u && typeof u === 'object' && typeof u.url === 'string' ? u.url : u,
    ),
  ).urls
  if (merged.upstream.proxy && typeof merged.upstream.proxy === 'object') {
    merged.upstream.proxy =
      typeof merged.upstream.proxy.url === 'string' ? merged.upstream.proxy.url : null
  }

  // Resolve data dir against project root when relative
  if (!path.isAbsolute(merged.server.dataDir)) {
    merged.server.dataDir = path.resolve(
      projectRootFromModule(),
      merged.server.dataDir,
    )
  }

  // Resolve credentials dir: explicit config wins, else default under dataDir
  if (
    typeof merged.upstream.credentialsDir === 'string' &&
    merged.upstream.credentialsDir
  ) {
    if (!path.isAbsolute(merged.upstream.credentialsDir)) {
      merged.upstream.credentialsDir = path.resolve(
        projectRootFromModule(),
        merged.upstream.credentialsDir,
      )
    }
  } else {
    merged.upstream.credentialsDir = resolveDefaultCredentialsDir(
      merged.server.dataDir,
    )
  }

  if (merged.upstream.proxy && typeof merged.upstream.proxy === 'string') {
    merged.upstream.proxy = merged.upstream.proxy.trim() || null
  }

  // Drop any leftover dual-track fields from old configs
  if (merged.upstream) {
    delete merged.upstream.credentialsPath
    delete merged.upstream.authToken
  }
  if (merged.session) {
    delete merged.session.autoAdmit
  }

  merged._configPath = resolvedPath
  merged._configExists = fs.existsSync(resolvedPath)
  return merged
}

export { DEFAULTS }
