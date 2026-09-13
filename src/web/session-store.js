import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readJsonFileState, noteDataFile } from '../util/json-store.js'

/**
 * Web session store (control-plane logins). Persisted so restarts keep
 * sessions alive.
 *
 *   data/web-sessions.json
 *     { version: 1, sessions: [ { token, username, createdAt, expiresAt } ] }
 */
export class WebSessionStore {
  /**
   * @param {string} file
   * @param {number} ttlMs
   */
  constructor(file, ttlMs) {
    this.file = file
    this.ttlMs = ttlMs || 7 * 24 * 3600 * 1000
    /** @type {any[]} */
    this.sessions = []
    /** 装载结果（'ok' | 'missing' | 'invalid'）：损坏 = 控制台登录态重置
     * （重新登录即可），但仍要在启动自检里看得见。 */
    this.loadStatus = 'missing'
    this.loadReason = null
    this.load()
    this._prune()
  }

  load() {
    const st = readJsonFileState(this.file)
    noteDataFile(this.file, st)
    this.loadStatus = st.status
    this.loadReason = st.status === 'invalid' ? st.reason : null
    // 损坏时不能静默当"没人登录"：这只影响控制台登录态（用户重新登录即可），
    // 但要让它出现在启动横幅/自检卡片里，而不是无声无息。
    if (st.status === 'ok' && Array.isArray(st.data?.sessions)) {
      this.sessions = st.data.sessions
    }
    return st
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, sessions: this.sessions }, null, 2),
      { mode: 0o600 },
    )
    fs.renameSync(tmp, this.file)
  }

  create(username) {
    const token = crypto.randomBytes(32).toString('hex')
    const now = Date.now()
    this.sessions.push({
      token,
      username,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    })
    this._prune()
    this.save()
    return token
  }

  /** @returns {string | null} username */
  get(token) {
    if (!token) return null
    const now = Date.now()
    const found = this.sessions.find((s) => s.token === token)
    if (!found) return null
    if (Date.parse(found.expiresAt) <= now) {
      this.destroy(token)
      return null
    }
    return found.username
  }

  destroy(token) {
    const before = this.sessions.length
    this.sessions = this.sessions.filter((s) => s.token !== token)
    if (this.sessions.length !== before) this.save()
  }

  _prune() {
    const now = Date.now()
    const before = this.sessions.length
    this.sessions = this.sessions.filter(
      (s) => Date.parse(s.expiresAt) > now,
    )
    if (this.sessions.length !== before) this.save()
  }
}
