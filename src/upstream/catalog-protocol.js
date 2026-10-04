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

/**
 * 官方 catalog 抓取的客户端头（抓包真值）。
 * 官方 `fetchOnce()` 只在 catalog 这一跳同时带 protocol + client 两件套，
 * 其余头一概不带（见 docs/reverse/19 §19.2）。
 */
export const HEADER_CLIENT = 'x-freebuff-client'
export const CLIENT_DESKTOP = 'desktop'
/** 官方 orchestrator 由 bun 执行，bun 的裸 fetch 默认 UA 就是它。 */
export const CATALOG_FETCH_USER_AGENT = 'Bun/1.4.2'

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
    /**
     * 目录行全量快照（key → row 原文）。
     *
     * 存在的理由：目录 `rows` 才是**模型清单的权威**，而会话回执里的
     * rateLimitsByModel 只是"今日给了额度的子集"（实测 13 行目录 vs 6 个
     * rateLimit 键），用它反推模型清单必然漏 —— 这正是「远程请求模型返回
     * 没有任何可用模型」的根因。见 docs/reverse/19-catalog-is-the-model-list.md。
     *
     * row 保留服务端原文（displayName / premium / access / efforts /
     * contextWindow / multimodal / tagline / sortOrder / legacyDigests），
     * 展示侧直接取用，不需要再从内置静态表反查（那份是 2026-08 快照，
     * 13 行里只命中 3 行）。
     */
    this.rowByKey = new Map()
    /**
     * 可选的 bun 执行通道：把 catalog 请求交给官方同一个运行时发。
     * 由调用方（client.js）注入 `callBun`；为 null 时走 Node 路径。
     * @type {((input: object) => Promise<any>) | null}
     */
    this.bunFetch = opts.bunFetch || null
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
     * @type {Map<string, string>} 显示名 → 目录 key（**反向**索引）。
     *
     * 存在的理由：下游 Agent 拿到的只有 `/v1/models` 的 id 与 display_name，
     * 有人会**照着 display_name 填 model 字段**（模型选单里显示什么就填什么）。
     * 上游只认目录 key / 句柄，裸显示名直接发过去必然 400/503。
     * 有了这张表就能把 "MiMo 2.6 Flash" 落回 m-00032eaeec 再走正常映射。
     * 见 .agents/notes/implemented/bug-fix/2026-10-02-catalog-key-display-name-bridge.md
     */
    this.keyByName = new Map()
    /**
     * @type {Map<string, string>} legacy 摘要 → 目录 key。
     * 与 legacyIndex（摘要 → 句柄）互补：句柄是给上游发请求用的，
     * key 是回执/展示侧用的，两边口径不同都要能查。
     */
    this.keyByDigest = new Map()
    /**
     * @type {Map<string, string>} 目录 key → legacy 摘要（keyByDigest 的反向）。
     * 展示侧要「key → 人类可读 id」必须先回到摘要，再拿摘要去内置 catalog
     * 反查；只有 key → 句柄 那张表不够用（句柄不是摘要）。
     * 一行可以有多个 legacyDigests，取第一个。
     */
    this.digestByKey = new Map()
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

  /**
   * 人类可读显示名 → 目录 key（反向解析，大小写与首尾空白不敏感）。
   *
   * 用途：调用方（chat 的 model 字段）拿到的可能是 displayName —— 那是
   * `/v1/models` 里除了 id 之外唯一人看得懂的东西，照着填很自然。
   * 查不到返回 null，调用方保持原值（绝不因此让请求失败）。
   * @param {string} name
   * @returns {string | null}
   */
  keyForName(name) {
    if (typeof name !== 'string') return null
    const k = name.trim()
    if (!k) return null
    // ① 可读名（displayName）→ key
    const byName = this.keyByName.get(k) || this.keyByName.get(k.toLowerCase())
    if (byName) return byName
    /**
     * ② **上游 legacy 模型 id → key**（`deepseek/deepseek-v4-flash` 这类）。
     *
     * 这是长期缺失的一环（2026-10-04 用户当场指出："所有的对下游都会映射，
     * 所有的对上游的也会映射，你每次都忘这个东西"）。
     *
     * 为什么必须有：上游会话清单（`desktopPurchases[].model`）用的是
     * **上游 id**，而调度内部一律用**目录 key**（m-xxx）。少了这条映射，
     * 两侧标识不同 → 严格相等永远匹配不上 → **面板能显示那条已付费会话、
     * 调度却看不见它**，于是白花钱去别处买新的。
     *
     * 复用与 `handleFor()` **同一套**摘要索引（`keyByDigest`），
     * 不另算一遍摘要、不引第二真源。
     */
    const byDigest = this.keyByDigest?.get(freebuffLegacyModelDigest(k))
    if (byDigest) return byDigest
    // ③ 已是目录 key：自反
    if (this.handles?.has(k)) return k
    return null
  }

  /**
   * 目录 key → legacy 摘要（用于反查人类可读 id）。查不到返回 null。
   * @param {string} key
   * @returns {string | null}
   */
  digestForKey(key) {
    if (typeof key !== 'string' || !key) return null
    return this.digestByKey.get(key) || null
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

  /**
   * 模型 id → 目录句柄，带 **displayName 兜底**。
   *
   * 为什么需要兜底：主服务 `/v1/models` 的 id 来自**静态快照**
   * （从官方仓库同步的 60 项），而目录是**实时**的（53 行）。两者会漂移 ——
   * 实测（2026-10-03）：快照里有 `deepseek/deepseek-v4.1-flash`，
   * 但实时目录里该行（`m-096e75164d` / "DeepSeek V4.1 Flash"）的
   * legacyDigest 对应的是 `deepseek/deepseek-v4-flash`。
   * 于是 `handleFor('deepseek/deepseek-v4.1-flash')` 不命中，
   * admission 会把模型名原样发出去，服务端认不出。
   *
   * 兜底只做一件稳妥的事：用**完全一致的 displayName** 反查目录 key。
   * 不做模糊匹配、不用 recommendedKey（后者已被证伪：会静默换模型）。
   *
   * @param {string} modelId legacy 模型 id
   * @param {string|null} [displayName] 静态快照里的可读名
   * @returns {string} 句柄；都命中不了则原样返回 modelId
   */
  handleForModel(modelId, displayName = null) {
    const direct = this.handleFor(modelId)
    if (direct !== modelId) return direct
    if (!displayName) return modelId
    const key = this.keyForName(displayName)
    if (!key) return modelId
    const handle = this.handles.get(key)
    return handle || modelId
  }

  /** 是否已在本次目录里（有对应行）。 */
  hasModel(modelId) {
    return this.handleFor(modelId) !== modelId
  }

  /**
   * 目录行全量（**模型清单的权威**）。
   *
   * 按 `sortOrder` 升序返回（与官方客户端模型菜单的顺序一致）。
   * 每行是服务端原文，调用方直接读 displayName / premium / access 等字段，
   * **不要**再从内置静态 catalog 反查（那份是 2026-08 快照，13 行只命中 3 行）。
   *
   * @returns {{ key: string, handle: string, displayName: string, tagline?: string,
   *   premium: boolean, access: string, multimodal: boolean, efforts?: string[],
   *   contextWindow?: number, dataUse?: string, badges?: any[],
   *   legacyDigests?: string[], sortOrder?: number }[]}
   */
  rows() {
    return [...this.rowByKey.values()].sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
    )
  }

  /**
   * 单个目录行（原文）。查不到返回 null。
   * @param {string} key
   */
  row(key) {
    return this.rowByKey.get(key) || null
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
   * 只给 `x-freebuff-catalog-fetch`，**不给** `-protocol`。
   *
   * 官方 chat 头部恒为 8 项（抓包 8 个样本 diff 为空集）：
   *   Authorization / Content-Type / 三段 UA / acting-user-id /
   *   catalog-fetch / device-key / device-sig / device-ts
   * **没有** catalog-protocol —— 它只出现在 catalog 与 admission 上。
   * 见 docs/reverse/15-protocol-review.md P0-1。
   */
  fetchOnlyHeaders() {
    if (!this.ready) return {}
    return { [HEADER_CATALOG_FETCH]: this.fetchId }
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

  /**
   * 优先**在 bun 里抓目录**（与官方客户端同一个运行时）。
   *
   * 为什么必须走 bun 才叫"一致"（实测，docs/reverse/19 §19.10）：
   * Node 26 的内置 fetch 会**自动**加两个头，且 `sec-fetch-mode: cors`
   * 属于 forbidden header，设不掉：
   *
   *   Node 26   → connection / authorization / catalog-protocol / client /
   *               user-agent / accept / **accept-language** /
   *               **sec-fetch-mode: cors** / accept-encoding
   *   Bun 1.4.2 → connection / authorization / catalog-protocol / client /
   *               user-agent / accept / accept-encoding      ← 与客户端一致
   *
   * 客户端就是 bun 跑的，所以只有 bun 这一跳能做到逐字节相同。
   * bun 不可用（未随镜像分发 / 执行失败）时退回 Node 路径，可用性优先。
   */
  async _fetchViaBun() {
    if (!this.bunFetch) return null
    try {
      const out = await this.bunFetch({
        // ⚠️ apiHost 必须带走：主服务指向本地镜像做对照时，bun 侧也要
        // 打到镜像，否则会真的请求上游。
        cfg: { token: this.token, apiHost: this.apiHost || null },
        action: 'catalog',
      })
      const body = out?.catalog
      if (!body || !Array.isArray(body.rows) || !body.rows.length) return null
      if (typeof body.fetchId !== 'string' || !body.fetchId) return null
      return body
    } catch {
      return null
    }
  }

  async _doFetch() {
    /**
     * bun 路径拿到的就是目录原文（已在 bun 侧按客户端头集发出），
     * 直接走同一套解析，避免两条解析逻辑。
     */
    const viaBun = await this._fetchViaBun()
    if (viaBun) {
      this._apply(viaBun)
      logger.info('catalog fetched via bun (client-identical headers)', {
        fetchId: String(viaBun.fetchId).slice(0, 24) + '...',
        rows: viaBun.rows.length,
        version: viaBun.version ?? null,
      })
      return true
    }
    const url = `${this.apiHost}${CATALOG_PATH}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    if (timer.unref) timer.unref()
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        // ⚠️ 头集逐字对齐官方抓包（2026-10-03，77 条里 catalog 那 1 条原样）：
        //
        //   Authorization: Bearer <token>
        //   x-freebuff-catalog-protocol: 1
        //   x-freebuff-client: desktop
        //   User-Agent: Bun/1.4.2
        //   Accept: * / *      （注意：原文无空格，这里加空格仅为避免块注释提前闭合）
        //
        // 三个此前多发的东西，全部删掉（见 docs/reverse/19 §19.2）：
        //   - x-codebuff-api-key：全 77 条抓包出现 0 次；
        //   - install-id / first-tab-discount / multi-session /
        //     include-unused-rate-limits：那些是 session 那跳的头，
        //     我们此前串台带到了 catalog 上；
        //   - 设备签名三头：官方时序是 catalog（无签名）→ device-keys →
        //     session（开始签名），catalog 这一跳本来就不签。
        headers: {
          authorization: `Bearer ${this.token}`,
          [HEADER_CATALOG_PROTOCOL]: CATALOG_PROTOCOL_VERSION,
          [HEADER_CLIENT]: CLIENT_DESKTOP,
          'user-agent': CATALOG_FETCH_USER_AGENT,
          accept: '*/*',
          /**
           * ⚠️ 这两个是 **Node 内置 fetch 自动加的**，客户端（bun）不发：
           *   - `accept-language: *` —— 显式设空串即可消除；
           *   - `sec-fetch-mode: cors` —— forbidden header，**设不掉**。
           *
           * 实测（本地镜像 + 裸 fetch 对照）：
           *   Node 26 fetch → 自动带 accept-language / sec-fetch-mode
           *   Bun 1.4.2    → 只带 5 个业务头，与客户端抓包逐项一致
           * 所以这两个头是**运行时差异**，要彻底一致只能让请求跑在 bun 上
           * （见 docs/reverse/19 §19.10）。这里先把能消除的消除。
           */
          'accept-language': '',
          // 客户端发的是这四种（含 br / zstd），Node 默认只给 gzip, deflate
          'accept-encoding': 'gzip, deflate, br, zstd',
        },
        signal: ac.signal,
      })
      if (!res.ok) {
        logger.warn('catalog fetch rejected', { status: res.status })
        this.retryAfter = Date.now() + 5 * 60_000
        return false
      }
      const body = await res.json()
      const applied = this._apply(body)
      if (!applied) {
        this.retryAfter = Date.now() + 5 * 60_000
        return false
      }
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

  /**
   * 解析并应用一份目录响应（bun 路径与 Node 路径共用）。
   * @param {any} body
   * @returns {boolean} 是否成功（缺 fetchId 视为失败）
   */
  _apply(body) {
      const fetchId = body && (body.fetchId || body.catalogFetchId)
      if (typeof fetchId !== 'string' || !fetchId) {
        logger.warn('catalog response missing fetchId', {
          keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 12) : [],
        })
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
      this.keyByName = new Map()
      this.keyByDigest = new Map()
      this.digestByKey = new Map()
      this.rowByKey = new Map()
      for (const m of rows) {
        if (!m || typeof m !== 'object') continue
        const key = m.key
        const handle = m.handle
        if (typeof handle === 'string' && isModelHandle(handle)) {
          // key 是服务端标识
          if (typeof key === 'string') this.handles.set(key, handle)
        }
        // ⚠️ 目录行全量留档：模型清单的权威就是 rows（13 行），而会话回执的
        // rateLimitsByModel 只有 6 个键 —— 用后者当清单会漏掉一半以上模型。
        // 展示侧（/v1/models、控制台）直接读这份快照，不再从 2026-08 的
        // 内置静态表反查（那份 13 行只命中 3 行）。
        // 见 docs/reverse/19-catalog-is-the-model-list.md。
        if (typeof key === 'string' && key) this.rowByKey.set(key, m)
        // 回执侧（session.model / rateLimitsByModel / prices）用的是 key，
        // 控制台要把 key 显示成人能认的名字 —— 目录行自带 displayName。
        if (typeof key === 'string' && typeof m.displayName === 'string' && m.displayName) {
          this.displayNames.set(key, m.displayName)
          // 反向：显示名 → key。下游照着 display_name 填 model 时用它落回服务端
          // 认的口径（key），否则裸显示名发给上游必然被拒。
          const name = m.displayName.trim()
          if (name && !this.keyByName.has(name)) this.keyByName.set(name, key)
          if (name && !this.keyByName.has(name.toLowerCase())) {
            this.keyByName.set(name.toLowerCase(), key)
          }
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
            if (typeof d === 'string' && d) {
              this.keyByDigest.set(d, m.key)
              if (!this.digestByKey.has(m.key)) this.digestByKey.set(m.key, d)
            }
          }
        }
      }
      // 默认/推荐模型（会话回执与 recommendedKey 用的就是它）
      this.recommendedKey =
        typeof body?.recommendedKey === 'string' ? body.recommendedKey : null
      this.fallbackKey =
        typeof body?.fallbackKey === 'string' ? body.fallbackKey : null
      // 目录签发时间（/v1/models 的 created 用它，而不是本地 Date.now()）。
      this.issuedAt = Number.isFinite(body?.issuedAt) ? body.issuedAt : null
      this.refreshAt = Number.isFinite(body?.refreshAt) ? body.refreshAt : null
      this.version = typeof body?.version === 'string' ? body.version : null
      logger.info('catalog fetched', {
        fetchId: fetchId.slice(0, 24) + '...',
        handles: this.handles.size,
        rows: this.rowByKey.size,
        recommendedKey: this.recommendedKey,
        version: this.version,
      })
      return true
  }
}
