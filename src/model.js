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
 * @property {'premium' | 'daily' | 'referral' | 'limited_offer' | 'helper'} pool
 * @property {boolean} multimodal
 * @property {('full' | 'limited')[]} accessTiers  which Freebuff access tiers can pick it in the regular catalog
 * @property {string} [note]
 */

/** Regular Freebuff picker models + documented extras Agents may request. */
export const FREEBUFF_AVAILABLE_MODELS = /** @type {const} */ ([
  {
    id: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash 07/31',
    pool: 'daily',
    multimodal: false,
    accessTiers: ['full', 'limited'],
    note: 'Daily quota follows the live Freebuff rateLimitsByModel response',
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
    id: 'crof/kimi-k3-eco',
    displayName: 'Kimi K3',
    pool: 'premium',
    multimodal: false,
    accessTiers: ['full'],
    note: 'Experimental/god-only route; admission follows the upstream entitlement',
  },
  {
    id: 'openai/gpt-5.6-luna-es',
    displayName: 'GPT-5.6 Luna ES',
    pool: 'premium',
    multimodal: false,
    accessTiers: ['full'],
    note: 'God-only evaluation route; admission follows the upstream entitlement',
  },
  {
    id: 'meta/muse-spark-1.2-contributor',
    displayName: 'Muse Spark 1.2 Contributor',
    pool: 'premium',
    multimodal: false,
    accessTiers: ['full'],
    note: 'Web-only Contributor route; admission follows the upstream entitlement and queue',
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
    pool: 'daily',
    multimodal: true,
    accessTiers: ['full', 'limited'],
    note: 'Daily quota follows the live Freebuff rateLimitsByModel response',
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
 * 模型是否走"免费额度"计费（影响调度策略）：
 * - 免费模型（pool 非 premium：daily / referral / limited_offer / helper）：
 *   额度按次/按小时免费结算，可暴力分散到多账号、会话临近过期（<5 分钟）即提前
 *   re-admit 换新会话——避免请求发到马上过期的会话上中途被掐断/白占额度。
 * - 付费模型（pool=premium，如 deepseek-v4-pro / gpt-5.6-luna / minimax-m3）：
 *   每次 admit 都会新建计费会话 → 调度必须热 session 复用（不分散、不浪费），
 *   会话用到接近过期再切换。
 * 未知模型按免费处理（保守：不阻塞可用性）。
 * @param {string} modelId
 * @returns {boolean}
 */
export function isFreeModel(modelId) {
  const m = FREEBUFF_AVAILABLE_MODELS.find((x) => x.id === modelId)
  return !m || m.pool !== 'premium'
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
  'crof/kimi-k3-eco': 'base2-free-kimi-k3-eco',
  'openai/gpt-5.6-luna-es': 'base2-free-luna-es',
  'meta/muse-spark-1.2-contributor': 'base2-free-muse-spark',
  'minimax/minimax-m3': 'base2-free-minimax-m3',
  'mimo/mimo-v2.5': 'base2-free-mimo',
  'z-ai/glm-5.2': 'base2-free-glm',
  'anthropic/claude-fable-5': 'base2-free-fable',
}

/**
 * base3 单循环 harness 孪生 agent（freebuff free-agents.ts：
 * FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL）。主 agent 因
 * free_mode_invalid_agent_model 被拒时回退到这里（上游按用途/推理任务可能
 * 路由到不同 agent，有些带单次 output 限制会截断长思考链——换 agent 兜底）。
 */
const BASE3_AGENT_BY_MODEL = {
  'deepseek/deepseek-v4-flash': 'base3-free-deepseek-flash',
  'deepseek/deepseek-v4-pro': 'base3-free-deepseek',
  'openai/gpt-5.6-luna': 'base3-free-luna',
  'crof/kimi-k3-eco': 'base3-free-kimi-k3-eco',
  'openai/gpt-5.6-luna-es': 'base3-free-luna-es',
  'meta/muse-spark-1.2-contributor': 'base3-free-muse-spark',
  'minimax/minimax-m3': 'base3-free-minimax-m3',
  'mimo/mimo-v2.5': 'base3-free-mimo',
  'z-ai/glm-5.2': 'base3-free-glm',
  'anthropic/claude-fable-5': 'base3-free-fable',
}

/**
 * @param {string} modelId
 * @returns {string}
 */
export function agentIdForModel(modelId) {
  return ROOT_AGENT_BY_MODEL[modelId] || 'base2-free'
}

/**
 * 主 agent 不可用时的兜底 agent（base3 孪生；无孪生则回退通用 base2-free）。
 * @param {string} modelId
 * @returns {string}
 */
export function agentFallbackForModel(modelId) {
  return BASE3_AGENT_BY_MODEL[modelId] || 'base2-free'
}
