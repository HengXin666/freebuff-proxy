/**
 * /v1/models 清单构建与模型可见性判定.
 *
 * 依赖方向:list-response -> {catalog-store, agents, flags},单向无环.
 *
 * 从 src/model.js 拆出(原 758 行单文件).
 */
import { catalogModels } from './catalog-store.ts'
import { isPremiumModel } from './flags.ts'

export { isFreeModel, isPremiumModel } from './flags.ts'

/**
 * @typedef {import('./agents.ts').FreebuffModelInfo} FreebuffModelInfo
 */

/** 是否跳过某个模型 id 的判定函数. */
type SkipFn = (id: string) => boolean

/**
 * 目录模型 -> 对外模型信息行.
 * Regular Freebuff picker models + documented extras Agents may request.
 *
 * @returns {FreebuffModelInfo[]} 对外模型信息
 */
export function freebuffAvailableModels() {
  return /** @type {FreebuffModelInfo[]} */ (
    catalogModels().map((m) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      pool: m.pool || 'daily',
      multimodal: m.multimodal === true,
      accessTiers: m.accessTiers || ['full'],
      ...(m.note ? { note: m.note } : {}),
    }))
  )
}

/**
 * @deprecated 用 freebuffAvailableModels()(惰性).保留为惰性 Proxy 以兼容
 * 既有 import 的调用点,不会在模块顶层读盘.
 */
export const FREEBUFF_AVAILABLE_MODELS: any[] = new Proxy([] as any[], {
  get(_t, prop) {
    const list = freebuffAvailableModels()
    const v = Reflect.get(list, prop)
    return typeof v === 'function' ? v.bind(list) : v
  },
  has(_t, prop) {
    return Reflect.has(freebuffAvailableModels(), prop)
  },
  ownKeys() {
    return Reflect.ownKeys(freebuffAvailableModels())
  },
  getOwnPropertyDescriptor(_t, prop) {
    return Reflect.getOwnPropertyDescriptor(freebuffAvailableModels(), prop)
  },
})

/**
 * @param {FreebuffModelInfo} m 模型信息
 * @param {{ available: boolean, accessTier?: string | null }} meta 可用性元信息
 * @returns {object} OpenAI 兼容模型对象
 */
function toOpenAiModel(m: any, meta: { available: boolean, accessTier?: string | null }): Record<string, any> {
  return {
    id: m.id,
    object: 'model',
    created: 0,
    owned_by: 'freebuff',
    // Non-standard but useful for Agents / operators
    display_name: m.displayName,
    pool: m.pool,
    multimodal: m.multimodal,
    access_tiers: m.accessTiers,
    available: meta.available,
    ...(m.note ? { note: m.note } : {}),
    ...(meta.accessTier ? { current_access_tier: meta.accessTier } : {}),
  }
}

/**
 * 收集会话回执里额外出现的模型 id(rateLimitsByModel / limitedModelOffers /
 * 当前 model).
 *
 * @param {any} session 会话回执
 * @returns {string[]} 额外模型 id
 */
export function modelIdsFromSession(session?: any): string[] {
  if (!session || typeof session !== 'object') return []
  const ids = new Set<string>()
  if (typeof session.model === 'string') ids.add(session.model)
  const limits = session.rateLimitsByModel
  if (limits && typeof limits === 'object') {
    for (const id of Object.keys(limits)) ids.add(id)
  }
  const offers = session.limitedModelOffers
  if (Array.isArray(offers)) {
    for (const o of offers) {
      if (o && typeof o.model === 'string') ids.add(o.model as string)
    }
  }
  return [...ids]
}

/**
 * Build OpenAI-compatible /v1/models payload.
 *
 * @param {{
 * accessTier?: 'full' | 'limited' | null,
 * includeAllCatalog?: boolean,
 * extraIds?: (string | { key: string, displayName?: string | null, catalogId?: string | null })[],
 * customModels?: { id: string, displayName?: string, pool?: string,
 *   multimodal?: boolean, agentId?: string, note?: string }[],
 * blockPremium?: boolean,
 * hiddenModels?: string[],
 * }} [opts] 构建选项
 * @returns {{ object: string, data: object[] }} OpenAI 兼容清单
 */
