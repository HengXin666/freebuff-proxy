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
import {
  readJsonFileState,
  noteDataFile,
  quarantineFile,
  invalidShape,
} from './util/json-store.js'
import { fileURLToPath } from 'node:url'

const CATALOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'catalog',
  'freebuff-catalog.json',
)

/** 运行时 catalog 缓存文件名（写在 dataDir 下）。 */
export const CATALOG_CACHE_FILENAME = 'catalog-cache.json'

/**
 * 运行时 catalog 缓存的**默认**路径（仓库根 ./data/catalog-cache.json）。
 * 仅作裸机默认值；Docker 等 dataDir 可配置的场景必须显式传 dataDir
 * （见 catalogCachePath / configureCatalogCache），否则会写到只读的
 * 安装目录（旧行为写死 /app/data，容器里降权后 EACCES，见 issue #9）。
 */
export const DEFAULT_CATALOG_CACHE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  CATALOG_CACHE_FILENAME,
)

/**
 * dataDir → 缓存文件路径。
 * @param {string} dataDir
 * @returns {string}
 */
export function catalogCachePath(dataDir) {
  return path.join(dataDir, CATALOG_CACHE_FILENAME)
}

/**
 * 运行时缓存的生效路径。模块加载时按默认值算一次（首次读缓存用），
 * server 启动时由 configureCatalogCache(dataDir) 改写到 <dataDir>/。
 * @type {string}
 */
let catalogCachePathInUse = DEFAULT_CATALOG_CACHE_PATH

/**
 * server 启动时把缓存路径切到 <dataDir>/catalog-cache.json（并在空目录上
 * 预创建）。必须在 startCatalogSync 之前调用：读（loadCatalog 已在模块加载时
 * 执行，故 server 场景下用 applyCatalogCache）与写必须指向同一目录。
 * @param {string} dataDir
 * @returns {string} 生效的缓存路径
 */
