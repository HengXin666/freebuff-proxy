/**
 * 目录持有者的存储与只读视图  --  CatalogHolder 的基类.
 *
 * 内容分两块: "存目录结果 + 读视图"(本文件) 与 "模型标识归一到目录 key 的真源"
 * (catalog-protocol.ts). 后者被 test/suites/entries/verify/model/mapping-truth.ts
 * 的真源唯一性判据按路径核对, 因此本文件不出现 freebuffLegacyModelDigest.
 *
 * 用类继承而非把方法挂到 prototype: 方法需要保留完整类型信息(checkJs 打开,
 * 未声明成员一律报错), 只有类声明能同时承载 declare 字段与方法签名.
 * 子类注入两个真源钩子(digestOf / keyOf).
 */
import { doFetch } from '../protocol/fetch.ts'

/**
 * 缺 fetchImpl 时的失败出口: 显式报错, 绝不静默直连.
 *
 * 静默直连的代价是出口 IP 暴露(issue #5 的 session_model_mismatch 根因),
 * 而且从日志上看不出任何异常 ---- 只有把"没有传输实现"变成硬错误才可发现.
 *
 * @returns {Promise<never>} 永远抛出
 */
function missingEgressFetch(): Promise<never> {
  return Promise.reject(new Error('catalog holder has no egress transport: pass fetchImpl from the egress layer'))
}
import {
  displayNameForKey as protoDisplayNameForKey,
  digestForKey as protoDigestForKey,
  handleFor as protoHandleFor,
  handleForModelWith as protoHandleForModelWith,
} from '../protocol/lookup.ts'
import {
  fetchOnlyHeadersOf as protoFetchOnlyHeaders,
  headersOf as protoHeaders,
  rowOf as protoRow,
  rowsOf as protoRows,
} from '../protocol/views.ts'

/**
 * 一个账号持有的目录抓取结果. 句柄由服务端签名, 客户端无法自造, 所以只能抓
 * 一次并缓存(服务端以 freebuff_catalog_stale 告知失效).
 *
 * 本类不含模型标识归一逻辑: 那是真源(catalog-protocol.ts)的职责.
 */
export class CatalogBase {
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
  /** legacy 摘要到目录 key(与 legacyIndex 互补, 见构造函数的初始化). */
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
  /** 摘要函数(真源在 catalog-protocol.ts, 由子类注入). */
  declare digestOf: (id: string) => string
  /** 三形式归一到目录 key(真源在 catalog-protocol.ts, 由子类注入). */
  declare keyOf: (name: string) => string | null

  /**
   * @param {{ apiHost: string, token: string, fetchImpl?: Function, timeoutMs?: number }} opts
   */
  constructor(opts: any) {
    this.apiHost = opts.apiHost
    this.token = opts.token
    // 没有 fetchImpl 时不给直连兜底: 那会绕过统一出口(配了代理却直连, 上游
    // 拿到宿主真实 IP). 装配侧(factory)一律经 egress 注入传输实现.
    this.fetchImpl = opts.fetchImpl || missingEgressFetch
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 20_000
    /**
     * 目录行全量快照(key 到 row 原文). 模型清单以目录 rows 为权威;
     * 会话回执的 rateLimitsByModel 只是"今日给了额度的子集", 用它反推会漏.
     * row 保留服务端原文, 展示侧直接取用.
     */
    this.rowByKey = new Map()
    /**
     * 可选的 bun 执行通道: 把 catalog 请求交给官方同一个运行时发. 由调用方
     * (client.ts)注入 callBun; 为 null 时走 Node 路径.
     * @type {((input: object) => Promise<any>) | null}
     */
    this.bunFetch = opts.bunFetch || null
    /** @type {string|null} 目录 fetchId(就绪判据). */
    this.fetchId = null
    /** @type {Map<string, string>} 目录 key(m-xxx)到句柄(fbm1.xxx). */
    this.handles = new Map()
    /**
     * @type {Map<string, string>} legacy 模型 id 的 FNV-1a 摘要到句柄.
     * 官方目录不列模型 id, 只给每行的 legacyDigests; 这是把
     * deepseek/deepseek-v4-flash 这类 id 映射到服务端行的唯一正确途径.
     */
    this.legacyIndex = new Map()
    /**
     * @type {Map<string, string>} 目录 key(m-xxx)到人类可读显示名.
     * 上游回执用的全是目录 key(m-00032eaeec), 控制台要显示成人能认的名字;
     * 目录行自带 displayName, 抓一次就缓存, 供前端显示可读模型名.
     */
    this.displayNames = new Map()
    /**
     * @type {Map<string, string>} 显示名到目录 key(反向索引).
     * 下游拿到的只有 /v1/models 的 id 与 display_name, 有人会照着 display_name
     * 填 model; 而上游只认 key / 句柄, 裸显示名必然 400/503. 这张表把
     * "MiMo 2.6 Flash" 落回 m-00032eaeec. 见
     * .agents/notes/implemented/bug-fix/2026-10-02-catalog-key-display-name-bridge.md
     */
    this.keyByName = new Map()
    /**
     * @type {Map<string, string>} legacy 摘要到目录 key.
     * 与 legacyIndex(摘要到句柄)互补: 句柄给上游发请求用, key 给回执与展示用.
     * 必须与声明成对初始化: 未初始化时 keyForName() 的 this.keyByDigest.get(...)
     * 会抛 TypeError, 并被上游错误归一层压成 no_available_account/cooldown.
     */
    this.keyByDigest = new Map()
    /**
     * @type {Map<string, string>} 目录 key 到 legacy 摘要(与 keyByDigest 反向).
     * 展示侧要[ key 到人类可读 id ]必须先回到摘要; 一行可有多个摘要, 取第一个.
     */
    this.digestByKey = new Map()
    /** 抓取失败后的退避截止时间. */
    this.retryAfter = 0
    /** 进行中的抓取(避免并发重复抓). */
    this.inflight = null
  }