export function buildModelsListResponse(opts: Record<string, any> = {}): { object: string, data: any[] } {
  const accessTier = opts.accessTier ?? null
  // 一键屏蔽收费模型(pool=premium)时,从列表彻底移除 -- 用户用不了,占位还误触风控.
  const blockPremium = opts.blockPremium === true
  // 用户在前端[模型管理]删除(隐藏)的模型 id:从列表里彻底移除
  const hidden = new Set(opts.hiddenModels || [])
  const skip = (id: string) => hidden.has(id) || (blockPremium && isPremiumModel(id))
  /** @type {Map<string, object>} */
  const byId = new Map()
  if (opts.includeAllCatalog !== false) addCatalogEntries(byId, skip, accessTier)
  addCustomEntries(byId, opts.customModels || [], skip, accessTier)
  addSessionEntries(byId, opts.extraIds || [], skip, accessTier)
  return { object: 'list', data: [...byId.values()] }
}

/**
 * 铺内置 catalog 条目.
 *
 * available 的含义只是"现在能不能直接发请求",不是"这个模型存不存在".
 *
 * 2026-09-15 修:以前这里用 accessTiers.includes(accessTier) 判定,而内置
 * catalog 的 15 条全都没有 accessTiers 字段 -> 一律回落成默认 ['full'] ->
 * 只要上游回一次 accessTier: limited,整个内置目录就被染成 available: false.
 * 下游把 /v1/models 当权威模型表的客户端 + 控制台测试对话(原本只留
 * available !== false)于是只看到剩余的一个(extraIds 里上游给过额度的那个
 * 模型) -- 用户反馈的"只有一个模型"就是这个.
 *
 * 目录准入不等于实时配额:真正拦人的是价格/额度(freebucks 闸门)与 agent
 * 可用性,不是这个静态标记.所以目录条目一律 available: true,tier 信息只作为
 * 元数据透出,由调用方自己决定怎么展示.
 *
 * @param {Map<string, object>} byId 结果表(就地写)
 * @param {(id: string) => boolean} skip 是否跳过该 id
 * @param {string | null} accessTier 当前档位
 * @returns {void}
 */
function addCatalogEntries(byId: Map<string, any>, skip: SkipFn, accessTier: string | null): void {
  for (const m of FREEBUFF_AVAILABLE_MODELS) {
    if (skip(m.id)) continue
    byId.set(m.id, toOpenAiModel(m, { available: true, accessTier }))
  }
}

/**
 * 铺前端自定义模型条目(same-id 覆盖静态 catalog,并允许新增 id).
 *
 * @param {Map<string, object>} byId 结果表(就地写)
 * @param {any[]} customModels 自定义模型
 * @param {(id: string) => boolean} skip 是否跳过该 id
 * @param {string | null} accessTier 当前档位
 * @returns {void}
 */
function addCustomEntries(
  byId: Map<string, any>,
  customModels: any[],
  skip: SkipFn,
  accessTier: string | null,
): void {
  // Custom models from the frontend-managed store override static catalog
  // entries with the same id (so operators can fix wrong display names / pools)
  // and add brand-new ids the proxy doesn't ship with.
  for (const cm of customModels) {
    if (!cm || typeof cm.id !== 'string' || !cm.id) continue
    if (skip(cm.id)) continue
    byId.set(cm.id, {
      id: cm.id,
      object: 'model',
      created: 0,
      owned_by: 'freebuff',
      display_name: cm.displayName || cm.id,
      pool: cm.pool || 'daily',
      multimodal: cm.multimodal === true,
      available: true,
      source: 'custom',
      ...(cm.note ? { note: cm.note } : {}),
      ...(accessTier ? { current_access_tier: accessTier } : {}),
    })
  }
}

/**
 * 铺上游会话回执里才出现的模型(rateLimitsByModel / limitedModelOffers /
 * 当前 model),内置 catalog 未必收录.
 *
 * 这里的 id 不能直接是目录 key(m-00032eaeec):下游 Agent 拿 /v1/models
 * 当模型表,看到的就是这串不透明标识 -- 用户明确要求"返回的应该是模型名称,
 * 而不是 ID".所以按下列优先级取可读口径:
 *
 * 1. catalogId(deepseek/deepseek-v4-flash) -- 上游与生态通用写法,
 *    调度侧 isModelAllowed / handleFor 都能直接认;
 * 2. displayName(Solar Pro 4) -- 内置 catalog 尚未收录的上游新模型
 *    只有服务端给的名字可取,chat 入口会把它解析回 key(见 proxy.js);
 * 3. 兜底才是原 key(连名字都没有时,至少不丢模型).
 *
 * 若 catalogId 指向的条目已经在列表里,说明它与内置/自定义条目是同一个模型,
 * 不再重复添加(用户看到的列表里就此不再有裸 key 条目).原始 key 作为
 * freebuff_key 透出,调试/高级客户端仍能拿到服务端真值.
 *
 * @param {Map<string, object>} byId 结果表(就地写)
 * @param {any[]} extraIds 会话回执里的额外模型
 * @param {(id: string) => boolean} skip 是否跳过该 id
 * @param {string | null} accessTier 当前档位
 * @returns {void}
 */
