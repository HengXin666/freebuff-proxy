/**
 * 目录协议(catalog protocol)-- 上游服务端可验证的模型身份.
 *
 * 真机抓包与官方源码确认: 客户端先 GET /api/v1/freebuff/models(带
 * x-freebuff-catalog-protocol: 1)抓目录, 响应给出 fetchId; 目录里的模型不是 id
 * 而是句柄(fbm1. 前缀, 服务端签名); 之后 session / completions 都带 protocol: 1
 * 与 fetch: <fetchId>, model 用句柄. 持有有效目录句柄服务端才认作目录客户端.
 *
 * 本文件是[模型标识归一]的唯一真源:
 * - freebuffLegacyModelDigest()  上游 id 的 FNV-1a 摘要(官方算法)
 * - CatalogHolder.keyForName()   三种输入(可读名 / 上游 id / 已是 key)→ 目录 key
 *
 * 存储与只读视图在 catalog/holder-base.ts; 本文件被
 * test/suites/entries/verify/model-mapping-truth.ts 的真源唯一性判据按路径核对
 * (keyByDigest 的读写与 freebuffLegacyModelDigest 的调用只允许出现在这里).
 * 见 .agents/notes/implemented/bug-fix/2026-10-01-catalog-protocol.md.
 */
import { logger } from '../util/log.ts'
import { parseCatalogBody } from './protocol/parse.ts'
import { CatalogBase } from './catalog/holder-base.ts'

/**
 * 官方常量真值与 isModelHandle 的对外导出.
 * 定义在 protocol/constants.ts(以消除与 parse / fetch 之间的循环 import);
 * 这里原样 re-export, 外部消费者(含 test 的真源唯一性判据)无需改动.
 */
export {
  CATALOG_FETCH_USER_AGENT, CATALOG_PATH, CATALOG_PROTOCOL_VERSION, CLIENT_DESKTOP,
  HEADER_CATALOG_FETCH, HEADER_CATALOG_PROTOCOL, HEADER_CLIENT, MODEL_HANDLE_PREFIX,
  isModelHandle,
} from './protocol/constants.ts'

/**
 * 目录行的 legacy 摘要 -- 把旧的模型 id 映射到目录行的唯一钥匙. 逐字对齐官方 freebuffLegacyModelDigest(): 双 FNV-1a, 命名空间字符串
 * freebuff-legacy-model:, 32 位无符号, 输出 16 位小写 hex. 不是 sha256.
 * 真机目录逐条验证: deepseek/deepseek-v4-flash 到 1e303ac563a6f9cc(行 m-096e75164d);
 * mimo/mimo-v2.5 到 5acfab992d88345c(行 m-00032eaeec), 均与服务端一致.
 * @param {string} modelId 上游模型 id
 * @returns {string} 16 位小写 hex
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
 * 一个账号持有的目录抓取结果. 存储与视图在 catalog/holder-base.ts, 本类只保留
 * 归一到目录 key 的真源(keyForName)与建索引的 _apply.
 */
export class CatalogHolder extends CatalogBase {
  /** @type {Map<string, string>} legacy 摘要到目录 key(keyForName 的第 ② 条路径). */
  declare keyByDigest: any

  /**
   * @param {{ apiHost: string, token: string, fetchImpl?: Function, timeoutMs?: number }} opts
   */
  constructor(opts: any) {
    super(opts)
    // 基类不 import 摘要函数: 摘要真源只允许出现在本文件, 两个真源钩子在这里注入.
    this.digestOf = freebuffLegacyModelDigest
    this.keyOf = (name: string) => this.keyForName(name)
  }

  /**
   * 人类可读显示名或上游 legacy id 或目录 key, 三种输入都归一到目录 key.
   * 这条实现必须留在本文件: 它是"上游 id 到目录 key"的唯一真源, 真源唯一性
   * 判据(test/verify-model-mapping-truth.mjs)按路径核对.
   * @param {string} name 任一形式的模型标识
   * @returns {string | null} 目录 key
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
   * 解析并应用一份目录响应(bun 路径与 Node 路径共用).
   *
   * 非摘要部分在 protocol/parse.ts(纯函数). 摘要索引(legacyIndex /
   * keyByDigest / digestByKey)就地建: 它们与 keyForName 同属一条真源.
   * @param {any} body 目录响应原文
   * @returns {boolean} 是否成功(缺 fetchId 视为失败)
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
