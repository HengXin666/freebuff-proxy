/**
 * 目录协议（catalog protocol）—— 上游**服务端可验证的模型身份**。
 *
 * 这是最后一块拼图。真机抓包 + 官方公开源码（common/src/types/
 * freebuff-model-catalog.ts）确认：
 *
 *   1. 客户端先 `GET /api/v1/freebuff/models`（带 x-freebuff-catalog-protocol: 1）
 *      抓目录，响应给出一个 `fetchId`；
 *   2. 目录响应里的模型不是 id 而是**句柄**（`fbm1.` 前缀，服务端签名，
 *      客户端无法伪造）；
 *   3. 之后每个 session / completions 请求都带：
 *        x-freebuff-catalog-protocol: 1
 *        x-freebuff-catalog-fetch:    <fetchId>
 *      并且 `model` 字段用**句柄**而不是 `deepseek/deepseek-v4-flash`。
 *
 * 官方对 protocol 头的注释说得最清楚：
 *   "Its presence is what tells the session endpoints to answer with catalog
 *    keys instead of model ids."
 *
 * 也就是说：**必须持有一个有效目录句柄，服务端才把请求认作目录客户端**。
 * 我们此前既没抓目录、也不用句柄 —— 服务端只能按 legacy 路径处理，于是
 * 在受限出口下直接拒绝。
 *
 * 见 .agents/notes/implemented/bug-fix/2026-10-01-catalog-protocol.md
 */
import { logger } from '../util/log.js'

/** 官方常量真值（common/src/types/freebuff-model-catalog.ts）。 */
export const CATALOG_PATH = '/api/v1/freebuff/models'
export const HEADER_CATALOG_PROTOCOL = 'x-freebuff-catalog-protocol'
export const CATALOG_PROTOCOL_VERSION = '1'
export const HEADER_CATALOG_FETCH = 'x-freebuff-catalog-fetch'
export const MODEL_HANDLE_PREFIX = 'fbm1.'

/** 判断一个字符串是不是目录模型句柄（fbm1. 前缀）。 */
export function isModelHandle(value) {
  return typeof value === 'string' && value.startsWith(MODEL_HANDLE_PREFIX)
}

/**
 * 一个账号持有的目录抓取结果。
 *
 * 句柄是**服务端签名**的，客户端无法自造；所以只能老老实实抓一次并缓存。
 * 缓存有上限时长（服务端会以 `freebuff_catalog_stale` 告知失效）。
 */
export class CatalogHolder {
  /**
   * @param {{ apiHost: string, token: string, fetchImpl?: Function, timeoutMs?: number }} opts
   */
  constructor(opts) {
    this.apiHost = opts.apiHost
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl || globalThis.fetch
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 20_000
    /** @type {string|null} */
    this.fetchId = null
    /** @type {Map<string, string>} 模型 id → 句柄 */
    this.handles = new Map()
    /** 抓取失败后的退避截止时间。 */
    this.retryAfter = 0
    /** 进行中的抓取（避免并发重复抓）。 */
    this.inflight = null
  }

  /** 是否已持有可用目录。 */
  get ready() {
    return typeof this.fetchId === 'string' && this.fetchId.length > 0
  }

  /**
   * 把一个模型标识映射成服务端句柄；没有对应句柄时原样返回（legacy 路径）。
   *
   * 接受的输入：
   *   - `m-xxxx`（目录 key）—— 会话回执里服务端给的就是这个，**主路径**；
   *   - `fbm1.xxx`（已是句柄）—— 原样返回；
   *   - `provider/name`（legacy 模型 id）—— 目录里没有该键，原样返回。
   *
   * 真机证据：官方 chat 的 model 字段是 `fbm1.AAEAAUPe2Us...`（句柄），
   * 而会话回执给的是 `m-00032eaeec`（key）。所以必须做这层映射。
   * @param {string} modelId
   * @returns {string}
   */
  handleFor(modelId) {
    if (typeof modelId !== 'string' || !modelId) return modelId
    if (isModelHandle(modelId)) return modelId
    return this.handles.get(modelId) || modelId
  }

  /** 目录相关的两个头（未持有时返回 {}，让调用方走 legacy）。 */
  headers() {
    if (!this.ready) return {}
    return {
      [HEADER_CATALOG_PROTOCOL]: CATALOG_PROTOCOL_VERSION,
      [HEADER_CATALOG_FETCH]: this.fetchId,
    }
  }

  /**
   * 抓一次目录。best-effort：失败返回 false 并退避，**绝不抛**。
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async fetch(opts = {}) {
    if (this.ready && !opts.force) return true
    if (Date.now() < this.retryAfter && !opts.force) return false
    if (this.inflight) return this.inflight
    this.inflight = this._doFetch().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  async _doFetch() {
    const url = `${this.apiHost}${CATALOG_PATH}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    if (timer.unref) timer.unref()
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          'x-codebuff-api-key': this.token,
          [HEADER_CATALOG_PROTOCOL]: CATALOG_PROTOCOL_VERSION,
        },
        signal: ac.signal,
      })
      if (!res.ok) {
        logger.warn('catalog fetch rejected', { status: res.status })
        this.retryAfter = Date.now() + 5 * 60_000
        return false
      }
      const body = await res.json()
      const fetchId = body && (body.fetchId || body.catalogFetchId)
      if (typeof fetchId !== 'string' || !fetchId) {
        logger.warn('catalog response missing fetchId', {
          keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 12) : [],
        })
        this.retryAfter = Date.now() + 5 * 60_000
        return false
      }
      this.fetchId = fetchId
      this.handles = new Map()
      // 目录行：{ key: 'm-xxxx', handle: 'fbm1.xxx', displayName, ... }
      // ⚠️ 响应字段是 `rows`（不是 models/data），行内的标识是 `key` 与 `handle`。
      // 实测样本：
      //   {"key":"m-00032eaeec","handle":"fbm1.AAEAAUPe2Us...",
      //    "displayName":"MiMo 2.6 Flash",...}
      const rows = Array.isArray(body?.rows)
        ? body.rows
        : Array.isArray(body?.models)
          ? body.models
          : []
      for (const m of rows) {
        if (!m || typeof m !== 'object') continue
        const key = m.key
        const handle = m.handle
        if (typeof handle === 'string' && isModelHandle(handle)) {
          // key 是服务端标识；displayName 也建一条映射方便按名字查找
          if (typeof key === 'string') this.handles.set(key, handle)
        }
      }
      // 默认/推荐模型（会话回执与 recommendedKey 用的就是它）
      this.recommendedKey =
        typeof body?.recommendedKey === 'string' ? body.recommendedKey : null
      this.fallbackKey =
        typeof body?.fallbackKey === 'string' ? body.fallbackKey : null
      logger.info('catalog fetched', {
        fetchId: fetchId.slice(0, 24) + '...',
        handles: this.handles.size,
        recommendedKey: this.recommendedKey,
        version: body?.version ?? null,
      })
      return true
    } catch (err) {
      logger.debug('catalog fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      this.retryAfter = Date.now() + 5 * 60_000
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}
