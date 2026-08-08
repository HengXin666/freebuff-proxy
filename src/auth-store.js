import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { credentialsDir, projectRootFromModule } from './config.js'
import { logger } from './util/log.js'

/**
 * Multi-account Freebuff login store (single layout).
 *
 *   credentials/
 *     user@example.com.json
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

export function accountCredentialsPath(dir, email) {
  return path.join(dir, emailToFilename(email))
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

export function readAccountUser(dir, email) {
  return coerceUser(readJsonFile(accountCredentialsPath(dir, email)))
}

export function saveAccountUser(dir, user) {
  const u = coerceUser(user)
  if (!u) throw new Error('Cannot save account: missing email/authToken')
  ensureCredentialsDir(dir)
  const filePath = accountCredentialsPath(dir, u.email)
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
  return { user: u, path: filePath }
}

export function listAccounts(dir) {
  ensureCredentialsDir(dir)
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  /** @type {Array<{ email: string, name?: string, id?: string, path: string }>} */
  const accounts = []
  for (const file of files) {
    const full = path.join(dir, file)
    const user = coerceUser(readJsonFile(full))
    if (!user) continue
    accounts.push({
      email: user.email,
      name: user.name,
      id: user.id,
      path: full,
      proxy: user.proxy || null,
    })
  }
  accounts.sort((a, b) => a.email.localeCompare(b.email))
  return accounts
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
