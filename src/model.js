/**
 * Freebuff free-model catalog and model id helpers.
 *
 * Wire ids match Freebuff/Codebuff clients (no local aliases).
 * Catalog sourced from freebuff common/src/constants/freebuff-models.ts
 * FREEBUFF_MODELS + commonly reachable extras (GLM referral, etc.).
 */

/**
 * @typedef {object} FreebuffModelInfo
 * @property {string} id
 * @property {string} displayName
 * @property {'premium' | 'unlimited' | 'referral' | 'limited_offer' | 'helper'} pool
 * @property {boolean} multimodal
 * @property {('full' | 'limited')[]} accessTiers  which Freebuff access tiers can pick it in the regular catalog
 * @property {string} [note]
 */

/** Regular Freebuff picker models + documented extras Agents may request. */
export const FREEBUFF_AVAILABLE_MODELS = /** @type {const} */ ([
  {
    id: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash 07/31',
    pool: 'unlimited',
    multimodal: false,
    accessTiers: ['full', 'limited'],
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    pool: 'premium',
    multimodal: false,
    accessTiers: ['full'],
  },
  {
    id: 'openai/gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    pool: 'premium',
    multimodal: true,
    accessTiers: ['full'],
  },
  {
    id: 'minimax/minimax-m3',
    displayName: 'MiniMax M3',
    pool: 'premium',
    multimodal: true,
    accessTiers: ['full'],
  },
  {
    id: 'mimo/mimo-v2.5',
    displayName: 'MiMo 2.5',
    pool: 'unlimited',
    multimodal: true,
    accessTiers: ['full', 'limited'],
  },
  {
    id: 'z-ai/glm-5.2',
    displayName: 'GLM 5.2',
    pool: 'referral',
    multimodal: false,
    accessTiers: ['full'],
    note: 'Unlocked via referral/streak entitlement, not always joinable',
  },
  {
    id: 'anthropic/claude-fable-5',
    displayName: 'Claude Fable 5',
    pool: 'limited_offer',
    multimodal: false,
    accessTiers: ['full'],
    note: 'Capacity-limited offer; only when server advertises it',
  },
])

/**
 * 该模型是否属于"不限量"池（如 deepseek-v4-flash / mimo-v2.5）。
 * 上游对这类模型不应计入每日 session 限额（rateLimitsByModel），
 * 代理的配额感知切换/展示应对其豁免，避免误把不限量模型当限额模型来回切号。
 * @param {string} modelId
 * @returns {boolean}
 */
export function isUnlimitedModel(modelId) {
  const m = FREEBUFF_AVAILABLE_MODELS.find((x) => x.id === modelId)
  return Boolean(m && m.pool === 'unlimited')
}

/**
 * Normalize client model field. No alias mapping — pass through as provided.
 * @param {unknown} requested
 * @returns {string | null}
 */
export function requireModelId(requested) {
  if (requested == null) return null
  const raw = String(requested).trim()
  return raw.length > 0 ? raw : null
}

/**
 * Build OpenAI-compatible /v1/models payload.
 *
 * @param {{
 *   accessTier?: 'full' | 'limited' | null,
 *   includeAllCatalog?: boolean,
 *   extraIds?: string[],
 * }} [opts]
 */
export function buildModelsListResponse(opts = {}) {
  const accessTier = opts.accessTier ?? null
  const includeAllCatalog = opts.includeAllCatalog !== false

  /** @type {Map<string, object>} */
  const byId = new Map()

  if (includeAllCatalog) {
    for (const m of FREEBUFF_AVAILABLE_MODELS) {
      // When we know the live tier is limited, still list full-only models but
      // mark them unavailable so Agents see the full Freebuff surface.
      const tierOk =
        !accessTier || m.accessTiers.includes(accessTier)
      byId.set(m.id, toOpenAiModel(m, { available: tierOk, accessTier }))
    }
  }

  for (const id of opts.extraIds || []) {
    if (!id || byId.has(id)) continue
    byId.set(id, {
      id,
      object: 'model',
      created: 0,
      owned_by: 'freebuff',
      available: true,
      source: 'session',
    })
  }

  return {
    object: 'list',
    data: [...byId.values()],
  }
}

/**
 * @param {FreebuffModelInfo} m
 * @param {{ available: boolean, accessTier?: string | null }} meta
 */
function toOpenAiModel(m, meta) {
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
 * Collect extra model ids advertised on a freebuff session payload
 * (rate limits, limited offers).
 * @param {any} session
 * @returns {string[]}
 */
export function modelIdsFromSession(session) {
  if (!session || typeof session !== 'object') return []
  const ids = new Set()
  if (typeof session.model === 'string') ids.add(session.model)
  const limits = session.rateLimitsByModel
  if (limits && typeof limits === 'object') {
    for (const id of Object.keys(limits)) ids.add(id)
  }
  const offers = session.limitedModelOffers
  if (Array.isArray(offers)) {
    for (const o of offers) {
      if (o && typeof o.model === 'string') ids.add(o.model)
    }
  }
  return [...ids]
}


/** Freebuff free-mode root agent id for a model (server run registry). */
const ROOT_AGENT_BY_MODEL = {
  'deepseek/deepseek-v4-flash': 'base2-free-deepseek-flash',
  'deepseek/deepseek-v4-pro': 'base2-free-deepseek',
  'openai/gpt-5.6-luna': 'base2-free-luna',
  'minimax/minimax-m3': 'base2-free-minimax-m3',
  'mimo/mimo-v2.5': 'base2-free-mimo',
  'z-ai/glm-5.2': 'base2-free-glm',
  'anthropic/claude-fable-5': 'base2-free-fable',
}

/**
 * @param {string} modelId
 * @returns {string}
 */
export function agentIdForModel(modelId) {
  return ROOT_AGENT_BY_MODEL[modelId] || 'base2-free'
}
