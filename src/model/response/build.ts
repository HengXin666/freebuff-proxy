/**
 * /v1/models 清单构建.
 *
 * 只做"遍历三张来源表 -> 按 id 收敛 -> 输出清单", 与 isModelAllowed 无共享状态.
 * 依赖方向: rows -> catalog-response 单向无环.
 */
import { addCatalogEntries, addCustomEntries, addSessionEntries, skipFnOf } from './rows.ts'

export { isFreeModel, isPremiumModel } from '../flags.ts'
export { FREEBUFF_AVAILABLE_MODELS, freebuffAvailableModels } from './catalog-response.ts'

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
  const skip = skipFnOf(opts)
  /** @type {Map<string, object>} */
  const byId = new Map()
  if (opts.includeAllCatalog !== false) addCatalogEntries(byId, skip, accessTier)
  addCustomEntries(byId, opts.customModels || [], skip, accessTier)
  addSessionEntries(byId, opts.extraIds || [], skip, accessTier)
  return { object: 'list', data: [...byId.values()] }
}
