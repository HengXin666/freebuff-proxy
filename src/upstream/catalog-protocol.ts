/**
 - 目录协议(catalog protocol)-- 上游服务端可验证的模型身份.
 *
 - 真机抓包与官方源码确认: 客户端先 GET /api/v1/freebuff/models(带
 - x-freebuff-catalog-protocol: 1)抓目录, 响应给出 fetchId; 目录里的模型不是 id
 - 而是句柄(fbm1. 前缀, 服务端签名); 之后 session / completions 都带 protocol: 1
 - 与 fetch: <fetchId>, model 用句柄. 持有有效目录句柄服务端才认作目录客户端;
 - 此前不抓目录也不用句柄, 只能按 legacy 路径处理, 受限出口下直接拒绝.
 *
 - 实现已按职责拆进 protocol/**; 本文件保留真源身份与对外导出名, 见
 - .agents/notes/implemented/bug-fix/2026-10-01-catalog-protocol.md.
 */
import { logger } from '../util/log.ts'
import { parseCatalogBody } from './protocol/parse.ts'
import { doFetch } from './protocol/fetch.ts'
import {
  displayNameForKey as protoDisplayNameForKey,
  digestForKey as protoDigestForKey,
  handleFor as protoHandleFor,
  handleForModelWith as protoHandleForModelWith,
} from './protocol/lookup.ts'
import {
  fetchOnlyHeadersOf as protoFetchOnlyHeaders,
  headersOf as protoHeaders,
  rowOf as protoRow,
  rowsOf as protoRows,
} from './protocol/views.ts'

/**
 - 官方常量真值与 isModelHandle 的对外导出.
 - 定义已随拆分搬进 protocol/constants.ts(为消除与 parse / fetch 之间的循环
 - import); 这里原样 re-export, 外部消费者(含 test 的真源唯一性判据)无需改动.
 - import);这里原样 re-export, 外部消费者(含 test 里的真源唯一性判据)无需改动.
 */
export {
  CATALOG_FETCH_USER_AGENT, CATALOG_PATH, CATALOG_PROTOCOL_VERSION, CLIENT_DESKTOP,
  HEADER_CATALOG_FETCH, HEADER_CATALOG_PROTOCOL, HEADER_CLIENT, MODEL_HANDLE_PREFIX,
  isModelHandle,
} from './protocol/constants.ts'

/**
 - 目录行的 legacy 摘要 -- 把旧的模型 id 映射到目录行的唯一钥匙. 逐字对齐官方 freebuffLegacyModelDigest(): 双 FNV-1a, 命名空间字符串
 - freebuff-legacy-model:, 32 位无符号, 输出 16 位小写 hex. 官方为何用摘要而不直接列 id: 目录无需列模型 id, 因为 id 本身已公开.
 - 这不是 sha256(曾猜错一次). 真机目录逐条验证: deepseek/deepseek-v4-flash 到 1e303ac563a6f9cc(行 m-096e75164d);
 - mimo/mimo-v2.5 到 5acfab992d88345c(行 m-00032eaeec), 均与服务端一致.
 - @param {string} modelId 上游模型 id
 - @returns {string} 16 位小写 hex
 */