  /**
   * 是否已持有可用目录(fetchId 存在即就绪).
   * @returns {boolean} 就绪为真
   */
  get ready() {
    return typeof this.fetchId === 'string' && this.fetchId.length > 0
  }

  /**
   * 目录 key 到可读显示名; 查不到返回 null(调用方回落到原 key).
   * @param {string} key 目录 key
   * @returns {string | null} 显示名
   */
  displayNameForKey(key: any) {
    return protoDisplayNameForKey(this, key)
  }

  /**
   * 目录 key 到 legacy 摘要(用于反查人类可读 id). 查不到返回 null.
   * @param {string} key 目录 key
   * @returns {string | null} 摘要
   */
  digestForKey(key: any) {
    return protoDigestForKey(this, key)
  }

  /**
   * 把一个模型标识映射成服务端句柄; 命中不了时原样返回(legacy 路径).
   * 实现见 protocol/lookup.ts; 摘要函数的真源留在 catalog-protocol.ts.
   * @param {string} modelId 模型标识
   * @returns {string} 句柄
   */
  handleFor(modelId: any) {
    return protoHandleFor(this, modelId, this.digestOf)
  }

  /**
   * 模型 id 到目录句柄, 带 displayName 兜底. 实现见 protocol/lookup.ts;
   * keyForName 与摘要函数的真源留在 catalog-protocol.ts.
   * @param {string} modelId legacy 模型 id
   * @param {string|null} [displayName] 静态快照里的可读名
   * @returns {string} 句柄; 都命中不了则原样返回 modelId
   */
  handleForModel(modelId: any, displayName = null) {
    return protoHandleForModelWith(
      this, modelId, displayName,
      (name) => this.keyOf(name),
      this.digestOf,
    )
  }

  /**
   * 是否已在本次目录里(有对应行).
   * @param {string} modelId 模型标识
   * @returns {boolean} 命中为真
   */
  hasModel(modelId: any) {
    return this.handleFor(modelId) !== modelId
  }

  /**
   * 目录行全量(模型清单的权威), 按 sortOrder 升序(与官方菜单一致).
   * 实现见 protocol/views.ts.
   * @returns {any[]} 目录行(已排序)
   */
  rows() {
    return protoRows(this.rowByKey)
  }

  /**
   * 单个目录行(原文). 查不到返回 null.
   * @param {string} key 目录 key
   * @returns {any|null} 目录行
   */
  row(key: any) {
    return protoRow(this.rowByKey, key)
  }

  /**
   * 目录相关的两个头(未持有时返回空对象, 让调用方走 legacy).
   * @returns {Record<string, string>} 头集
   */
  headers() {
    return protoHeaders(this.ready ? this.fetchId : null)
  }

  /**
   * 只给 x-freebuff-catalog-fetch, 不给 -protocol. 官方 chat 头部恒为 8 项,
   * 没有 catalog-protocol -- 它只出现在 catalog 与 admission 上.
   * 见 docs/reverse/15-protocol-review.md P0-1 与
   * .agents/notes/implemented/bug-fix/2026-10-03-chat-catalog-fetch-only.md.
   * @returns {Record<string, string>} 头集
   */
  fetchOnlyHeaders() {
    return protoFetchOnlyHeaders(this.ready ? this.fetchId : null)
  }

  /**
   * 抓一次目录. best-effort: 失败返回 false 并退避, 绝不抛.
   * @param {{ force?: boolean }} [opts] force 为真时忽略缓存与退避
   * @returns {Promise<boolean>} 是否抓到
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
}
