import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * JSON-file backed web users (control-plane accounts), separate from
 * Freebuff upstream accounts.
 *
 *   data/users.json
 *     { version: 1, users: [ { username, salt, passwordHash, role,
 *       apiKey, createdAt, lastSeenAt } ] }
 */

const SCRYPT_KEYLEN = 64

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex')
}

export function generateApiKey() {
  return `sk-fb-${crypto.randomBytes(24).toString('hex')}`
}

export function generatePassword(len = 24) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len)
}

export function publicUser(user) {
  if (!user) return null
  return {
    username: user.username,
    role: user.role,
    apiKey: user.apiKey,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt || null,
  }
}

export class UserStore {
  /**
   * @param {string} file e.g. /data/users.json
   */
  constructor(file) {
    this.file = file
    /** @type {any[]} */
    this.users = []
    this.load()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && Array.isArray(raw.users)) this.users = raw.users
    } catch (err) {
      console.error(`user store load failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, users: this.users }, null, 2), {
      mode: 0o600,
    })
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      // best-effort
    }
    fs.renameSync(tmp, this.file)
  }

  all() {
    return [...this.users].sort((a, b) => a.username.localeCompare(b.username))
  }

  getByUsername(username) {
    const key = String(username || '').trim().toLowerCase()
    return this.users.find((u) => u.username.toLowerCase() === key) || null
  }

  getByApiKey(apiKey) {
    if (!apiKey) return null
    return this.users.find((u) => u.apiKey === apiKey) || null
  }

  hasAdmin() {
    return this.users.some((u) => u.role === 'admin')
  }

  /**
   * Verify username/password. Returns public user (minus hash) or null.
   */
  verifyPassword(username, password) {
    const user = this.getByUsername(username)
    if (!user) return null
    const hash = hashPassword(password, user.salt)
    const a = Buffer.from(hash, 'hex')
    const b = Buffer.from(user.passwordHash, 'hex')
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    user.lastSeenAt = new Date().toISOString()
    this.save()
    return publicUser(user)
  }

  /**
   * @param {{username: string, password: string, role?: 'admin'|'user'}} input
   */
  create({ username, password, role = 'user' }) {
    const name = String(username || '').trim().toLowerCase()
    if (!/^[a-z0-9._-]{2,64}$/.test(name)) {
      throw new Error('用户名只能包含小写字母、数字、._-（2-64 位）')
    }
    if (this.getByUsername(name)) throw new Error(`用户已存在: ${name}`)
    if (!password || String(password).length < 6) {
      throw new Error('密码至少 6 位')
    }
    if (role !== 'admin' && role !== 'user') role = 'user'
    const salt = crypto.randomBytes(16).toString('hex')
    const user = {
      username: name,
      salt,
      passwordHash: hashPassword(password, salt),
      role,
      apiKey: generateApiKey(),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    }
    this.users.push(user)
    this.save()
    return publicUser(user)
  }

  delete(username) {
    const user = this.getByUsername(username)
    if (!user) return false
    this.users = this.users.filter((u) => u !== user)
    this.save()
    return true
  }

  setPassword(username, password) {
    const user = this.getByUsername(username)
    if (!user) return false
    if (!password || String(password).length < 6) {
      throw new Error('密码至少 6 位')
    }
    user.salt = crypto.randomBytes(16).toString('hex')
    user.passwordHash = hashPassword(password, user.salt)
    this.save()
    return true
  }

  resetApiKey(username) {
    const user = this.getByUsername(username)
    if (!user) return null
    user.apiKey = generateApiKey()
    this.save()
    return user.apiKey
  }

  setRole(username, role) {
    const user = this.getByUsername(username)
    if (!user) return false
    if (role !== 'admin' && role !== 'user') return false
    if (user.role === 'admin' && role === 'user' && !this.users.some((u) => u !== user && u.role === 'admin')) {
      throw new Error('不能删除最后一个管理员')
    }
    user.role = role
    this.save()
    return true
  }

  /**
   * Bootstrap first admin when none exists.
   * @returns {{created: boolean, username: string, password?: string}}
   */
  ensureDefaultAdmin(username, password) {
    const name = String(username || 'admin').trim().toLowerCase()
    if (this.hasAdmin()) {
      // Allow env-password to rotate the default admin for one-click deploys
      if (password && this.getByUsername(name)) {
        try {
          this.setPassword(name, password)
          return { created: false, username: name }
        } catch {
          // ignore invalid password
        }
      }
      return { created: false, username: name }
    }
    const generated = !password
    const pw = password || generatePassword()
    try {
      this.create({ username: name, password: pw, role: 'admin' })
      return { created: true, username: name, password: generated ? pw : undefined }
    } catch (err) {
      console.error(`default admin bootstrap failed: ${err instanceof Error ? err.message : err}`)
      // Fall back to a random name so the service always has an admin
      const alt = `admin-${crypto.randomBytes(3).toString('hex')}`
      this.create({ username: alt, password: generatePassword(), role: 'admin' })
      return { created: true, username: alt, password: pw }
    }
  }
}
