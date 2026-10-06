/**
 * agent 推导与模型标识助手(纯函数 + agent 索引).
 *
 * 依赖方向:本文件只依赖 catalog-store,不反向依赖对外清单/过滤器,
 * 避免 available <-> agents 的循环 import.
 */
import { catalogModels } from './catalog-store.ts'
export { isFreeModel, isPremiumModel } from './flags.ts'

/**
 * @typedef {object} FreebuffModelInfo
 * @property {string} id
 * @property {string} displayName
 * @property {'premium' | 'daily' | 'referral' | 'limited_offer' | 'helper'} pool
 * @property {boolean} multimodal
 * @property {('full' | 'limited')[]} accessTiers  which Freebuff access tiers can pick it in the regular catalog
 * @property {string} [note]
 */

/**
 * 目录协议下的统一 agent id.
 *
 * 官方在 catalog 模式下不再按模型选 agent -- 所有目录模型共用一个 root agent.
 * 二进制原文:
 *   UK = "base3-free-catalog"
 *   Ps$(H){ return WD().row(H)?.key === H ? UK : cCH(H) }
 * 即:会话模型是目录 key 时返回 UK,其余走 cCH(按 base2/base3 推导).
 *
 * 官方 chat 走目录协议时, agent-run 的 START 为
 * {"action":"START","agentId":"base3-free-catalog","ancestorRunIds":[]}.
 *
 * 见 .agents/notes/implemented/bug-fix/2026-10-01-catalog-agent.md
 */
/**
 * 前端可覆盖的模型条目(只取本文件用到的字段).
 */
export interface CustomModel {
  id: string
  pool?: string
  agentId?: string
  fallbackAgentId?: string
}

/** 单条模型解析出的 agent 元信息. */
export interface AgentMeta {
  agentId: string
  fallbackAgentId: string
}

export const CATALOG_UNIFIED_AGENT_ID = 'base3-free-catalog'

/** 内置 catalog 的 model -> agent 映射(base2 主 agent / base3 孪生). */
const CATALOG_AGENT_BY_MODEL = new Map()
const CATALOG_FALLBACK_BY_MODEL = new Map()

/** agent 索引是否已建(惰性:首次用到才遍历 catalog). */
let agentIndexBuilt = false

/** 建 agent 索引(惰性). */
export function ensureAgentIndex(): void {
  if (agentIndexBuilt) return
  agentIndexBuilt = true
  for (const m of catalogModels()) {
    if (typeof m?.id !== 'string' || !m.id) continue
    if (typeof m.agentId === 'string' && m.agentId) {
      CATALOG_AGENT_BY_MODEL.set(m.id, m.agentId)
    }
    if (typeof m.fallbackAgentId === 'string' && m.fallbackAgentId) {
      CATALOG_FALLBACK_BY_MODEL.set(m.id, m.fallbackAgentId)
    }
  }
}

/**
 * Normalize client model field. No alias mapping -- pass through as provided.
 *
 * @param {unknown} requested 客户端给的 model 字段
 * @returns {string | null} 归一后的 id;空值返回 null
 */
export function requireModelId(requested: unknown): string | null {
  if (requested == null) return null
  const raw = String(requested).trim()
  return raw.length > 0 ? raw : null
}

/**
 * 模型名称的单一真源:目录行 -> 对外的可读名.
 *
 * 三层链路的边界定义:
 *
 * 1. 对外(/v1/models,控制台):只出现模型名称("DeepSeek V4.1 Flash"),
 *    不出现上游的不透明 id(m-096e75164d).
 * 2. 内部:把名称映射成目录 id(m-xxx)后使用 -- 调度,额度,
 *    单价,冷却,句柄映射全部以 key 为判据.
 * 3. 对上游:只传映射后的合法内容(key 或服务端句柄 fbm1.).
 *
 * 全仓只此一处实现该映射, 保证"对外展示"与"内部映射"严格 1:1.
 * 见 .agents/notes/implemented/architecture/2026-10-04-model-name-three-layers.md.
 *
 * 回退顺序:displayName -> key.
 *
 * @param {{ key?: string, displayName?: string }} row 目录行
 * @returns {string} 对外名称;两者皆空时返回空串(调用方应过滤该行)
 */
export function catalogDisplayName(row?: { key?: string, displayName?: string } | null): string {
  if (!row || typeof row !== 'object') return ''
  const dn = typeof row.displayName === 'string' ? row.displayName.trim() : ''
  if (dn) return dn
  const key = typeof row.key === 'string' ? row.key.trim() : ''
  return key
}

/**
 * 从模型 id 推导 Freebuff root agent id(兜底规则).
 *
 * Codebuff 的 root agent 命名规律是 base2-free-<slug>,但 slug 不是简单
 * 从模型 id 映射(如 z-ai/glm-5.3-flash -> glm-5-3-flash:点变横线;
 * openai/gpt-5.6-luna -> luna:整个名字是特例).所以这里只做
 * 通用 slug 化,已知表(catalog / 自定义)永远优先于推导.
 *
 * @param {string} modelId 模型 id
 * @returns {string | null} 推导出的 agent id;无法推导返回 null
 */
export function deriveAgentId(modelId?: string): string | null {
  if (!modelId || typeof modelId !== 'string') return null
  const slug = (modelId.split('/').pop() ?? '') // 去掉 provider 前缀
    .replace(/\./g, '-') // 5.3 -> 5-3
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase()
  if (!slug) return null
  return `base2-free-${slug}`
}

/**
 * 传进来的模型标识是不是目录标识(目录 key m-xxx / 句柄 fbm1.).
 *
 * 判据与 src/proxy.ts 的 isCatalogMode(snap.model 以 m- / fbm1. 开头)
 * 同源:目录模式下上游只认统一 agent,不按模型推导 agent.
 *
 * @param {string} modelId 模型标识
 * @returns {boolean} true 表示目录标识
 */
