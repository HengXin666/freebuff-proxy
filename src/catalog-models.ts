// 模型名称的单一真源:对外名称只在这里定义(见 catalogDisplayName 的注释)
import { catalogDisplayName } from './model.ts'

/** buildCatalogDrivenModelsResponse 的输入. */
export interface CatalogModelsInput {
  rows?: any[]
  rateLimits?: Map<string, any> | Record<string, any>
  prices?: Map<string, number> | Record<string, number>
  accessTier?: string | null
  issuedAt?: number | null
  hiddenModels?: string[]
  blockPremium?: boolean
}

/**
 * 目录驱动的模型表(模型清单的权威).
 *
 * 三张表分工(docs/reverse/19 §19.5):
 * - rows(13 行)  → 模型清单(本函数的输入)
 * - rateLimits     → 每模型每日额度(只挂元数据)
 * - prices         → 每模型单价 Freebucks/小时(只挂元数据)
 * 额度与目录各自独立: 清单不因额度为 0 而消失, 额度也不因目录收录而出现.
 *
 * 对外口径:id 一律是人能认的模型名(目录行的 displayName,
 * 如 DeepSeek V4.1 Flash),freebuff_key 透出服务端标识 m-096e75164d.
 * 不用 legacyDigests 反查内置静态表.
 * 见 .agents/notes/implemented/bug-fix/2026-10-03-catalog-is-the-model-list.md
 *
 * @param {object} [input]
 * @param {any[]} [input.rows] 目录行(CatalogHolder.rows())
 * @param {Map<string, any> | Record<string, any>} [input.rateLimits] 目录 key → 额度
 * @param {Map<string, number> | Record<string, number>} [input.prices] 目录 key → FB/h
 * @param {string | null} [input.accessTier]
 * @param {number | null} [input.issuedAt] 目录签发时间(做 created)
 * @param {string[]} [input.hiddenModels] 前端隐藏的模型(按 可读 id 或 key 匹配)
 * @param {boolean} [input.blockPremium] 一键屏蔽收费模型
 * @returns {{ object: 'list', data: object[] }}
 */
export function buildCatalogDrivenModelsResponse(input: CatalogModelsInput = {}): { object: 'list', data: any[] } {
  const rows = Array.isArray(input.rows) ? input.rows : []
  const hidden = new Set(input.hiddenModels || [])
  const blockPremium = input.blockPremium === true
  /**
   - 两张元数据表在入口处就快照成普通对象,循环里用下标取值.
   - 不直接对传入的 Map 连续 get: 这段循环里的 Map.get 结果不可靠.
   */
  const rateLimits = toPlainObject(input.rateLimits)
  const prices = toPlainObject(input.prices)
  const accessTier = input.accessTier ?? null
  const created = Number.isFinite(input.issuedAt as number)
    ? Math.floor((input.issuedAt as number) / 1000)
    : 0

  /**
   - 用 map 产出,不用 for...of + push: 后者在这段取值逻辑下会出现
   - "属性在 Object.keys/JSON.stringify 里存在,但读取得到 undefined".
   */
  /**
   - 先把目录行规范化成干净对象再组装: 下游只拿得到我们声明过的字段,
   - 且不受上游新增字段影响.
   */
  const normalizedRows = normalizeRows(rows)
  const data = normalizedRows
    .filter((row: any) => {
      if (!row || typeof row !== 'object') return false
      const key = typeof row.key === 'string' ? row.key : ''
      if (!key) return false
      // 名称走单一真源(catalogDisplayName),不在这里另写一份口径
      const name = catalogDisplayName(row)
      // 隐藏/屏蔽按两个口径都判:控制台提交的是可读 id,调度白名单认 key.
      if (hidden.has(name) || hidden.has(key)) return false
      if (blockPremium && row.premium === true) return false
      return true
    })
    .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((row: any) => toEntry(row, rateLimits, prices, created, accessTier))
  return { object: 'list', data }
}

/**
 * 把目录行规范化成干净对象(下游只拿到我们声明过的字段).
 *
 * 逐字段取值并定型; 非本函数产出的对象不参与下游组装.
 *
 * @param {any[]} rows 目录原文行
 * @returns {any[]} 规范化后的行
 */