function addSessionEntries(
  byId: Map<string, any>,
  extraIds: any[],
  skip: SkipFn,
  accessTier: string | null,
): void {
  for (const entry of extraIds) {
    const e = typeof entry === 'string' ? { key: entry } : entry || {}
    const key = typeof e.key === 'string' ? e.key : ''
    if (!key) continue
    if (skip(key)) continue
    const readable = typeof e.catalogId === 'string' && e.catalogId ? e.catalogId : null
    const named =
      typeof e.displayName === 'string' && e.displayName.trim() ? e.displayName.trim() : null
    const id = readable || named || key
    if (byId.has(id)) continue
    if (skip(id)) continue
    byId.set(id, {
      id,
      object: 'model',
      created: 0,
      owned_by: 'freebuff',
      display_name: named || id,
      available: true,
      source: 'session',
      ...(id !== key ? { freebuff_key: key } : {}),
      ...(accessTier ? { current_access_tier: accessTier } : {}),
    })
  }
}

/**
 * 模型是否在代理"可调度"白名单内(未隐藏 + 已知模型/自定义/上游会话出现过).
 *
 * 用于 /v1/chat/completions 的 model 字段校验:任何不在白名单的模型 id
 * 一律 400 拒绝,绝不盲发上游 -- 避免把"APP 里没有的模型"探测请求打到
 * Freebuff(上游会把这些当异常行为标记账号,这正是免费反代被封号的主要诱因).
 *
 * 白名单 = 内置 catalog(未隐藏) + 自定义模型(未隐藏) + 上游会话实际出现过的
 * id + 顶层 model 字段(session 当前模型) + 目录行(模型清单的权威).
 *
 * @param {string} modelId 模型 id
 * @param {{
 * customModels?: { id: string }[],
 * hiddenModels?: string[],
 * sessionModelIds?: string[],
 * sessionModel?: string | null,
 * blockPremium?: boolean,
 * catalogKeys?: string[],
 * }} [opts] 判定选项
 * @returns {boolean} true 表示允许调度
 */
export function isModelAllowed(modelId: string, opts: Record<string, any> = {}): boolean {
  if (!modelId || typeof modelId !== 'string') return false
  const hidden = new Set(opts.hiddenModels || [])
  if (hidden.has(modelId)) return false
  // 一键屏蔽收费模型:premium 模型直接拒用(不盲发上游,避免风控).
  if (opts.blockPremium && isPremiumModel(modelId)) return false

  // 1) 内置 catalog(未隐藏) -- 含 WITHDRAWN 标记的退役模型也放行:
  //    退役标记只是提示,直接拒绝会误伤仍在用旧对话/存量 session 的用户;
  //    上游会话探测若确认没有,会走第 3 层兜底拒绝.
  if ((catalogModels() as any[]).some((m: any) => m.id === modelId)) return true
  // 2) 前端自定义(未隐藏)
  if ((opts.customModels || []).some((m: any) => m && m.id === modelId)) return true
  // 3) 上游会话实际出现过(rateLimitsByModel / limitedModelOffers / 当前 model)
  const seen = new Set(opts.sessionModelIds || [])
  if (opts.sessionModel) seen.add(opts.sessionModel)
  if (seen.has(modelId)) return true
  /**
   * 4) 目录行(模型清单的权威).
   *
   * 顺序必须在这里:目录有 13 行,而 rateLimits(第 3 层)只有 6 个键.
   * 少了这一层,目录里的模型(尤其当日额度为 0 或没被授予额度的)会被
   * model_not_allowed 拒掉 -- 正是"远程请求模型返回没有任何可用模型".
   *
   * 匹配两个口径:key(m-096e75164d,resolveModelAlias 归一后的形态)与
   * displayName(可读名,前端同步后写进自定义的那种).
   */
  const keys = opts.catalogKeys
  if (keys) {
    for (const k of keys) {
      if (k === modelId) return true
    }
  }
  return false
}