export function freebuffLegacyModelDigest(modelId: any) {
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
 - 一个账号持有的目录抓取结果. 句柄由服务端签名, 客户端无法自造, 所以只能抓
 - 一次并缓存(服务端以 freebuff_catalog_stale 告知失效).
 */
export class CatalogHolder {
  declare apiHost: any
  declare token: any
  declare fetchImpl: any
  declare timeoutMs: any
  declare rowByKey: any
  declare bunFetch: any
  declare handles: any
  declare legacyIndex: any
  declare displayNames: any
  declare keyByName: any
  declare keyByDigest: any
  declare digestByKey: any
  declare retryAfter: any
  declare inflight: any
  declare recommendedKey: any
  declare fallbackKey: any
  declare issuedAt: any
  declare refreshAt: any
  declare version: any
  declare fetchId: any
  /**
   - @param {{ apiHost: string, token: string, fetchImpl?: Function, timeoutMs?: number }} opts
   */
  constructor(opts: any) {
    this.apiHost = opts.apiHost
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl || globalThis.fetch
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 20_000
    /**
     - 目录行全量快照(key 到 row 原文). 模型清单的权威是目录 rows, 而会话回执的
     - rateLimitsByModel 只是"今日给了额度的子集"(实测 13 行 vs 6 键), 用它反推
     - 必然漏 -- 这正是[没有任何可用模型]的根因. row 保留服务端原文, 展示侧直接
     - 取用, 不再从 2026-08 的内置静态表反查(那份 13 行只命中 3 行).
     */
    this.rowByKey = new Map()
    /**
     - 可选的 bun 执行通道: 把 catalog 请求交给官方同一个运行时发. 由调用方
     - (client.ts)注入 callBun; 为 null 时走 Node 路径.
     - @type {((input: object) => Promise<any>) | null}
     */
    this.bunFetch = opts.bunFetch || null
    /** @type {string|null} 目录 fetchId(就绪判据). */
    this.fetchId = null
    /** @type {Map<string, string>} 目录 key(m-xxx)到句柄(fbm1.xxx). */
    this.handles = new Map()
    /**
     - @type {Map<string, string>} legacy 模型 id 的 FNV-1a 摘要到句柄.
     - 官方目录不列模型 id, 只给每行的 legacyDigests; 这是把
     - deepseek/deepseek-v4-flash 这类 id 映射到服务端行的唯一正确途径.
     */
    this.legacyIndex = new Map()
    /**
     - @type {Map<string, string>} 目录 key(m-xxx)到人类可读显示名.
     - 上游回执用的全是目录 key(m-00032eaeec), 控制台要显示成人能认的名字;
     - 目录行自带 displayName, 抓一次就缓存, 否则前端只会裸显示 m-00032eaeec.
     */
    this.displayNames = new Map()
    /**
     - @type {Map<string, string>} 显示名到目录 key(反向索引).
     - 下游拿到的只有 /v1/models 的 id 与 display_name, 有人会照着 display_name
     - 填 model; 而上游只认 key / 句柄, 裸显示名必然 400/503. 有这张表就能把
     - "MiMo 2.6 Flash" 落回 m-00032eaeec. 见
     - .agents/notes/implemented/bug-fix/2026-10-02-catalog-key-display-name-bridge.md
     */
    this.keyByName = new Map()
    /**
     - @type {Map<string, string>} legacy 摘要到目录 key.
     - 与 legacyIndex(摘要到句柄)互补: 句柄给上游发请求用, key 给回执与展示用.
     */
    this.keyByDigest = new Map()
    /**
     - @type {Map<string, string>} 目录 key 到 legacy 摘要(keyByDigest 的反向).
     - 展示侧要[ key 到人类可读 id ]必须先回到摘要; 一行可有多个摘要, 取第一个.
     */
    this.digestByKey = new Map()
    /** 抓取失败后的退避截止时间. */
    this.retryAfter = 0
    /** 进行中的抓取(避免并发重复抓). */
    this.inflight = null
  }

  /**
 - 目录 key 到可读显示名; 查不到返回 null(调用方回落到原 key).
 - @param {string} key
 - @returns {string | null}
 */
  displayNameForKey(key: any) {
    return protoDisplayNameForKey(this, key)
  }

  /**
   - 人类可读显示名或上游 legacy id 或目录 key, 三种输入都归一到目录 key.
   - 这条实现必须留在本文件: 它是"上游 id 到目录 key"的唯一真源, 真源唯一性
   - 判据(test/verify-model-mapping-truth.mjs)按路径核对.
   - @param {string} name 任一形式的模型标识
   - @returns {string | null} 目录 key
   */
  keyForName(name: any) {
    if (typeof name !== 'string') return null
    const k = name.trim()
    if (!k) return null
    // ① 可读名(displayName)到 key
    const byName = this.keyByName.get(k) || this.keyByName.get(k.toLowerCase())
    if (byName) return byName
    // ② 上游 legacy 模型 id 到 key(复用同一套摘要索引, 不另算一遍)
    const byDigest = this.keyByDigest.get(freebuffLegacyModelDigest(k))
    if (byDigest) return byDigest
    // ③ 已是目录 key: 自反
    if (this.handles.has(k)) return k
    return null
  }

  /**
 - 目录 key 到 legacy 摘要(用于反查人类可读 id). 查不到返回 null.
 - @param {string} key
 - @returns {string | null}
 */
  digestForKey(key: any) {
    return protoDigestForKey(this, key)
  }

  /** 是否已持有可用目录(fetchId 存在即就绪). */
  get ready() {
    return typeof this.fetchId === 'string' && this.fetchId.length > 0
  }

  /**
   - 把一个模型标识映射成服务端句柄; 命中不了时原样返回(legacy 路径).
   - 实现见 protocol/lookup.ts; 摘要函数的真源留在本文件.
   - @param {string} modelId 模型标识
   - @returns {string} 句柄
 */
  handleFor(modelId: any) {
    return protoHandleFor(this, modelId, freebuffLegacyModelDigest)
  }

  /**
   - 模型 id 到目录句柄, 带 displayName 兜底. 实现见 protocol/lookup.ts;
   - keyForName 与摘要函数的真源留在本文件.
   - @param {string} modelId legacy 模型 id
 - @param {string|null} [displayName] 静态快照里的可读名
 - @returns {string} 句柄; 都命中不了则原样返回 modelId
 */
  handleForModel(modelId: any, displayName = null) {
    return protoHandleForModelWith(
      this, modelId, displayName,
      (name) => this.keyForName(name),
      freebuffLegacyModelDigest,
    )
  }

  /** 是否已在本次目录里(有对应行). */
  hasModel(modelId: any) {
    return this.handleFor(modelId) !== modelId
  }

  /**
   - 目录行全量(模型清单的权威), 按 sortOrder 升序(与官方菜单一致).
   - 实现见 protocol/views.ts.
   - @returns {any[]} 目录行(已排序)
 */
  rows() {
    return protoRows(this.rowByKey)
  }

  /**
 - 单个目录行(原文). 查不到返回 null.
 - @param {string} key
 - @returns {any|null} 目录行
 */
  row(key: any) {
    return protoRow(this.rowByKey, key)
  }

  /** 目录相关的两个头(未持有时返回空对象, 让调用方走 legacy). */
  headers() {
    return protoHeaders(this.ready ? this.fetchId : null)
  }

  /**
   - 只给 x-freebuff-catalog-fetch, 不给 -protocol. 官方 chat 头部恒为 8 项,
   - 没有 catalog-protocol -- 它只出现在 catalog 与 admission 上.
   - 见 docs/reverse/15-protocol-review.md P0-1.
 */
  fetchOnlyHeaders() {
    return protoFetchOnlyHeaders(this.ready ? this.fetchId : null)
  }

  /**
   - 抓一次目录. best-effort: 失败返回 false 并退避, 绝不抛.
   - @param {{ force?: boolean }} [opts] force 为真时忽略缓存与退避
   - @returns {Promise<boolean>} 是否抓到
   */
  async fetch(opts: any = {}) {
    if (this.ready && !opts.force) return true
    if (Date.now() < this.retryAfter && !opts.force) return false
    if (this.inflight) return this.inflight
    this.inflight = doFetch(this).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /**
   - 解析并应用一份目录响应(bun 路径与 Node 路径共用).
   -
   - 非摘要部分在 protocol/parse.ts(纯函数). 摘要索引(legacyIndex /
   - keyByDigest / digestByKey)就地建: 它们与 keyForName 同属一条真源.
   - @param {any} body 目录响应原文
   - @returns {boolean} 是否成功(缺 fetchId 视为失败)
   */
  _apply(body: any) {
    const parsed: any = parseCatalogBody(body)
    if (!parsed.ok) {
      logger.warn('catalog response missing fetchId', {
        keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 12) : [],
      })
      return false
    }
    this.fetchId = parsed.fetchId
    this.handles = parsed.handles
    this.displayNames = parsed.displayNames
    this.keyByName = parsed.keyByName
    this.rowByKey = parsed.rowByKey
    this.recommendedKey = parsed.recommendedKey
    this.fallbackKey = parsed.fallbackKey
    this.issuedAt = parsed.issuedAt
    this.refreshAt = parsed.refreshAt
    this.version = parsed.version
    // 摘要索引: 官方不直接列模型 id, 只给每行 legacyDigests(旧 id 的 FNV-1a
    // 摘要). 用 recommendedKey 兜底是错的 -- 会把 deepseek-v4-flash 映射到
    // m-00032eaeec(MiMo), 会话绑 MiMo 而 agent 是 deepseek, chat 必然 503.
    this.legacyIndex = new Map()
    this.keyByDigest = new Map()
    this.digestByKey = new Map()
    for (const m of parsed.rowByKey.values()) {
      const digests = Array.isArray(m.legacyDigests) ? m.legacyDigests : []
      for (const d of digests) {
        if (typeof d !== 'string' || !d) continue
        this.legacyIndex.set(d, m.handle)
        // 摘要到 key(回执与展示侧口径): 与 legacyIndex(摘要到句柄)互补.
        this.keyByDigest.set(d, m.key)
        if (!this.digestByKey.has(m.key)) this.digestByKey.set(m.key, d)
      }
    }
    logger.info('catalog fetched', {
      fetchId: this.fetchId.slice(0, 24) + '...',
      handles: this.handles.size,
      rows: this.rowByKey.size,
      recommendedKey: this.recommendedKey,
      version: this.version,
    })
    return true
  }
}
