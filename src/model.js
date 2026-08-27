/**
 * Freebuff free-model catalog and model id helpers — DATA-DRIVEN.
 *
 * 三层模型元信息（优先级从高到低）：
 *   1. 前端自定义模型（ModelStore，data/custom-models.json）——操作者手动覆盖/新增
 *   2. 内置 catalog（src/catalog/freebuff-catalog.json）——从 Codebuff 源码
 *      common/src/constants/free-agents.ts + freebuff-models.ts 提取，
 *      可用 scripts/sync-catalog.mjs 一键重新同步（上游加新模型不再需要改代码）
 *   3. 命名规则推导——未知模型按 `base2-free-<slug>` 推导 agent（兜底）
 *
 * Wire ids match Freebuff/Codebuff clients (no local aliases).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CATALOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'catalog',
  'freebuff-catalog.json',
)

/** 读取内置 catalog（解析失败时回退空列表，不阻塞启动）。 */
function loadCatalog() {
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))
    return Array.isArray(raw?.models) ? raw.models : []
  } catch (err) {
    console.warn(
      `[model] failed to load catalog ${CATALOG_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
}

/**
 * @typedef {object} FreebuffModelInfo
 * @property {string} id
 * @property {string} displayName
 * @property {'premium' | 'daily' | 'referral' | 'limited_offer' | 'helper'} pool
 * @property {boolean} multimodal
 * @property {('full' | 'limited')[]} accessTiers  which Freebuff access tiers can pick it in the regular catalog
 * @property {string} [note]
 */

/** @type {FreebuffModelInfo[]} catalog 里的模型（含已暂停/退役的，保留 id 可识别） */
const CATALOG_MODELS = /** @type {any} */ (loadCatalog())

/** 内置 catalog 的 model → agent 映射（base2 主 agent / base3 孪生）。 */
const CATALOG_AGENT_BY_MODEL = new Map()
const CATALOG_FALLBACK_BY_MODEL = new Map()
for (const m of CATALOG_MODELS) {
  if (typeof m?.id !== 'string' || !m.id) continue
  if (typeof m.agentId === 'string' && m.agentId) {
    CATALOG_AGENT_BY_MODEL.set(m.id, m.agentId)
  }
  if (typeof m.fallbackAgentId === 'string' && m.fallbackAgentId) {
    CATALOG_FALLBACK_BY_MODEL.set(m.id, m.fallbackAgentId)
  }
}

/** Regular Freebuff picker models + documented extras Agents may request. */
export const FREEBUFF_AVAILABLE_MODELS = /** @type {FreebuffModelInfo[]} */ (
  CATALOG_MODELS.map((m) => ({
    id: m.id,
    displayName: m.displayName || m.id,
    pool: m.pool || 'daily',
    multimodal: m.multimodal === true,
    accessTiers: m.accessTiers || ['full'],
    ...(m.note ? { note: m.note } : {}),
  }))
)

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
 * 从模型 id 推导 Freebuff root agent id（兜底规则）。
 *
 * Codebuff 的 root agent 命名规律是 `base2-free-<slug>`，但 slug 不是简单
 * 从模型 id 映射（如 `z-ai/glm-5.3-flash` → `glm-5-3-flash`：点变横线；
 * `openai/gpt-5.6-luna` → `luna`：整个名字是特例）。所以这里只做
 * 通用 slug 化，已知表（catalog / 自定义）永远优先于推导。
 *
 * @param {string} modelId
 * @returns {string | null} 推导出的 agent id；无法推导返回 null
 */
export function deriveAgentId(modelId) {
  if (!modelId || typeof modelId !== 'string') return null
  const slug = modelId
    .split('/')
    .pop() // 去掉 provider 前缀
    .replace(/\./g, '-') // 5.3 → 5-3
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase()
  if (!slug) return null
  return `base2-free-${slug}`
}

/**
 * 模型是否走"免费额度"计费（影响调度策略）：
 * - 免费模型（pool 非 premium：daily / referral / limited_offer / helper）：
 *   额度按次/按小时免费结算，可暴力分散到多账号、会话临近过期（<5 分钟）即提前
 *   re-admit 换新会话——避免请求发到马上过期的会话上中途被掐断/白占额度。
 * - 付费模型（pool=premium，如 gpt-5.6-luna / minimax-m3）：
 *   每次 admit 都会新建计费会话 → 调度必须热 session 复用（不分散、不浪费），
 *   会话用到接近过期再切换。
 * 未知模型按免费处理（保守：不阻塞可用性）。
 * 自定义模型（前端配置）优先于内置 catalog——操作者可把某个 id 的 pool 改成
 * premium 让它走热 session 复用调度。
 * @param {string} modelId
 * @param {{ id: string, pool?: string }[]} [customModels] 前端配置的自定义模型列表
 * @returns {boolean}
 */
export function isFreeModel(modelId, customModels) {
  const cm = (customModels || []).find((x) => x && x.id === modelId)
  if (cm) return (cm.pool || 'daily') !== 'premium'
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
 *   customModels?: { id: string, displayName?: string, pool?: string, multimodal?: boolean, agentId?: string, note?: string }[],
 * }} [opts]
 */
export function buildModelsListResponse(opts = {}) {
  const accessTier = opts.accessTier ?? null
  const includeAllCatalog = opts.includeAllCatalog !== false
  // 用户在前端「模型管理」删除（隐藏）的模型 id：从列表里彻底移除
  const hidden = new Set(opts.hiddenModels || [])
  const skip = (id) => hidden.has(id)

  /** @type {Map<string, object>} */
  const byId = new Map()

  if (includeAllCatalog) {
    for (const m of FREEBUFF_AVAILABLE_MODELS) {
      if (skip(m.id)) continue
      // When we know the live tier is limited, still list full-only models but
      // mark them unavailable so Agents see the full Freebuff surface.
      const tierOk =
        !accessTier || m.accessTiers.includes(accessTier)
      byId.set(m.id, toOpenAiModel(m, { available: tierOk, accessTier }))
    }
  }

  // Custom models from the frontend-managed store override static catalog
  // entries with the same id (so operators can fix wrong display names / pools)
  // and add brand-new ids the proxy doesn't ship with.
  for (const cm of opts.customModels || []) {
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

  for (const id of opts.extraIds || []) {
    if (!id || byId.has(id)) continue
    if (skip(id)) continue
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

/**
 * 解析前端自定义模型列表为查询 Map（id → record）。
 * @param {{ id: string, pool?: string, agentId?: string, fallbackAgentId?: string }[]} [customModels]
 * @returns {Map<string, { pool?: string, agentId?: string, fallbackAgentId?: string }>}
 */
function customModelIndex(customModels) {
  const index = new Map()
  for (const cm of customModels || []) {
    if (!cm || typeof cm.id !== 'string' || !cm.id) continue
    index.set(cm.id, cm)
  }
  return index
}

/**
 * Freebuff free-mode root agent id for a model (server run registry)。
 * 解析顺序：前端自定义 agentId > 内置 catalog > 命名规则推导 > 通用 base2-free。
 * @param {string} modelId
 * @param {{ id: string, agentId?: string }[]} [customModels] 前端配置的自定义模型（可覆盖 agentId）
 * @returns {string}
 */
export function agentIdForModel(modelId, customModels) {
  const cm = customModelIndex(customModels).get(modelId)
  if (cm?.agentId) return cm.agentId
  const known = CATALOG_AGENT_BY_MODEL.get(modelId)
  if (known) return known
  const derived = deriveAgentId(modelId)
  if (derived) return derived
  return 'base2-free'
}

/**
 * 主 agent 不可用时的兜底 agent（base3 孪生；无孪生则回退通用 base2-free）。
 * 解析顺序：前端自定义 fallbackAgentId > 内置 catalog > 通用 base2-free。
 * 注意：不搞"推导 base3"——catalog 里没有 base3 孪生的模型（如 -max 系列）
 * 推导出的 base3-free-* 很可能不存在，回退 base2-free 反而更稳。
 * @param {string} modelId
 * @param {{ id: string, fallbackAgentId?: string }[]} [customModels]
 * @returns {string}
 */
export function agentFallbackForModel(modelId, customModels) {
  const cm = customModelIndex(customModels).get(modelId)
  if (cm?.fallbackAgentId) return cm.fallbackAgentId
  const known = CATALOG_FALLBACK_BY_MODEL.get(modelId)
  if (known) return known
  return 'base2-free'
}
