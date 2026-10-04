import { t } from '../../i18n.js'
import { api } from '../api.js'
import { state } from '../state.js'


export function shortModel(model) {
  const m = String(model || '').split('/')
  return m[m.length - 1] || model
}

/** 目录 key → 显示名(用模型列表里已有的条目做本地兜底). */
export function displayNameFor(key) {
  const hit = (state.models || []).find((m) => m.id === key)
  return hit?.display_name || hit?.displayName || null
}

/**
 - 把后端下发的[目录 key → 可读名]表并入本地缓存.
 *
 - 为什么是合并而不是替换:/api/overview 与 /api/accounts/refresh 各自只带
 - 当前那次快照里出现过的模型,直接替换会让上一次拿到的名字丢失,界面在两次
 - 刷新之间闪回裸 key.合并则只增不减,映射只会越来越全.
 - @param {{ modelNames?: Record<string, string>, upstreamModels?: Array<{key: string, displayName?: string|null}> }|null} payload
 */
export function applyModelNames(payload) {
  if (!payload) return
  const incoming = payload.modelNames
  if (incoming && typeof incoming === 'object') {
    Object.assign(state.modelNames, incoming)
  }
  for (const row of payload.upstreamModels || []) {
    if (row && typeof row.key === 'string' && row.displayName) {
      state.modelNames[row.key] = row.displayName
    }
  }
}

/**
 - 上游给了额度的模型 —— 换算成 /v1/models 里实际会出现的 id.
 *
 - 注释里别写  + /v1/...: 紧邻斜杠会提前闭合块注释(这正是
 - 刚才写这行时踩到的语法错误).
 *
 - 后端两个字段口径不同:upstreamModelIds 是目录 key(m-00032eaeec,判据真值),
 - upstreamModels 是带 catalogId/displayName 的三件套.而 /v1/models 的 id 由
 - displayName || key 决定(见 src/model.js 的 catalogDisplayName).下拉按
 - m.id 比对打 ,所以这里必须做同样的换算,否则一个  也标不出来.
 - @returns {Set<string>}
 */
export function upstreamReadableIds() {
  const keys = state.upstreamModelIds || []
  const byKey = new Map((state.upstreamModels || []).map((r) => [r?.key, r]))
  const out = new Set()
  for (const key of keys) {
    const row = byKey.get(key)
    /**
     - 必须与后端的名称口径逐字一致:displayName || key.
     *
     - 此前这里写的是 catalogId || displayName,而后端 /api/models/upstream
     - 的 id 用的是 displayName(catalogId 只是 legacy 反查的并列字段,
     - 值其实是另一个东西 —— 实测 id='MiMo 2.6 Flash' 而 catalogId='mimo/mimo-v2.5').
     - 两边算出不同的 id → 测试对话下拉的  一个也标不出来.
     *
     - 与 src/model.js 的 catalogDisplayName() 同源:displayName 优先,
     - 缺失才回退 key(不凭空编名字).
     */
    out.add((row && (row.displayName || row.key)) || key)
  }
  /**
   - 目录驱动口径:后端 /api/models 的每条自带 rate_limit(有额度的才有),
   - 直接按它补充  集合 —— 不必依赖 upstreamModelIds 那张单独的表.
   - (该表以前来自 session 回执的 rateLimitsByModel,只有 6 个键,用它标注
   - 会大面积漏标;清单现在以目录行为准.)
   */
  for (const m of state.catalogModels || []) {
    if (m && m.rate_limit && m.rate_limit.limit !== 0) out.add(m.id)
  }
  return out
}

/**
 - 额度 chip / 悬停提示里的模型标识 → 人能看懂的名字.
 *
 - 上游回执(rateLimitsByModel / freebucks.prices / session.model)给的全是
 - 目录 key(m-00032eaeec),直接渲染出来用户根本认不出是哪个模型.
 - 取值顺序:后端随总览下发的映射 > 模型列表里的 display_name > 去掉 provider
 - 前缀的可读 id > 原值.绝不返回空——取不到名字就显示原 key,不隐藏信息.
 - @param {string} model
 - @returns {string}
 */
export function modelNameFor(model) {
  if (!model) return ''
  const key = String(model)
  const mapped = state.modelNames && state.modelNames[key]
  if (mapped) return mapped
  const local = displayNameFor(key)
  if (local) return local
  // 已经是可读 id(deepseek/deepseek-v4-flash)时,至少去掉 provider 前缀
  return shortModel(key)
}

/**
 - 展示用的模型名:优先后端解析好的可读名(modelDisplayName),
 - 其次把目录 key(m-00032eaeec)换成显示名,最后才回落到原值.
 *
 - 上游回执侧(session.model / rateLimitsByModel / prices)用的全是
 - 目录 key,直接显示就是 m-00032eaeec —— 用户看不出是哪个模型.
 - 涉及请求/寻址的地方绝不能用这个函数(那里要的是 key 本身).
 - 桥接依据见
 - .agents/notes/implemented/bug-fix/2026-10-02-catalog-key-display-name-bridge.md
 - @param {{ session?: { model?: string }, modelDisplayName?: string } | null} a 账号行
 - @returns {string}
 */
export function modelLabel(a) {
  const sess = a?.session
  const key = sess?.model
  if (!key) return '—'
  // 后端已解析的可读名优先(session.modelDisplayName),再用本地映射兜底,
  // 最后才落到短 key —— 与额度 chip 走同一个解析函数,避免两处口径分叉.
  return sess?.modelDisplayName || modelNameFor(key)
}

/** 池类型显示名(走 i18n;GLM 5.3 是模型名,两个语种同文) */
export const POOL_LABELS = {
  premium: 'model.poolPremium',
  daily: 'model.poolDaily',
  referral: 'model.poolReferral',
  limited_offer: 'model.poolLimitedOffer',
  glm_v53_flash: 'model.poolGlmV53Flash',
}

export function poolLabel(pool) {
  if (!pool) return t('common.none')
  const key = POOL_LABELS[pool]
  return key ? t(key) : pool
}

export function poolBadgeClass(pool) {
  if (pool === 'premium') return 'badge warn'
  if (pool === 'referral') return 'badge admin'
  return 'badge'
}
