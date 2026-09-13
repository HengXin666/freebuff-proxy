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
import { readJsonFileState, noteDataFile } from '../util/json-store.js'

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
  constructor({ file, credentialsDir, config, onCredentialSaved = null }) {
    this.file = file
    this.credentialsDir = credentialsDir
    this.config = config
    /**
     * 凭证落盘后的回调（记「凭证更新时间」到账号账本）。
     * 用回调而不是直接持有 AccountRuntimes：登录流程只关心登录，账本是上层的事。
     */
    this._onCredentialSaved =
      typeof onCredentialSaved === 'function' ? onCredentialSaved : null
    /** @type {Map<string, any>} */
    this.flows = new Map()
    /** 装载结果（'ok' | 'missing' | 'invalid'）：损坏 = 等待中的登录流程全丢
     * （重新发起即可，不致命），但要在自检里看得见。 */
    this.loadStatus = 'missing'
    this.loadReason = null
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
    const st = readJsonFileState(this.file)
    noteDataFile(this.file, st)
    this.loadStatus = st.status
    this.loadReason = st.status === 'invalid' ? st.reason : null
    if (st.status === 'ok' && Array.isArray(st.data?.flows)) {
      for (const f of st.data.flows) this.flows.set(f.id, f)
    } else if (st.status === 'invalid') {
      logger.warn('数据文件损坏: 登录流程', { file: this.file, reason: st.reason })
    }
    return st
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
          // 记「凭证更新时间」：浏览器登录回调也是写凭据的入口之一。
          try {
            this._onCredentialSaved?.(saved.key)
          } catch {
            // 可观测性失败不影响登录完成
          }
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
