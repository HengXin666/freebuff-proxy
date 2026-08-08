import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { credentialsDir, projectRootFromModule } from './config.js'
import { logger } from './util/log.js'

/**
 * Multi-account Freebuff login store.
 *
 * 账号唯一标识（key）优先用 Freebuff 用户 `id`：
 * GitHub / Google 登录即使邮箱相同，Freebuff 也会分配不同的 id，
 * 用邮箱做 key 会让同邮箱账号互相覆盖（bug），用 id 则可并存。
 * 老数据 / 手工导入无 id 的账号回落用邮箱做 key。
 *
 *   credentials/
 *     <key>.json            # key = Freebuff 用户 id（新布局）
 *     <email>.json          # 历史布局，读取时自动迁移到 <id>.json
 *
 * No "active" pointer — runtime picks accounts by availability.
 */

/**
 * @typedef {object} FreebuffUser
 * @property {string} [id]
 * @property {string} email
 * @property {string} [name]
 * @property {string} authToken
 * @property {string} [fingerprintId]
 * @property {string} [fingerprintHash]
 */

export function resolveCredentialsDir(config) {
  const configured = config?.upstream?.credentialsDir
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(projectRootFromModule(), configured)
  }
  return credentialsDir()
}

/**
 * 账号唯一标识：优先 Freebuff 用户 id（GitHub/Google 同邮箱不互斥），
 * 无 id（历史数据/手工导入）回落小写邮箱。
 * @param {FreebuffUser | any} user
 */
export function accountKeyOf(user) {
  const id = typeof user?.id === 'string' ? user.id.trim() : ''
  if (id) return id
  return String(user?.email || '')
    .trim()
    .toLowerCase()
}

/** 把任意 key（UUID/邮箱）转成安全的文件 stem。 */
export function safeAccountStem(key) {
  const stem = String(key || '')
    .trim()
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
  if (!stem || stem === '.' || stem === '..') {
    throw new Error(`Invalid account key: ${key}`)
  }
  return stem
}

export function accountKeyToFilename(key) {
  return `${safeAccountStem(key)}.json`
}

/** 按账号 key 解析凭据文件路径（key = id 或邮箱）。 */
export function accountCredentialsPath(dir, key) {
  return path.join(dir, accountKeyToFilename(key))
}

export function emailToFilename(email) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase()
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

export function ensureCredentialsDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJsonFile(filePath) {
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

export function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // best-effort
  }
}

/**
 * Runtime format is bare user object.
 * Migrate-only: also accept legacy `{ default: user }`.
 * @returns {FreebuffUser | null}
 */
export function coerceUser(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.authToken !== 'string' || !raw.authToken) return null
  if (typeof raw.email !== 'string' || !raw.email.includes('@')) return null
  return {
    id: raw.id,
    email: String(raw.email).trim().toLowerCase(),
    name: raw.name,
    authToken: raw.authToken,
    fingerprintId: raw.fingerprintId,
    fingerprintHash: raw.fingerprintHash,
    /** 可选：该账号专属出网代理，如 http://user:pass@127.0.0.1:7890 */
    proxy: typeof raw.proxy === 'string' && raw.proxy.trim()
      ? raw.proxy.trim()
      : null,
  }
}

/**
 * 按 key 读取账号。key 命中不了时兜底扫描目录：
 *  - key 是邮箱 → 按邮箱唯一匹配（兼容迁移前的旧 <email>.json）；
 *  - key 是 id → 按文件内容 id 匹配（极端情况下旧文件还没迁移）。
 * 找到后顺手把旧文件名迁移到 <key>.json，避免每次扫描。
 * @param {string} dir
 * @param {string} key
 * @returns {FreebuffUser | null}
 */
export function readAccountUser(dir, key) {
  const direct = accountCredentialsPath(dir, key)
  const directUser = coerceUser(readJsonFile(direct))
  if (directUser) return directUser
  if (!fs.existsSync(dir)) return null
  const norm = String(key || '').trim().toLowerCase()
  let found = null
  let ambiguous = false
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const full = path.join(dir, file)
    const u = coerceUser(readJsonFile(full))
    if (!u) continue
    const k = accountKeyOf(u)
    if (k === key || k.toLowerCase() === norm || u.email === norm) {
      if (found) {
        ambiguous = true
        break
      }
      found = { u, full }
    }
  }
  if (!found || ambiguous) return null
  const target = accountCredentialsPath(dir, accountKeyOf(found.u))
  if (target !== found.full && !fs.existsSync(target)) {
    try {
      fs.renameSync(found.full, target)
      found.full = target
    } catch {
      // 迁移失败不影响读取
    }
  }
  return found.u
}

