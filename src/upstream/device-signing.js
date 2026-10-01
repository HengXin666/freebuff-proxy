/**
 * 设备签名 —— 官方 CLI/Desktop 的**每请求签名链**。
 *
 * 这是上游判定「是不是注册过的真客户端」的核心判据。真机抓包（2026-10-01）
 * 确认官方 chat 请求带三个头，而我们此前一个都没有：
 *   x-freebuff-device-key:  <keyId>      （服务端注册时签发）
 *   x-freebuff-device-ts:   <ms 时间戳>
 *   x-freebuff-device-sig:  <Ed25519 签名, base64url>
 *
 * 机制（逐字对齐官方公开源码
 * common/src/util/freebuff-device-signing.ts +
 * common/src/types/freebuff-model-catalog.ts）：
 *
 *   1. 每次安装生成一对 Ed25519 密钥（WebCrypto / node:crypto 均可）；
 *   2. 公钥注册到 POST /api/v1/freebuff/device-keys，服务端返回 keyId；
 *      keyId 按 (apiHost, account) 作用域记住；
 *   3. 之后每个 catalog / session / completions 请求都带上面三个头。
 *
 * 签名载荷（**换行拼接，顺序固定**）：
 *   ```
 *   freebuff-device-v1
 *   <METHOD 大写>
 *   <pathname（不含 query）>
 *   <timestampMs>
 *   <body 的小写 hex SHA-256；无 body 时为 e3b0c442... 即空串的哈希>
 *   <fetchId 或空串>
 *   ```
 *
 * ⚠️ 已验证：用真机抓到的私钥独立重现官方对同一请求的签名，**逐字节相同**
 * （MATCH: true）。见 .agents/notes/implemented/bug-fix/2026-10-01-device-signing.md
 *
 * 签名是 **best-effort**：没有密钥、注册失败、运行时无 Ed25519 —— 请求一律
 * 不带签名发出（上游会退回未签名路径），绝不因此让请求失败。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../util/log.js'

/** 官方常量（common/src/types/freebuff-model-catalog.ts）。 */
export const FREEBUFF_DEVICE_KEYS_PATH = '/api/v1/freebuff/device-keys'
export const HEADER_DEVICE_KEY = 'x-freebuff-device-key'
export const HEADER_DEVICE_TIMESTAMP = 'x-freebuff-device-ts'
export const HEADER_DEVICE_SIGNATURE = 'x-freebuff-device-sig'

/** 签名载荷的版本前缀（官方字面量）。 */
export const DEVICE_SIGNATURE_VERSION = 'freebuff-device-v1'

function b64uEncode(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function b64uDecode(value) {
  const b64 = String(value).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64')
}

/**
 * 官方签名载荷。逐字段对齐 freebuffDeviceSignaturePayload()：
 * 换行拼接、METHOD 大写、path 只取 pathname、body 哈希为小写 hex、
 * fetchId 缺失时用**空串**占位（不是省略该行）。
 * @param {{ method: string, path: string, timestampMs: number, bodySha256: string, fetchId?: string|null }} p
 * @returns {string}
 */
export function deviceSignaturePayload(p) {
  return [
    DEVICE_SIGNATURE_VERSION,
    String(p.method).toUpperCase(),
    p.path,
    String(p.timestampMs),
    p.bodySha256,
    p.fetchId ?? '',
  ].join('\n')
}

/** body 的小写 hex SHA-256（无 body = 空串的哈希）。 */
export function bodySha256(body) {
  const data = body === null || body === undefined ? '' : String(body)
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * 生成一对 Ed25519 密钥（对齐 FreebuffDeviceKeyRecord 形状）。
 * @returns {{ version: 1, publicKey: string, privateKey: string, registrations: Record<string,string> }}
 */
export function generateDeviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const rawPub = publicKey.export({ format: 'der', type: 'spki' })
  // raw 32 字节公钥 = SPKI DER 的末 32 字节（SPKI 头部固定 12 字节）
  const rawPubBytes = rawPub.subarray(rawPub.length - 32)
  return {
    version: 1,
    publicKey: b64uEncode(rawPubBytes),
    privateKey: b64uEncode(privateKey.export({ format: 'der', type: 'pkcs8' })),
    registrations: {},
  }
}

/** 校验并规范化一个已存的密钥记录（对齐 parseFreebuffDeviceKeyRecord）。 */
export function parseDeviceKeyRecord(value) {
  if (!value || typeof value !== 'object') return null
  if (value.version !== 1) return null
  if (typeof value.publicKey !== 'string' || typeof value.privateKey !== 'string') {
    return null
  }
  const registrations = {}
  const stored = value.registrations
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [scope, keyId] of Object.entries(stored)) {
      if (typeof keyId === 'string' && keyId) registrations[scope] = keyId
    }
  }
  return {
    version: 1,
    publicKey: value.publicKey,
    privateKey: value.privateKey,
    registrations,
  }
}

/** 注册作用域：一个 (apiHost, account) 一个 keyId（官方同款字符串）。 */
export function registrationScope(apiHost, accountId) {
  return `${apiHost} user:${accountId}`
}

