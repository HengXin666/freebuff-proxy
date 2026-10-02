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
 * 目录行的 legacy 摘要 —— 把**旧的模型 id** 映射到目录行的唯一钥匙。
 *
 * 逐字对齐官方 common/src/types/freebuff-model-catalog.ts
 * `freebuffLegacyModelDigest()`：双 FNV-1a，命名空间字符串
 * `freebuff-legacy-model:`，32 位无符号，输出 16 位小写 hex。
 * 官方注释解释了为什么用摘要而不是直接列 id：
 *   "so the catalog need not list model ids; the legacy ids themselves are
 *    already public."
 *
 * ⚠️ 这不是 sha256（我此前猜错过一次）。**已用真机目录逐条验证**：
 *   deepseek/deepseek-v4-flash → 1e303ac563a6f9cc  （行 m-096e75164d）
 *   mimo/mimo-v2.5             → 5acfab992d88345c  （行 m-00032eaeec）
 * 两条都与服务端返回的 legacyDigests 完全一致。
 *
 * @param {string} modelId
 * @returns {string} 16 位小写 hex
 */
export function freebuffLegacyModelDigest(modelId) {
  const input = `freebuff-legacy-model:${modelId}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return (
    h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
  )
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
    /** @type {Map<string, string>} 目录 key（m-xxx）→ 句柄（fbm1.xxx） */
    this.handles = new Map()
    /**
     * @type {Map<string, string>} legacy 模型 id 的 FNV-1a 摘要 → 句柄。
     * 官方目录不列模型 id，只给每行的 legacyDigests；这是把
     * deepseek/deepseek-v4-flash 这类 id 映射到服务端行的唯一正确途径。
     */
    this.legacyIndex = new Map()
    /**
     * @type {Map<string, string>} 目录 key（m-xxx）→ 人类可读显示名。
     *
     * 上游回执（session.model / rateLimitsByModel / freebucks.prices）用的
     * 全都是目录 key（m-00032eaeec），而控制台要把它显示成人能认的名字。
     * 目录行自带 displayName，抓一次就缓存下来 —— 否则前端只会裸显示
     * `m-00032eaeec 10 FB/h` 这种服务端不透明标识。
     */
    this.displayNames = new Map()
    /**
     * @type {Map<string, string>} legacy 摘要 → 目录 key。
     * 与 legacyIndex（摘要 → 句柄）互补：句柄是给上游发请求用的，
     * key 是回执/展示侧用的，两边口径不同都要能查。
     */
    this.keyByDigest = new Map()
    /** 抓取失败后的退避截止时间。 */
    this.retryAfter = 0
    /** 进行中的抓取（避免并发重复抓）。 */
    this.inflight = null
  }

  /**
   * 目录 key → 人类可读显示名；查不到返回 null（调用方回落到原 key）。
   * @param {string} key
   * @returns {string | null}
   */
  displayNameForKey(key) {
    if (typeof key !== 'string' || !key) return null
    return this.displayNames.get(key) || null
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
    // 已是句柄：原样返回
    if (isModelHandle(modelId)) return modelId
    // 目录 key（m-xxx）：直接查
    const byKey = this.handles.get(modelId)
    if (byKey) return byKey
    // **legacy 模型 id**（deepseek/deepseek-v4-flash 这类）：用 FNV-1a 摘要命中行。
    // 这是官方设计的映射方式（目录不列 id，只给 legacyDigests）。
    const legacy = this.legacyIndex?.get(freebuffLegacyModelDigest(modelId))
    if (legacy) return legacy
    // 都不命中：原样返回（调用方据此走 legacy 路径或报错）
    return modelId
  }

  /** 该模型 id 是否在本次目录里（有对应行）。 */
  hasModel(modelId) {
    return this.handleFor(modelId) !== modelId
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
      this.displayNames = new Map()
      this.keyByDigest = new Map()
      for (const m of rows) {
        if (!m || typeof m !== 'object') continue
        const key = m.key
        const handle = m.handle
        if (typeof handle === 'string' && isModelHandle(handle)) {
          // key 是服务端标识
          if (typeof key === 'string') this.handles.set(key, handle)
        }
        // 回执侧（session.model / rateLimitsByModel / prices）用的是 key，
        // 控制台要把 key 显示成人能认的名字 —— 目录行自带 displayName。
        if (typeof key === 'string' && typeof m.displayName === 'string' && m.displayName) {
          this.displayNames.set(key, m.displayName)
        }
      }
      // legacy 摘要索引：把**客户端请求的模型 id** 映射到服务端行。
      //
      // 官方不直接在目录里列模型 id，而是给每行一个 `legacyDigests` 数组
      // （旧 id 的 FNV-1a 摘要）。我们用同一算法算请求 id 的摘要去命中行 ——
      // 这是**唯一正确**的模型映射方式。
      //
      // ⚠️ 此前用 `recommendedKey` 兜底是错的：那会把
      // deepseek/deepseek-v4-flash 映射到 m-00032eaeec（MiMo 2.6 Flash）——
      // 会话绑 MiMo、agent 却是 deepseek，chat 必然 503。
      // 实测正确映射：deepseek/deepseek-v4-flash → m-096e75164d（摘要 1e303ac563a6f9cc）。
      this.legacyIndex = new Map()
      for (const m of rows) {
        if (!m || typeof m !== 'object') continue
        const handle = m.handle
        if (typeof handle !== 'string' || !isModelHandle(handle)) continue
        const digests = Array.isArray(m.legacyDigests) ? m.legacyDigests : []
        for (const d of digests) {
          if (typeof d === 'string' && d) this.legacyIndex.set(d, handle)
        }
        // 摘要 → key（回执/展示侧口径）：与 legacyIndex（摘要 → 句柄）互补。
        if (typeof m.key === 'string' && m.key) {
          for (const d of digests) {
            if (typeof d === 'string' && d) this.keyByDigest.set(d, m.key)
          }
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