/**
 * 保存账号。key = id（优先）/ 邮箱。
 * 核心修复：同邮箱但 id 不同的两个账号（如 GitHub 与 Google 登录同一邮箱）
 * 各自存到自己的 <id>.json，互不覆盖；只有 id 相同的重登才更新原文件。
 * 历史 <email>.json 若属于同一账号（id 相同）会迁移删除，属于别的账号则保留。
 * @returns {{ user: FreebuffUser, path: string, key: string }}
 */
export function saveAccountUser(dir, user) {
  const u = coerceUser(user)
  if (!u) throw new Error('Cannot save account: missing email/authToken')
  ensureCredentialsDir(dir)
  const key = accountKeyOf(u)
  const filePath = accountCredentialsPath(dir, key)
  if (u.id) {
    // 同邮箱的旧布局文件：仅当它属于同一个账号（id 相同）才清理，
    // 否则（不同账号同邮箱）保留 —— 不覆盖别的账号。
    const legacy = path.join(dir, emailToFilename(u.email))
    if (legacy !== filePath && fs.existsSync(legacy)) {
      const legacyUser = coerceUser(readJsonFile(legacy))
      if (legacyUser && legacyUser.id === u.id) {
        try {
          fs.unlinkSync(legacy)
        } catch {
          // ignore
        }
      }
    }
  }
  writeJsonFile(filePath, u)
  // Remove obsolete active pointer if present
  const activePath = path.join(dir, 'active')
  if (fs.existsSync(activePath)) {
    try {
      fs.unlinkSync(activePath)
    } catch {
      // ignore
    }
  }
  return { user: u, path: filePath, key }
}

/**
 * 列出所有账号，并自动把旧 <email>.json（内容含 id）迁移为 <id>.json。
 * 同一 key 出现多个文件时只保留 <key>.json（旧命名重复文件删除）。
 * @returns {Array<{ key: string, id: string | null, email: string, name?: string, path: string, proxy: string | null }>}
 */
export function listAccounts(dir) {
  ensureCredentialsDir(dir)
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  /** @type {Map<string, { email: string, name?: string, id: string | null, path: string, proxy: string | null }>} */
  const byKey = new Map()
  for (const file of files) {
    const full = path.join(dir, file)
    const user = coerceUser(readJsonFile(full))
    if (!user) continue
    const key = accountKeyOf(user)
    const target = accountCredentialsPath(dir, key)
    if (path.basename(target) !== file) {
      if (fs.existsSync(target)) {
        // <key>.json 已存在 → 旧 <email>.json 是同账号的历史遗留，删除
        try {
          fs.unlinkSync(full)
        } catch {
          // ignore
        }
        continue
      }
      try {
        fs.renameSync(full, target)
      } catch {
        // 并发/权限失败则继续用旧路径
      }
    }
    byKey.set(key, {
      key,
      id: user.id || null,
      email: user.email,
      name: user.name,
      path: fs.existsSync(target) ? target : full,
      proxy: user.proxy || null,
    })
  }
  const accounts = [...byKey.values()]
  accounts.sort((a, b) => a.email.localeCompare(b.email))
  return accounts
}

/**
 * 删除账号：优先 <key>.json，其次旧 <email>.json，最后内容反查。
 * @returns {boolean} 是否真的删掉了文件
 */
export function deleteAccountUser(dir, key) {
  const direct = accountCredentialsPath(dir, key)
  if (fs.existsSync(direct)) {
    try {
      fs.unlinkSync(direct)
      return true
    } catch {
      return false
    }
  }
  if (String(key).includes('@')) {
    const legacy = path.join(dir, emailToFilename(key))
    if (fs.existsSync(legacy)) {
      try {
        fs.unlinkSync(legacy)
        return true
      } catch {
        return false
      }
    }
  }
  if (!fs.existsSync(dir)) return false
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const full = path.join(dir, file)
    const u = coerceUser(readJsonFile(full))
    if (u && accountKeyOf(u) === key) {
      try {
        fs.unlinkSync(full)
        return true
      } catch {
        return false
      }
    }
  }
  return false
}

/** Login-issued tokens need both headers (Bearer alone → 401). */
export function freebuffAuthHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'x-codebuff-api-key': token,
  }
}

export function generateFingerprintId() {
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || '',
    String(os.cpus().length),
    os.userInfo().username,
  ]
  const macs = []
  const nets = os.networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00') {
        macs.push(n.mac)
      }
    }
  }
  parts.push(...macs.sort())
  const hash = createHash('sha256').update(parts.join('|')).digest('base64url')
  return `enhanced-${hash}`
}
