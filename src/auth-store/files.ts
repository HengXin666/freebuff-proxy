/**
 * 凭据文件的路径与文件名规则.
 *
 * 账号唯一标识(key)优先用 Freebuff 用户 id:GitHub / Google 登录即使邮箱相同,
 * Freebuff 也会分配不同的 id,用邮箱做 key 会让同邮箱账号互相覆盖(bug),
 * 用 id 则可并存.老数据 / 手工导入无 id 的账号回落用邮箱做 key.
 *
 * 目录布局:
 *   credentials/<key>.json      key = Freebuff 用户 id(新布局)
 *   credentials/<email>.json    历史布局,读取时自动迁移到 <id>.json
 *
 * 从 src/auth-store.ts 拆出(原 392 行单文件).
 */
import fs from 'node:fs'
import path from 'node:path'
import { credentialsDir, projectRootFromModule } from '../config.ts'
import { logger } from '../util/log.ts'

/**
 * 解析凭据目录(配置显式值优先,否则仓库默认).
 *
 * @param {any} config 已加载配置
 * @returns {string} 凭据目录绝对路径
 */
export function resolveCredentialsDir(config: any): string {
  const configured = config?.upstream?.credentialsDir
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(projectRootFromModule(), configured)
  }
  return credentialsDir()
}

/**
 * 账号唯一标识:优先 Freebuff 用户 id(GitHub/Google 同邮箱不互斥),
 * 无 id(历史数据/手工导入)回落小写邮箱.
 *
 * @param {any} user 账号对象
 * @returns {string} 账号 key
 */
export function accountKeyOf(user: any): string {
  const id = typeof user?.id === 'string' ? user.id.trim() : ''
  if (id) return id
  return String(user?.email || '').trim().toLowerCase()
}

/**
 * 把任意 key(UUID/邮箱)转成安全的文件 stem.
 *
 * @param {any} key 账号 key
 * @returns {string} 可安全用作文件名的 stem
 * @throws {Error} key 为空或为 . / .. 时
 */
export function safeAccountStem(key: any): string {
  const stem = String(key || '')
    .trim()
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
  if (!stem || stem === '.' || stem === '..') {
    throw new Error(`Invalid account key: ${key}`)
  }
  return stem
}

/**
 * 账号 key -> 凭据文件名.
 *
 * @param {any} key 账号 key
 * @returns {string} 文件名
 */
export function accountKeyToFilename(key: any): string {
  return `${safeAccountStem(key)}.json`
}

/**
 * 按账号 key 解析凭据文件路径(key = id 或邮箱).
 *
 * @param {string} dir 凭据目录
 * @param {any} key 账号 key
 * @returns {string} 绝对路径
 */
export function accountCredentialsPath(dir: string, key: any): string {
  return path.join(dir, accountKeyToFilename(key))
}

/**
 * 邮箱 -> 历史布局文件名(规范化 + 防目录穿越).
 *
 * @param {any} email 账号邮箱
 * @returns {string} 文件名
 * @throws {Error} 邮箱不合法时
 */
export function emailToFilename(email: any): string {
  const normalized = String(email || '').trim().toLowerCase()
  if (!normalized || !normalized.includes('@')) {
    throw new Error(`Invalid account email: ${email}`)
  }
  if (
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes('..') ||
    normalized.includes('\0')
  ) {
    throw new Error(`Invalid account email: ${email}`)
  }
  return `${normalized}.json`
}

/**
 * 确保凭据目录存在.
 *
 * @param {string} dir 凭据目录
 * @returns {string} 同一个目录(便于链式)
 */
export function ensureCredentialsDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 读一个 JSON 文件(失败只告警,不抛).
 *
 * @param {string} filePath 文件路径
 * @returns {any} 解析结果;不存在或解析失败返回 null
 */
export function readJsonFile(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    logger.warn('failed to read json file', {
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * 写一个 JSON 文件(权限 0600,凭据文件不该被同机其他用户读到).
 *
 * @param {string} filePath 文件路径
 * @param {any} data 要写入的数据
 * @returns {void}
 */
export function writeJsonFile(filePath: string, data: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // best-effort
  }
}