export function isCatalogModelId(modelId?: string): boolean {
  return (
    typeof modelId === 'string' &&
    (modelId.startsWith('m-') || modelId.startsWith('fbm1.'))
  )
}

/**
 * luna 系模型(上游已退役 base2 孪生,任何 base2 尝试触发风控)强制返回
 * base3 agent;非 luna 返回 null(不强制).
 *
 * 映射(与 catalog 的 base3 孪生一致,只把 base2 强制为 base3):
 *   gpt-5.6-luna     -> base3-free-luna
 *   gpt-5.6-luna-es  -> base3-free-luna-es
 *   gpt-5.6-luna-max -> 无 base3 孪生,但 base2 同样有风控风险,回退通用
 *                        base3-free-luna(宁可用可能不存在的 base3,绝不碰 base2)
 *
 * 硬性例外(风控保护):luna 系列只能用 base3 孪生 agent.
 *
 * @param {string} modelId 模型 id
 * @returns {string | null} 强制的 base3 agent;非 luna 返回 null
 */
export function forcedBase3AgentForModel(modelId?: string): string | null {
  if (typeof modelId !== 'string' || !modelId) return null
  const slug = modelId.split('/').pop()?.toLowerCase() || ''
  if (slug === 'gpt-5.6-luna') return 'base3-free-luna'
  if (slug === 'gpt-5.6-luna-es') return 'base3-free-luna-es'
  if (slug === 'gpt-5.6-luna-max') return 'base3-free-luna'
  return null
}

/**
 * 解析前端自定义模型列表为查询 Map(id -> record).
 *
 * @param {{ id: string, pool?: string, agentId?: string, fallbackAgentId?: string }[]} [customModels] 自定义模型
 * @returns {Map<string, { pool?: string, agentId?: string, fallbackAgentId?: string }>} id -> record
 */
export function customModelIndex(customModels?: CustomModel[]): Map<string, any> {
  const index = new Map<string, any>()
  for (const cm of customModels || []) {
    if (!cm || typeof cm.id !== 'string' || !cm.id) continue
    index.set(cm.id, cm)
  }
  return index
}

/**
 * Freebuff free-mode root agent id for a model (server run registry).
 *
 * 解析顺序:目录标识 > luna 强制 base3 > 前端自定义 agentId > 内置 catalog >
 * 命名规则推导 > 通用 base2-free.
 *
 * 目录标识(m-xxx 目录 key / fbm1. 句柄)不推导,一律返回统一 agent
 * base3-free-catalog:目录模式下官方 START 用的就是这个值,而目录 key 不含任何
 * 模型名信息,deriveAgentId 对它只会产出 base2-free-m-00032eaeec 这种上游
 * 不存在的 agent.见 2026-10-01-catalog-agent.md,
 * 2026-10-03-readable-model-id-unification.md.
 *
 * @param {string} modelId 模型 id
 * @param {{ id: string, agentId?: string }[]} [customModels] 前端配置的自定义模型(可覆盖 agentId)
 * @returns {string} root agent id
 */
export function agentIdForModel(modelId: string, customModels?: CustomModel[]): string {
  if (isCatalogModelId(modelId)) return CATALOG_UNIFIED_AGENT_ID
  const forced = forcedBase3AgentForModel(modelId)
  if (forced) return forced
  const cm = customModelIndex(customModels).get(modelId)
  if (cm?.agentId) return cm.agentId
  ensureAgentIndex()
  const known = CATALOG_AGENT_BY_MODEL.get(modelId)
  if (known) return known
  const derived = deriveAgentId(modelId)
  if (derived) return derived
  return 'base2-free'
}

/**
 * 主 agent 不可用时的兜底 agent(base3 孪生;无孪生则回退通用 base2-free).
 *
 * 解析顺序:目录标识 > luna 强制 base3 > 前端自定义 fallbackAgentId >
 * 内置 catalog > 通用 base2-free.
 * 注意:不搞"推导 base3" -- catalog 里没有 base3 孪生的模型(如 -max 系列)
 * 推导出的 base3-free-* 很可能不存在,回退 base2-free 反而更稳.
 *
 * 目录标识(m-xxx / fbm1.)与主 agent 一致返回 base3-free-catalog:
 * 目录模式下的兜底必须同代,跨世代(base2)会被上游按世代校验拒绝.
 *
 * @param {string} modelId 模型 id
 * @param {{ id: string, fallbackAgentId?: string }[]} [customModels] 自定义模型
 * @returns {string} 兜底 agent id
 */
export function agentFallbackForModel(modelId: string, customModels?: CustomModel[]): string {
  if (isCatalogModelId(modelId)) return CATALOG_UNIFIED_AGENT_ID
  const forced = forcedBase3AgentForModel(modelId)
  if (forced) return forced
  const cm = customModelIndex(customModels).get(modelId)
  if (cm?.fallbackAgentId) return cm.fallbackAgentId
  ensureAgentIndex()
  const known = CATALOG_FALLBACK_BY_MODEL.get(modelId)
  if (known) return known
  return 'base2-free'
}

/**
 * 单条模型解析后的完整 agent 元信息(供前端展示/同步参考,不参与调度).
 *
 * @param {string} modelId 模型 id
 * @param {{ id: string, agentId?: string, fallbackAgentId?: string }[]} [customModels] 自定义模型
 * @returns {{ agentId: string, fallbackAgentId: string }} agent 元信息
 */
export function agentMetaForModel(modelId: string, customModels?: CustomModel[]): AgentMeta {
  return {
    agentId: agentIdForModel(modelId, customModels),
    fallbackAgentId: agentFallbackForModel(modelId, customModels),
  }
}