/** 从 PKCS#8（base64url）导入私钥对象。 */
export function importDevicePrivateKey(record) {
  try {
    return crypto.createPrivateKey({
      key: b64uDecode(record.privateKey),
      format: 'der',
      type: 'pkcs8',
    })
  } catch {
    return null
  }
}

/**
 * 对一个请求算签名，返回三个头。纯函数（不碰 IO），便于测试。
 * @param {{ privateKey: crypto.KeyObject, keyId: string, method: string, url: string, body?: string|null, fetchId?: string|null, timestampMs?: number }} p
 * @returns {Record<string,string>}
 */
export function signDeviceRequest(p) {
  const url = new URL(p.url)
  const timestampMs = p.timestampMs ?? Date.now()
  const payload = deviceSignaturePayload({
    method: p.method,
    path: url.pathname,
    timestampMs,
    bodySha256: bodySha256(p.body),
    fetchId: p.fetchId ?? null,
  })
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), p.privateKey)
  return {
    [HEADER_DEVICE_KEY]: p.keyId,
    [HEADER_DEVICE_TIMESTAMP]: String(timestampMs),
    [HEADER_DEVICE_SIGNATURE]: b64uEncode(sig),
  }
}

/**
 * 设备签名器：持有密钥、按作用域注册、给请求签名。
 *
 * 全部 best-effort —— 任何一步失败都让请求**不带签名**发出，绝不阻塞或抛错
 * （对齐官方 "Signing is best-effort by design"）。
 */
export class DeviceSigner {
  /**
   * @param {{ storePath: string, apiHost: string, accountId: string, token: string, fetchImpl?: Function, timeoutMs?: number }} opts
   */
  constructor(opts) {
    this.storePath = opts.storePath
    this.apiHost = opts.apiHost
    this.accountId = opts.accountId
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl || globalThis.fetch
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10_000
    this.record = null
    this.privateKey = null
    this.keyId = null
    /** 注册失败后的退避截止时间，避免每个请求都重试。 */
    this.retryAfter = 0
  }

  /** 读盘（失败时返回 null，不抛）。 */
  load() {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8')
      const rec = parseDeviceKeyRecord(JSON.parse(raw))
      return rec
    } catch {
      return null
    }
  }

  /** 原子写盘，权限 0600（对齐官方 DEVICE_KEY_FILE_MODE）。 */
  save(record) {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true })
      const tmp = `${this.storePath}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
      fs.renameSync(tmp, this.storePath)
      return true
    } catch (err) {
      logger.debug('device key save failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  /** 确保有密钥（无则生成）。返回私钥对象或 null。 */
  ensureKey() {
    if (this.privateKey) return this.privateKey
    let rec = this.load()
    if (!rec) {
      rec = generateDeviceKey()
      if (!this.save(rec)) return null
    }
    const key = importDevicePrivateKey(rec)
    if (!key) return null
    this.record = rec
    this.privateKey = key
    const scope = registrationScope(this.apiHost, this.accountId)
    this.keyId = rec.registrations[scope] || null
    return key
  }

  /**
   * 注册公钥拿 keyId。best-effort：失败返回 null 并退避。
   * @returns {Promise<string|null>}
   */
  async register() {
    if (this.keyId) return this.keyId
    if (Date.now() < this.retryAfter) return null
    if (!this.ensureKey()) return null
    const scope = registrationScope(this.apiHost, this.accountId)
    const url = `${this.apiHost}${FREEBUFF_DEVICE_KEYS_PATH}`
    const body = JSON.stringify({
      publicKey: this.record.publicKey,
      client: 'cli',
    })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    if (timer.unref) timer.unref()
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
          'x-codebuff-api-key': this.token,
        },
        body,
        signal: ac.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        logger.warn('device key registration rejected', {
          status: res.status,
          body: text.slice(0, 200),
        })
        this.retryAfter = Date.now() + 5 * 60_000
        return null
      }
      let parsed = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      const keyId = parsed && (parsed.keyId || parsed.id || parsed.deviceKeyId)
      if (typeof keyId !== 'string' || !keyId) {
        logger.warn('device key registration returned no keyId', {
          body: text.slice(0, 200),
        })
        this.retryAfter = Date.now() + 5 * 60_000
        return null
      }
      this.record.registrations[scope] = keyId
      this.save(this.record)
      this.keyId = keyId
      logger.info('device key registered', { keyId })
      return keyId
    } catch (err) {
      logger.debug('device key registration failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      this.retryAfter = Date.now() + 5 * 60_000
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 给一个请求取签名头（best-effort）。拿不到就返回 {}。
   * @param {{ method: string, url: string, body?: string|null, fetchId?: string|null }} req
   * @returns {Promise<Record<string,string>>}
   */
  async headersFor(req) {
    try {
      if (!this.ensureKey()) return {}
      const keyId = this.keyId || (await this.register())
      if (!keyId) return {}
      return signDeviceRequest({
        privateKey: this.privateKey,
        keyId,
        method: req.method,
        url: req.url,
        body: req.body,
        fetchId: req.fetchId,
      })
    } catch {
      return {}
    }
  }
}
