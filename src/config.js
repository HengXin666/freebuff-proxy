import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

/**
 * @typedef {object} ProxyConfig
 * @property {{host: string, port: number, apiKeys: string[], dataDir: string}} server
 * @property {{apiBase: string, loginBase: string, credentialsDir: string | null, proxy: string | null, proxies: string[]}} upstream
 * @property {{cookieSecure: boolean, sessionTtlHours: number}} web
 * @property {{defaultAdminUsername: string, defaultAdminPassword: string | null}} users
 * @property {{releaseOnShutdown: boolean, reAdmitOnExpire: boolean, reAdmitLeadSec: number, freeModelReAdmitLeadSec: number, pollIntervalSec: number, admitTimeoutMs: number}} session
 * @property {{maxConcurrentRequests: number, accountMaxConcurrency: number, upstreamTimeoutSec: number, streamIdleTimeoutSec: number, accountChatWaitMs: number, maxAutoRetryOnSessionError: number, stallCooldownSec: number}} limits
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
    // 不再调度到该会话上，提前 re-admit 换全新会话（默认 300s = 5 分钟）。
    // 免费会话按次/按小时结算，过期中途被掐断会白占额度且响应截断。
    freeModelReAdmitLeadSec: 300,
    pollIntervalSec: 30,
    admitTimeoutMs: 30_000,
  },
  limits: {
    maxConcurrentRequests: 32,
    // 每个账号同一时间最多可转发的 SSE 响应流数（账号并发）。默认 1:1
    // （一个账号一个并发）；可在控制台「负载均衡」实时调整，立即生效。
    accountMaxConcurrency: 1,
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
  account_max_concurrency: 'accountMaxConcurrency',
  upstream_timeout_sec: 'upstreamTimeoutSec',
  stream_idle_timeout_sec: 'streamIdleTimeoutSec',
  account_chat_wait_ms: 'accountChatWaitMs',
  max_auto_retry_on_session_error: 'maxAutoRetryOnSessionError',
  stall_cooldown_sec: 'stallCooldownSec',
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

function deepMerge(base, override) {
  if (!isPlainObject(override)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = deepMerge(base[key], value)
    } else if (value !== undefined) {
      out[key] = value
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

  if (!Array.isArray(merged.upstream.proxies)) merged.upstream.proxies = []
  merged.upstream.proxies = merged.upstream.proxies
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean)

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
