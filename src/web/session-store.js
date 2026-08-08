import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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
    this.load()
    this._prune()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && Array.isArray(raw.sessions)) this.sessions = raw.sessions
    } catch {
      // ignore corrupt file
    }
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
