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
 * @property {{releaseOnShutdown: boolean, reAdmitOnExpire: boolean, pollIntervalSec: number, admitTimeoutMs: number}} session
 * @property {{maxConcurrentRequests: number, upstreamTimeoutSec: number, maxAutoRetryOnSessionError: number}} limits
 * @property {{stickyTtlSec: number}} lb  会话粘性记忆时长（秒）：同一会话 key 在该时长内固定同一账号，过期后重新轮询分配
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
    pollIntervalSec: 30,
    admitTimeoutMs: 30_000,
  },
  limits: {
    maxConcurrentRequests: 32,
    upstreamTimeoutSec: 600,
    maxAutoRetryOnSessionError: 1,
  },
  lb: {
    /** 会话粘性记忆 TTL：防止同一个会话 key（如恒定 conversation_id）把账号钉死。 */
    stickyTtlSec: 60,
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
  poll_interval_sec: 'pollIntervalSec',
  admit_timeout_ms: 'admitTimeoutMs',
  max_concurrent_requests: 'maxConcurrentRequests',
  upstream_timeout_sec: 'upstreamTimeoutSec',
  max_auto_retry_on_session_error: 'maxAutoRetryOnSessionError',
  sticky_ttl_sec: 'stickyTtlSec',
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