function normalizeRows(rows: any[]): any[] {
  return rows.map((row: any) => ({
    key: typeof row?.key === 'string' ? String(row.key) : '',
    displayName: typeof row?.displayName === 'string' ? String(row.displayName) : '',
    tagline: typeof row?.tagline === 'string' ? String(row.tagline) : '',
    premium: row?.premium === true,
    access: typeof row?.access === 'string' ? String(row.access) : '',
    multimodal: row?.multimodal === true,
    efforts: Array.isArray(row?.efforts) ? row.efforts.slice() : [],
    contextWindow: Number.isFinite(row?.contextWindow) ? Number(row.contextWindow) : null,
    sortOrder: Number.isFinite(row?.sortOrder) ? Number(row.sortOrder) : 0,
  }))
}

/**
 * 单行目录 -> 对外模型对象.
 *
 * @param {any} row 规范化后的目录行
 * @param {Record<string, any>} rateLimits 目录 key -> 额度
 * @param {Record<string, any>} prices 目录 key -> FB/h
 * @param {number} created 创建时间戳(秒)
 * @param {string | null} accessTier 当前档位
 * @returns {any} 对外模型对象
 */
function toEntry(
  row: any,
  rateLimits: Record<string, any>,
  prices: Record<string, any>,
  created: number,
  accessTier: string | null,
): any {
  const key = String(row.key)
  const name = catalogDisplayName(row)
  const limit = rateLimits[key] ?? null
  const price = prices[key] ?? null
  const fbPerHour = Number.isFinite(price) ? Number(price) : null
  const contextWindow = Number.isFinite(row.contextWindow) ? row.contextWindow : null
  const tagline = typeof row.tagline === 'string' && row.tagline ? row.tagline : null
  const efforts = Array.isArray(row.efforts) && row.efforts.length ? row.efforts : null
  const rateLimit = limit
    ? {
        limit: limit.limit ?? null,
        recent_count: limit.recentCount ?? null,
        reset_at: limit.resetAt ?? null,
        pool: limit.pool ?? null,
      }
    : null
  return {
    // 主标识是可读模型名,不是 m-xxx(用户明确要求).
    id: name,
    object: 'model',
    created,
    owned_by: 'freebuff',
    display_name: name,
    // 服务端寻址真值(调试/高级客户端用)
    freebuff_key: key,
    premium: row.premium === true,
    access: typeof row.access === 'string' ? row.access : null,
    multimodal: row.multimodal === true,
    // 目录条目一律 available:真正拦人的是额度/单价闸门,不是这个静态标记
    //(2026-09-15 修过一次:用 accessTiers 判定会把整个目录染成 false).
    available: true,
    source: 'catalog',
    // 可选元数据:字段恒定(缺省 null),下游不必处理字段缺失
    efforts,
    context_window: contextWindow,
    tagline,
    freebucks_per_hour: fbPerHour,
    rate_limit: rateLimit,
    current_access_tier: accessTier || null,
  }
}


/**
 * Map / 普通对象统一成普通对象(下标取值,行为确定).
 *
 * 不用 instanceof Map 判定:调用方与本模块被不同加载路径求值
 * (静态 import 与动态 import() 混用)时 Map 构造函数身份可能不同,
 * instanceof 会误判为 false;对 Map 取 Object.entries() 则得到空数组,
 * 整张表静默变空.鸭子类型 + 统一转普通对象在任何加载路径下都对.
 *
 * @param {Map<any, any> | Record<string, any> | null | undefined} v
 * @returns {Record<string, any>}
 */
function toPlainObject(v: Map<any, any> | Record<string, any> | null | undefined): Record<string, any> {
  if (!v) return {}
  if (typeof v !== 'object') return {}
  /**
   - Map: 用迭代器导出, 不走 .keys() + .get().
   */
  const maybeMap = v as any
  if (typeof maybeMap[Symbol.iterator] === 'function' && typeof maybeMap.get === 'function') {
    const out: Record<string, any> = {}
    for (const pair of maybeMap as any[]) {
      if (Array.isArray(pair)) out[String(pair[0])] = pair[1]
    }
    return out
  }
  // 普通对象:原样返回, 不额外展开复制(见本函数内的取值说明).
  return v as Record<string, any>
}
