/**
 * 配置加载:读 YAML,归一,合并默认值,套环境变量,解析路径.
 *
 * 所有"看起来像配置就能覆盖"的口子在这里收敛成一条规则:能覆盖的只有
 * 明确列出的环境变量,其余一律以 DEFAULTS 为准(api_base 尤其如此).
 *
 * 从 src/config.ts 拆出(原 446 行单文件).
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { sanitizeProxyList } from '../util/json-store.ts'
import { DEFAULTS, UPSTREAM_API_BASE } from './defaults.ts'
import { deepMerge, normalizeKeys, stripTrailingSlash } from './merge.ts'
import { projectRootFromModule, resolveDefaultCredentialsDir } from './paths.ts'

/**
 * 套用运维类环境变量覆盖(不含上游认证).
 *
 * @param {Record<string, any>} merged 已合并的配置(就地修改)
 * @returns {void}
 */
function applyEnvOverrides(merged: Record<string, any>): void {
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
}

/**
 * 代理相关字段的清洗(脏值会让构造出网 agent 时抛 ERR_INVALID_URL).
 *
 * @param {Record<string, any>} merged 已合并的配置(就地修改)
 * @returns {void}
 */
function sanitizeProxies(merged: Record<string, any>): void {
  // 代理列表:只留"能当 URL 用"的非空字符串. 兼容 { url: "http://..." } 写法.
  // 脏值(null/数字/对象/畸形 URL)会让构造出网 agent 抛 ERR_INVALID_URL.
  if (!Array.isArray(merged.upstream.proxies)) merged.upstream.proxies = []
  merged.upstream.proxies = sanitizeProxyList(
    merged.upstream.proxies.map((u: any) =>
      u && typeof u === 'object' && typeof u.url === 'string' ? u.url : u,
    ),
  ).urls
  if (merged.upstream.proxy && typeof merged.upstream.proxy === 'object') {
    merged.upstream.proxy =
      typeof merged.upstream.proxy.url === 'string' ? merged.upstream.proxy.url : null
  }
  if (merged.upstream.proxy && typeof merged.upstream.proxy === 'string') {
    merged.upstream.proxy = merged.upstream.proxy.trim() || null
  }
}

/**
 * 解析数据目录与凭据目录为绝对路径.
 *
 * @param {Record<string, any>} merged 已合并的配置(就地修改)
 * @returns {void}
 */
function resolveDirs(merged: Record<string, any>): void {
  // Resolve data dir against project root when relative
  if (!path.isAbsolute(merged.server.dataDir)) {
    merged.server.dataDir = path.resolve(projectRootFromModule(), merged.server.dataDir)
  }
  // Resolve credentials dir: explicit config wins, else default under dataDir
  if (typeof merged.upstream.credentialsDir === 'string' && merged.upstream.credentialsDir) {
    if (!path.isAbsolute(merged.upstream.credentialsDir)) {
      merged.upstream.credentialsDir = path.resolve(
        projectRootFromModule(),
        merged.upstream.credentialsDir,
      )
    }
  } else {
    merged.upstream.credentialsDir = resolveDefaultCredentialsDir(merged.server.dataDir)
  }
}

/**
 * 载入配置(YAML + 默认值 + 环境变量 + 路径解析).
 *
 * @param {string} [configPath] 显式配置文件路径;缺省走 FREEBUFF_PROXY_CONFIG 或 ./config.yaml
 * @returns {import('./index.ts').ProxyConfig & { _configPath: string, _configExists: boolean, _dataDir: string }}
 *   合并后的配置(含 _* 诊断字段)
 */
export function loadConfig(configPath?: string): Record<string, any> {
  const resolvedPath =
    configPath ||
    process.env.FREEBUFF_PROXY_CONFIG ||
    path.join(process.cwd(), 'config.yaml')

  /** @type {Record<string, any>} */
  let fileConfig = {}
  if (fs.existsSync(resolvedPath)) {
    fileConfig = normalizeKeys(parseYaml(fs.readFileSync(resolvedPath, 'utf8')) || {})
  }

  const merged: Record<string, any> = deepMerge(DEFAULTS, fileConfig)

  applyEnvOverrides(merged)

  /**
   * api_base 一律以硬编码真源为准, 配置文件里的值被无条件覆盖:
   * 值取自 FREEBUFF_UPSTREAM_API_BASE 环境变量(本地镜像对照用), 未设时取常量.
   * 见 .agents/notes/implemented/bug-fix/2026-10-04-upstream-apibase-hardcoded.md
   */
  merged.upstream.apiBase = stripTrailingSlash(
    process.env.FREEBUFF_UPSTREAM_API_BASE || UPSTREAM_API_BASE,
  )
  merged.upstream.loginBase = stripTrailingSlash(merged.upstream.loginBase)

  if (!Array.isArray(merged.server.apiKeys)) merged.server.apiKeys = []
  merged.server.apiKeys = merged.server.apiKeys.map(String).filter(Boolean)

  sanitizeProxies(merged)
  resolveDirs(merged)

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
