import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { createUpstreamClient } from '../upstream/client.js'
import {
  generateFingerprintId,
  saveAccountUser,
  accountKeyOf,
} from '../auth-store.js'
import { logger } from '../util/log.js'

/**
 * Web-driven Freebuff login flow ("callback" style):
 *
 *   1. admin starts a flow → server asks Freebuff for a CLI login URL
 *   2. admin opens the URL in THEIR OWN browser (never in the container)
 *   3. server polls Freebuff /api/auth/cli/status until the browser
 *      callback authorizes the code
 *   4. credential is saved to <credentialsDir>/<email>.json and the flow
 *      flips to `done`
 *
 * Flows persist to <dataDir>/login-flows.json so restarts don't lose them.
 */
export class LoginFlowManager {
  /**
   * @param {{file: string, credentialsDir: string, config: any}} opts
   */
  constructor({ file, credentialsDir, config }) {
    this.file = file
    this.credentialsDir = credentialsDir
    this.config = config
    /** @type {Map<string, any>} */
    this.flows = new Map()
    this.load()
    /** 上一轮 pollAll 是否还在跑（上游慢/挂起时防止每 4s 再堆一轮并发轮询）。 */
    this._polling = false
    this._poller = setInterval(() => {
      if (this._polling) return
      this._polling = true
      this.pollAll()
        .catch((err) => {
          logger.warn('login flow poller error', {
            error: err instanceof Error ? err.message : String(err),
          })
        })
        .finally(() => {
          this._polling = false
        })
    }, 4000)
    this._poller.unref?.()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && Array.isArray(raw.flows)) {
        for (const f of raw.flows) this.flows.set(f.id, f)
      }
    } catch {
      // ignore
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        { version: 1, flows: [...this.flows.values()] },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    fs.renameSync(tmp, this.file)
  }

  /**
   * Start a new login flow.
   * @returns {Promise<{id: string, loginUrl: string, status: string, createdAt: string, expiresAt: string}>}
   */
  async start() {
    const upstream = createUpstreamClient(this.config, '')
    const fingerprintId = generateFingerprintId()
    const code = await upstream.loginCode(fingerprintId)
    if (!code?.loginUrl) {
      throw new Error('Freebuff 登录接口未返回 loginUrl')
    }
    const flow = {
      id: randomUUID(),
      status: 'pending',
      loginUrl: code.loginUrl,
      fingerprintId,
      fingerprintHash: code.fingerprintHash,
      expiresAt: code.expiresAt,
      createdAt: new Date().toISOString(),
      error: null,
      user: null,
    }
    this.flows.set(flow.id, flow)
    this.save()
    logger.info('login flow started', {
      id: flow.id,
      expiresAt: flow.expiresAt,
    })
    return this.publicFlow(flow)
  }

  get(id) {
    const flow = this.flows.get(id) || null
    return flow ? this.publicFlow(flow) : null
  }

  list() {
    return [...this.flows.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((f) => this.publicFlow(f))
  }

  cancel(id) {
    const flow = this.flows.get(id)
    if (!flow) return false
    if (flow.status === 'pending') {
      flow.status = 'cancelled'
      this.save()
    }
    return true
  }

  publicFlow(flow) {
    const { fingerprintHash, fingerprintId, ...rest } = flow
    return {
      ...rest,
      user: flow.user
        ? {
            key: accountKeyOf(flow.user),
            id: flow.user.id || null,
            email: flow.user.email,
            name: flow.user.name,
          }
        : null,
    }
  }

  async pollAll() {
    const now = Date.now()
    for (const flow of this.flows.values()) {
      if (flow.status !== 'pending') continue
      if (flow.expiresAt && expirationMs(flow.expiresAt) <= now) {
        flow.status = 'expired'
        flow.error = '登录链接已过期，请重新发起'
        this.save()
        continue
      }
      try {
        const upstream = createUpstreamClient(this.config, '')
        const st = await upstream.loginStatus({
          fingerprintId: flow.fingerprintId,
          fingerprintHash: flow.fingerprintHash,
          expiresAt: flow.expiresAt,
        })
        if (st?.user?.authToken) {
          const saved = saveAccountUser(this.credentialsDir, st.user)
          flow.status = 'done'
          flow.user = { key: saved.key, id: saved.user.id || null, email: saved.user.email, name: saved.user.name }
          flow.error = null
          this.save()
          logger.info('login flow completed', {
            id: flow.id,
            key: saved.key,
            email: saved.user.email,
          })
        }
      } catch (err) {
        flow.error = err instanceof Error ? err.message : String(err)
        // keep polling; transient network errors are common
      }
    }
  }

  shutdown() {
    clearInterval(this._poller)
    this._poller = null
  }
}


function expirationMs(value) {
  if (typeof value === 'number') return value
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}
