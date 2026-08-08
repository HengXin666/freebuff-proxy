import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

/**
 * @typedef {object} ProxyConfig
 * @property {{host: string, port: number, apiKeys: string[]}} server
 * @property {{apiBase: string, loginBase: string, credentialsDir: string | null}} upstream
 * @property {{releaseOnShutdown: boolean, reAdmitOnExpire: boolean, pollIntervalSec: number, admitTimeoutMs: number}} session
 * @property {{maxConcurrentRequests: number, upstreamTimeoutSec: number, maxAutoRetryOnSessionError: number}} limits
 * @property {{level: 'debug' | 'info' | 'warn' | 'error'}} logging
 */

const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    /** Optional Agent gate. Empty = open (OK on loopback only). */
    apiKeys: [],
  },
  upstream: {
    apiBase: 'https://codebuff.com',
    loginBase: 'https://freebuff.com',
    /** null → <projectRoot>/credentials */
    credentialsDir: null,
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
  release_on_shutdown: 'releaseOnShutdown',
  re_admit_on_expire: 'reAdmitOnExpire',
  poll_interval_sec: 'pollIntervalSec',
  admit_timeout_ms: 'admitTimeoutMs',
  max_concurrent_requests: 'maxConcurrentRequests',
  upstream_timeout_sec: 'upstreamTimeoutSec',
  max_auto_retry_on_session_error: 'maxAutoRetryOnSessionError',
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
 * @param {string | undefined} configPath
 * @returns {ProxyConfig & { _configPath: string, _configExists: boolean }}
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

  // Operational overrides only (not Freebuff auth, not upstream dual bases)
  if (process.env.FREEBUFF_PROXY_HOST) merged.server.host = process.env.FREEBUFF_PROXY_HOST
  if (process.env.FREEBUFF_PROXY_PORT) {
    merged.server.port = Number(process.env.FREEBUFF_PROXY_PORT)
  }
  if (process.env.FREEBUFF_PROXY_LOG_LEVEL) {
    merged.logging.level = process.env.FREEBUFF_PROXY_LOG_LEVEL
  }

  merged.upstream.apiBase = stripTrailingSlash(merged.upstream.apiBase)
  merged.upstream.loginBase = stripTrailingSlash(merged.upstream.loginBase)

  if (!Array.isArray(merged.server.apiKeys)) merged.server.apiKeys = []
  merged.server.apiKeys = merged.server.apiKeys.map(String).filter(Boolean)

  if (
    typeof merged.upstream.credentialsDir === 'string' &&
    merged.upstream.credentialsDir &&
    !path.isAbsolute(merged.upstream.credentialsDir)
  ) {
    merged.upstream.credentialsDir = path.resolve(
      projectRootFromModule(),
      merged.upstream.credentialsDir,
    )
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