export function configureCatalogCache(dataDir) {
  if (!dataDir) return catalogCachePathInUse
  catalogCachePathInUse = catalogCachePath(dataDir)
  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (err) {
    console.warn(
      `[model] dataDir not writable (${catalogCachePathInUse}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  return catalogCachePathInUse
}

/**
 * 切换缓存目录并**重新读取**合并后的 catalog（供 server 启动时用，替代只读一次的
 * 模块加载期加载）。返回生效路径与模型列表：调用方可在缓存文件缺失时用它兜底
 * 写一份（保证 /v1/models 与上游源码解析结果一致）。
 * @param {string} dataDir
 * @returns {{ path: string, models: any[] }}
 */
export function applyCatalogCache(dataDir) {
  return { path: configureCatalogCache(dataDir), models: loadCatalog() }
}

/**
 * 读取内置 catalog（解析失败时回退空列表，不阻塞启动）。
 * 内置 catalog 的 pool/note/displayName 是手工精修过的静态元信息
 * （premium/referral/withdrawn 语义），动态缓存不覆盖它们。
 */
function loadBuiltinCatalog() {
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
 * 加载合并后的 catalog：
 *   内置 catalog（静态元信息：pool/note/displayName/accessTiers）+
 *   运行时缓存（data/catalog-cache.json，动态 agent 映射：agentId/fallbackAgentId）。
 *
 * 合并规则（对齐 trefeon：registry 管 agent 映射、modelcat 管 pool/cap）：
 *   - 缓存里的模型若内置 catalog 已存在 → 保留内置的 pool/note 等元信息，
 *     但 agent 映射（agentId/fallbackAgentId）用缓存的（跟随上游最新状态）；
 *   - 缓存里新增的模型（内置没有）→ 直接采用缓存条目；
 *   - 缓存不存在/损坏/为空 → 纯内置 catalog（基线行为，与改动前一致）。
 *   - 缓存属于 dataDir（Docker 里是挂载卷 /data），容器重建不丢；不可写时
 *     仅告警并保留内存态（见 runtime-sync 的 writeCatalogCache）。
 */
function loadCatalog() {
  let cached = null
  // 运行时缓存是**派生数据**（可由内置 catalog / 上游同步重建），所以坏了就
  // 当没有——但必须显式登记 + 把损坏文件挪走留证，绝不能安静地当"从没同步过"。
  let st = readJsonFileState(catalogCachePathInUse)
  if (st.status === 'ok' && !Array.isArray(st.data?.models)) {
    st = invalidShape('缺少 models 数组')
  }
  if (st.status === 'invalid') {
    const moved = quarantineFile(catalogCachePathInUse)
    console.warn(
      `[model] catalog 缓存损坏，已忽略并重建${moved ? `（原文件备份为 ${moved}）` : ''}: ${st.reason}`,
    )
  }
  noteDataFile(catalogCachePathInUse, st)
  if (st.status === 'ok' && st.data.models.length > 0) cached = st.data.models
  return mergeCatalogWithBuiltin(loadBuiltinCatalog(), cached)
}

/**
 * 把运行时缓存合并进内置 catalog（拆成纯函数便于测试，见 test/smoke.mjs）。
 * @param {any[]} builtin
 * @param {any[] | null} cached
 * @returns {any[]}
 */
export function mergeCatalogWithBuiltin(builtin, cached) {
  if (!cached) return builtin

  const builtinById = new Map(builtin.map((m) => [m.id, m]))
  return cached.map((cm) => {
    const bm = builtinById.get(cm.id)
    if (!bm) return cm
    // 内置元信息优先（手工精修），agent 映射跟随缓存（上游最新）。
    return {
      ...cm,
      ...bm,
      agentId: cm.agentId || bm.agentId,
      fallbackAgentId: cm.fallbackAgentId || bm.fallbackAgentId,
    }
  })
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

/**
 * catalog 里的模型（含已暂停/退役的，保留 id 可识别）。
 *
 * ⚠️ **惰性加载**（首次访问才算），不要在模块顶层直接 `loadCatalog()`。
 *
 * 实测（Node v26.10.0）：本模块在顶层读 catalog 缓存、建多张索引表时，
 * 同一进程里的 `catalog-models.js` 产出的对象会**静默丢失字段**
 * （`freebucks_per_hour` 等变 null，连 JSON.stringify 都拿不到），
 * 而单独导入 catalog-models.js 则完全正常 —— 与导入顺序无关，只要本模块
 * 被求值就会触发。改成惰性后两种模块共存时行为一致
 * （已用 13 行真机目录验证：10/15/15/20/30/0/10/0/80/15/100/2/2）。
 *
 * 惰性化还有一个附带好处：本模块被纯工具型脚本导入（只想用
 * isModelAllowed / agentIdForModel）时不再读磁盘。
 */
let _catalogModels = null
function catalogModels() {
  if (!_catalogModels) _catalogModels = /** @type {any} */ (loadCatalog())
  return _catalogModels
}
const CATALOG_MODELS = new Proxy([], {
  get(_t, prop) {
    const list = catalogModels()
    const v = Reflect.get(list, prop)
    return typeof v === 'function' ? v.bind(list) : v
  },
  has(_t, prop) { return Reflect.has(catalogModels(), prop) },
  ownKeys() { return Reflect.ownKeys(catalogModels()) },
  getOwnPropertyDescriptor(_t, prop) {
    return Reflect.getOwnPropertyDescriptor(catalogModels(), prop)
  },
})

/**
 * 目录协议下的**统一 agent id**。
 *
 * 官方在 catalog 模式下不再按模型选 agent —— 所有目录模型共用一个 root agent。
 * 二进制原文：
 *   UK = "base3-free-catalog"
 *   Ps$(H){ return WD().row(H)?.key === H ? UK : cCH(H) }
 * 即：会话模型是目录 key 时返回 UK，否则才走 `cCH`（按 base2/base3 推导）。
 *
 * 抓包实测：官方 chat 走目录协议时，agent-run 的 START 是
 * `{"action":"START","agentId":"base3-free-catalog","ancestorRunIds":[]}`。
 *
 * 见 .agents/notes/implemented/bug-fix/2026-10-01-catalog-agent.md
 */
export const CATALOG_UNIFIED_AGENT_ID = 'base3-free-catalog'

/** 内置 catalog 的 model → agent 映射（base2 主 agent / base3 孪生）。 */
const CATALOG_AGENT_BY_MODEL = new Map()
const CATALOG_FALLBACK_BY_MODEL = new Map()
/** agent 索引是否已建（惰性：首次用到才遍历 catalog，见 CATALOG_MODELS 说明）。 */
let _agentIndexBuilt = false
function ensureAgentIndex() {
  if (_agentIndexBuilt) return
  _agentIndexBuilt = true
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

/** Regular Freebuff picker models + documented extras Agents may request. */
export function freebuffAvailableModels() {
  ensureAgentIndex()
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
 * @deprecated 用 `freebuffAvailableModels()`（惰性）。保留为惰性 Proxy 以兼容
 * 既有 `import { FREEBUFF_AVAILABLE_MODELS }` 的调用点，不会在模块顶层读盘。
 */
export const FREEBUFF_AVAILABLE_MODELS = new Proxy([], {
  get(_t, prop) {
    const list = freebuffAvailableModels()
    const v = Reflect.get(list, prop)
    return typeof v === 'function' ? v.bind(list) : v
  },
  has(_t, prop) { return Reflect.has(freebuffAvailableModels(), prop) },
  ownKeys() { return Reflect.ownKeys(freebuffAvailableModels()) },
  getOwnPropertyDescriptor(_t, prop) {
    return Reflect.getOwnPropertyDescriptor(freebuffAvailableModels(), prop)
  },
})

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
 *   extraIds?: (string | { key: string, displayName?: string | null, catalogId?: string | null })[],
 *   customModels?: { id: string, displayName?: string, pool?: string, multimodal?: boolean, agentId?: string, note?: string }[],
 *   blockPremium?: boolean,
 * }} [opts]
 */
export function buildModelsListResponse(opts = {}) {
  const accessTier = opts.accessTier ?? null
  const includeAllCatalog = opts.includeAllCatalog !== false
  // 一键屏蔽收费模型（pool=premium）时，从列表彻底移除——用户用不了，占位还误触风控。
  const blockPremium = opts.blockPremium === true
  // 用户在前端「模型管理」删除（隐藏）的模型 id：从列表里彻底移除
  const hidden = new Set(opts.hiddenModels || [])
  const skip = (id) => hidden.has(id) || (blockPremium && isPremiumModel(id))

  /** @type {Map<string, object>} */
  const byId = new Map()

  if (includeAllCatalog) {
    for (const m of FREEBUFF_AVAILABLE_MODELS) {
      if (skip(m.id)) continue
      /**
       * `available` 的含义**只是**"现在能不能直接发请求"，不是"这个模型存不存在"。
       *
       * 2026-09-15 修：以前这里用 `accessTiers.includes(accessTier)` 判定，而内置
       * catalog 的 15 条**全都没有 accessTiers 字段** → 一律回落成默认 `['full']` →
       * 只要上游回一次 `accessTier: 'limited'`，整个内置目录就被染成
       * `available: false`。下游把 /v1/models 当权威模型表的客户端 + 控制台
       * 测试对话（原本只留 `available !== false`）于是**只看到剩余的一个**
       * （extraIds 里上游给过额度的那个模型）——用户反馈的"只有一个模型"就是这个。
       *
       * 目录准入不等于实时配额：真正拦人的是价格/额度（freebucks 闸门）与
       * agent 可用性，不是这个静态标记。所以**目录条目一律 available: true**，
       * tier 信息只作为元数据透出（access_tiers / current_access_tier），由调用方
       * 自己决定怎么展示。
       */
      byId.set(m.id, toOpenAiModel(m, { available: true, accessTier }))
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

  /**
   * 上游**会话回执**里才出现的模型（rateLimitsByModel / limitedModelOffers /
   * 当前 model），内置 catalog 未必收录。
   *
   * ⚠️ 这里的 id **不能**直接是目录 key（`m-00032eaeec`）：下游 Agent 拿
   * `/v1/models` 当模型表，看到的就是这串不透明标识 —— 用户明确要求
   * 「返回的应该是模型名称，而不是 ID」。所以按下列优先级取可读口径：
   *
   *   1. `catalogId`（deepseek/deepseek-v4-flash）—— 上游与生态通用写法，
   *      调度侧 isModelAllowed / handleFor 都能直接认；
   *   2. `displayName`（Solar Pro 4）—— 内置 catalog 尚未收录的上游新模型
   *      只有服务端给的名字可取，chat 入口会把它解析回 key（见 proxy.js）；
   *   3. 兜底才是原 key（连名字都没有时，至少不丢模型）。
   *
   * 若 `catalogId` 指向的条目已经在列表里，说明它与内置/自定义条目是**同一个
   * 模型**，不再重复添加（用户看到的列表里就此不再有裸 key 条目）。
   * 原始 key 作为 `freebuff_key` 透出，调试/高级客户端仍能拿到服务端真值。
   */
  for (const entry of opts.extraIds || []) {
    const e = typeof entry === 'string' ? { key: entry } : (entry || {})
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
 * 传进来的模型标识是不是**目录标识**（目录 key `m-xxx` / 句柄 `fbm1.`）。
 *
 * 判据与 `src/proxy.js` 的 `isCatalogMode`（`snap.model` 以 `m-` / `fbm1.` 开头）
 * 同源：目录模式下上游只认统一 agent，不按模型推导 agent。
 * @param {string} modelId
 * @returns {boolean}
 */
export function isCatalogModelId(modelId) {
  return (
    typeof modelId === 'string' &&
    (modelId.startsWith('m-') || modelId.startsWith('fbm1.'))
  )
}

/**
 * Freebuff free-mode root agent id for a model (server run registry)。
 * 解析顺序：目录标识 > 前端自定义 agentId > 内置 catalog > 命名规则推导 >
 * 通用 base2-free。
 *
 * ⚠️ 目录标识（`m-xxx` 目录 key / `fbm1.` 句柄）**不推导**，一律返回统一 agent
 * `base3-free-catalog`：目录模式下官方 START 用的就是这个值，而目录 key 不含任何
 * 模型名信息，`deriveAgentId` 对它只会产出 `base2-free-m-00032eaeec` 这种**上游
 * 不存在**的 agent。见 2026-10-01-catalog-agent.md、2026-10-03-readable-model-id-unification.md。
 *
 * ⚠️ 硬性例外（风控保护）：luna 系列只能用 base3 孪生 agent。上游已退役
 * base2-free-luna 且任何 base2 尝试都会触发账号风控（实测）。因此 luna 的
 * agentId 一律强制为 base3-free-luna，**无论**自定义覆盖还是 catalog 写了
 * base2——宁可用 base3 失败，绝不拿 base2 去冒险。
 * @param {string} modelId
 * @param {{ id: string, agentId?: string }[]} [customModels] 前端配置的自定义模型（可覆盖 agentId）
 * @returns {string}
 */
export function agentIdForModel(modelId, customModels) {
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
 * 主 agent 不可用时的兜底 agent（base3 孪生；无孪生则回退通用 base2-free）。
 * 解析顺序：目录标识 > 前端自定义 fallbackAgentId > 内置 catalog > 通用 base2-free。
 * 注意：不搞"推导 base3"——catalog 里没有 base3 孪生的模型（如 -max 系列）
 * 推导出的 base3-free-* 很可能不存在，回退 base2-free 反而更稳。
 *
 * 目录标识（`m-xxx` / `fbm1.`）与主 agent 一致返回 `base3-free-catalog`：
 * 目录模式下的兜底**必须同代**，跨世代（base2）会被上游按世代校验拒绝。
 *
 * 硬性例外同 agentIdForModel：luna 系列的兜底也强制 base3（本来主 agent 就是
 * base3，兜底一致，绝无 base2 参与）。
 * @param {string} modelId
 * @param {{ id: string, fallbackAgentId?: string }[]} [customModels]
 * @returns {string}
 */
export function agentFallbackForModel(modelId, customModels) {
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
 * luna 系模型（上游已退役 base2 孪生、任何 base2 尝试触发风控）强制返回
 * base3 agent；非 luna 返回 null（不强制）。
 * 映射（与 catalog 的 base3 孪生一致，只把 base2 强制为 base3）：
 *   gpt-5.6-luna    → base3-free-luna
 *   gpt-5.6-luna-es → base3-free-luna-es
 *   gpt-5.6-luna-max → 无 base3 孪生，但 base2 同样有风控风险，回退通用
 *                      base3-free-luna（宁可用可能不存在的 base3，绝不碰 base2）
 * @param {string} modelId
 * @returns {string | null}
 */
function forcedBase3AgentForModel(modelId) {
  if (typeof modelId !== 'string' || !modelId) return null
  const slug = modelId.split('/').pop()?.toLowerCase() || ''
  if (slug === 'gpt-5.6-luna') return 'base3-free-luna'
  if (slug === 'gpt-5.6-luna-es') return 'base3-free-luna-es'
  if (slug === 'gpt-5.6-luna-max') return 'base3-free-luna'
  return null
}

/**
 * 单条模型解析后的完整 agent 元信息（供前端展示/同步参考，不参与调度决策）。
 * @param {string} modelId
 * @param {{ id: string, agentId?: string, fallbackAgentId?: string }[]} [customModels]
 * @returns {{ agentId: string, fallbackAgentId: string }}
 */
export function agentMetaForModel(modelId, customModels) {
  return {
    agentId: agentIdForModel(modelId, customModels),
    fallbackAgentId: agentFallbackForModel(modelId, customModels),
  }
}

/**
 * 模型是否在代理"可调度"白名单内（未隐藏 + 已知模型/自定义/上游会话出现过）。
 *
 * 用于 /v1/chat/completions 的 model 字段校验：任何不在白名单的模型 id
 * 一律 400 拒绝，绝不盲发上游——避免把"APP 里没有的模型"探测请求打到
 * Freebuff（上游会把这些当异常行为标记账号，这正是免费反代被封号的主要诱因）。
 *
 * 白名单 = 内置 catalog（未隐藏） ∪ 自定义模型（未隐藏） ∪ 上游会话实际出现过的 id
 *           ∪ 顶层 model 字段（session 当前模型）
 *
 * @param {string} modelId
 * @param {{
 *   customModels?: { id: string }[],
 *   hiddenModels?: string[],
 *   sessionModelIds?: string[],
 *   sessionModel?: string | null,
 *   blockPremium?: boolean,
 * }} [opts]
 * @returns {boolean}
 */
export function isModelAllowed(modelId, opts = {}) {
  if (!modelId || typeof modelId !== 'string') return false
  const hidden = new Set(opts.hiddenModels || [])
  if (hidden.has(modelId)) return false
  // 一键屏蔽收费模型：premium 模型直接拒用（不盲发上游，避免风控）。
  if (opts.blockPremium && isPremiumModel(modelId)) return false

  // 1) 内置 catalog（未隐藏）——含 WITHDRAWN 标记的退役模型也放行：
  //    退役标记只是提示，直接拒绝会误伤仍在用旧对话/存量 session 的用户；
  //    上游会话探测若确认没有，会走第 3 层兜底拒绝。
  if (catalogModels().some((m) => m.id === modelId)) return true
  // 2) 前端自定义（未隐藏）
  if ((opts.customModels || []).some((m) => m && m.id === modelId)) return true
  // 3) 上游会话实际出现过（rateLimitsByModel / limitedModelOffers / 当前 model）
  const seen = new Set(opts.sessionModelIds || [])
  if (opts.sessionModel) seen.add(opts.sessionModel)
  if (seen.has(modelId)) return true
  /**
   * 4) **目录行**（模型清单的权威）。
   *
   * ⚠️ 顺序必须在这里：目录有 13 行，而 rateLimits（第 3 层）只有 6 个键。
   * 少了这一层，目录里的模型（尤其当日额度为 0 或没被授予额度的）会被
   * `model_not_allowed` 拒掉 —— 正是「远程请求模型返回没有任何可用模型」。
   *
   * 匹配两个口径：`key`（m-096e75164d，resolveModelAlias 归一后的形态）与
   * `displayName`（可读口金，前端同步后写进自定义的那种）。
   */
  const keys = opts.catalogKeys
  if (keys) {
    for (const k of keys) {
      if (k === modelId) return true
    }
  }
  return false
}

/**
 * 模型是否为收费模型（pool=premium）：用户用不了、做了还占额度/触风控。
 * 判定优先级：自定义条目（可强制改 pool）> catalog > 按命名规律推断。
 * @param {string} modelId
 * @param {{ id: string, pool?: string }[]} [customModels]
 * @returns {boolean}
 */
export function isPremiumModel(modelId, customModels) {
  const cm = (customModels || []).find((m) => m && m.id === modelId)
  if (cm) return (cm.pool || 'daily') === 'premium'
  const cat = FREEBUFF_AVAILABLE_MODELS.find((m) => m.id === modelId)
  if (cat) return cat.pool === 'premium'
  return false
}

/**
 * 启动运行时 catalog 自动同步（对齐 trefeon refreshLoop：启动立即一次 + 每 intervalMs 一次）。
 * 拉上游源码解析 model→agent，原子写生效缓存路径；失败保留旧缓存。
 * 供 server 启动时调用；懒 import runtime-sync，避免 model.js 顶部引入网络依赖。
 *
 * @param {{ intervalMs?: number, log?: (msg: string) => void }} [opts]
 * @returns {{ stop: () => void, refresh: () => Promise<{ ok: boolean, error?: string, models?: number }> }}
 */
export function startCatalogSync(opts = {}) {
  // 动态 import：仅在 server 主动调用时加载网络同步逻辑。
  let sync = null
  try {
    // eslint-disable-next-line no-undef
    sync = { start: (...a) => import('./catalog/runtime-sync.mjs').then((m) => m.startCatalogSync(...a)) }
  } catch {
    /* runtime-sync 缺失时静默禁用自动同步 */
  }
  if (!sync) {
    return { stop: () => {}, refresh: async () => ({ ok: false, error: 'runtime-sync unavailable' }) }
  }
  const inner = { current: null }
  // 先同步拉起模块再启动循环（首启即刷）。
  import('./catalog/runtime-sync.mjs')
    .then((m) => {
      inner.current = m.startCatalogSync(catalogCachePathInUse, {
        intervalMs: opts.intervalMs,
        log: opts.log,
        fetchImpl: opts.fetchImpl,
      })
    })
    .catch((err) => {
      if (opts.log) {
        opts.log(`catalog sync disabled: ${err instanceof Error ? err.message : err}`)
      }
    })
  return {
    stop: () => inner.current?.stop?.(),
    refresh: () =>
      inner.current
        ? inner.current.refresh()
        : Promise.resolve({ ok: false, error: 'sync not started yet' }),
  }
}
