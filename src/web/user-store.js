import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  readJsonFileState,
  noteDataFile,
  noteDroppedEntries,
  invalidShape,
  ensureObjectEntries,
  dumpDroppedEntries,
  isPlainRecord,
} from '../util/json-store.js'

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
    /**
     * 装载结果（'ok' | 'missing' | 'invalid'）。启动流程据此判断 users.json 是否
     * 需要人工处理——**损坏时绝不静默重建管理员**（用户会以为账号全丢了）。
     * @type {'ok' | 'missing' | 'invalid'}
     */
    this.loadStatus = 'missing'
    /** 损坏原因（loadStatus === 'invalid' 时）。 */
    this.loadReason = null
    /** 被丢弃的非法条目数 + 留证文件（users.json 的脏条目 = 有人丢了登录凭据）。 */
    this.droppedEntries = 0
    this.droppedBackup = null
    this.load()
  }

  load() {
    let st = readJsonFileState(this.file)
    if (st.status === 'ok' && !Array.isArray(st.data?.users)) {
      st = invalidShape('缺少 users 数组')
    }
    // 逐条校验：数组里混进 null / 非对象时，原先会在 all() 里读 u.username 抛
    // TypeError —— 那发生在**启动期**，进程还没监听端口就退出（真实故障形态）。
    // 里层字段（salt/passwordHash）不在这里判：登录时 hashPassword 会先炸，
    // 由 verifyPassword 兜住即可；这里只保证"每条都是对象且 username 可用"。
    if (st.status === 'ok') {
      const raw = st.data.users
      const checked = ensureObjectEntries(
        st.data,
        'users',
        (u) => isPlainRecord(u) && typeof u.username === 'string' && u.username.trim().length > 0,
      )
      this.users = checked.items
      if (checked.dropped) {
        this.droppedEntries = checked.dropped
        this.droppedBackup = dumpDroppedEntries(
          this.file,
          raw.filter((u) => !checked.items.includes(u)),
        )
        noteDroppedEntries(this.file, checked.dropped, checked.reason, this.droppedBackup)
        console.error(
          `[freebuff-proxy] 数据文件含非法条目: ${this.file} — ${checked.reason}` +
            (this.droppedBackup ? `（原文已留证: ${this.droppedBackup}）` : ''),
        )
        // 全部条目都是脏的 = 实质上没人能用这份文件引导 → 按损坏处理，
        // 交给启动流程拒绝启动（否则会静默重建 admin，用户以为账号全丢）。
        if (this.users.length === 0) {
          st = invalidShape(`users 数组的 ${checked.dropped} 条记录全部非法`)
        }
      }
    }
    noteDataFile(this.file, st)
    this.loadStatus = st.status
    this.loadReason = st.status === 'invalid' ? st.reason : null
    if (st.status !== 'ok') {
      // 损坏的 users.json 如果被当成"还没有账号"，ensureDefaultAdmin 会立刻
      // 建一个新 admin —— 用户看到的就是"我的用户/密码全没了"。这里保持空列表
      // 但把状态交给启动流程裁决（bin/serve.js 会拒绝启动并要求人工处置）。
      this.users = []
      if (st.status === 'invalid') {
        console.error(`[freebuff-proxy] 数据文件损坏: ${this.file} — ${st.reason}`)
      }
    }
    return st
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
    // 入参守卫：控制台/网关可能对没有 Authorization 头的请求传空值。
    if (!apiKey || typeof apiKey !== 'string') return null
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
   * @returns {{created: boolean, username: string, password?: string, rotated?: boolean, error?: string}}
   */
  ensureDefaultAdmin(username, password) {
    const name = String(username || 'admin').trim().toLowerCase()
    if (this.hasAdmin()) {
      // Allow env-password to rotate the default admin for one-click deploys
      if (password && this.getByUsername(name)) {
        try {
          this.setPassword(name, password)
          return { created: false, username: name, rotated: true }
        } catch (err) {
          // 密码不合法（<6 位）：不能静默当作"已同步"，否则日志会撒谎
          return {
            created: false,
            username: name,
            error: err instanceof Error ? err.message : String(err),
          }
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
