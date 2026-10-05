/**
 * /v1/models 行的构造 ---- 从 src/model/list-response.ts 按职责切出.
 *
 * 为什么单独成文件: 全文件只有这三段是"一行长什么样"(字段名与来源域),
 * 而 modelIdsFromSession 与 isModelAllowed 是"哪些 id 算数"的判据. 两者
 * 各自被不同调用点使用(白名单校验只用 isModelAllowed, 清单构建只用这两段),
 * 拆开后前者不再需要读后者的 200 行语义.
 *
 * 口径: 纯搬移, 行为零改动.
 */
import { isPremiumModel } from '../flags.ts'
import { FREEBUFF_AVAILABLE_MODELS } from './catalog-response.ts'

/** 是否跳过某个模型 id 的判定函数. */
type SkipFn = (id: string) => boolean

/**
 * 单个模型 -> OpenAI 兼容模型对象.
 * @param {any} m 模型信息(catalog / 自定义来源)
 * @param {{ available: boolean, accessTier?: string | null }} meta 可用性元信息
 * @returns {Record<string, any>} OpenAI 兼容模型对象
 */
export function toOpenAiModel(m: any, meta: { available: boolean, accessTier?: string | null }): Record<string, any> {
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
export function addCatalogEntries(byId: Map<string, any>, skip: SkipFn, accessTier: string | null): void {
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
export function addCustomEntries(
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
export function addSessionEntries(
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
 * 该 id 是否应收敛进清单(hidden 或 premium 屏蔽).
 * @param {Record<string, any>} opts 清单构建选项(hiddenModels / blockPremium)
 * @returns {SkipFn} 判据函数:true = 该 id 不进清单
 */
export function skipFnOf(opts: Record<string, any>): SkipFn {
  const blockPremium = opts.blockPremium === true
  const hidden = new Set(opts.hiddenModels || [])
  return (id: string) => hidden.has(id) || (blockPremium && isPremiumModel(id))
}
