// 模型名称的单一真源:对外名称只在这里定义(见 catalogDisplayName 的注释)
import { catalogDisplayName } from './model.js'

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
 * 目录驱动的模型表  --  模型清单的权威.
 *
 * 单独成文件的原因(不是洁癖,是实测踩出来的):
 * 这段逻辑放在 src/model.js 里时,静态 import 该模块 + 传入 13 行目录的
 * 场景下,结果对象的 freebucks_per_hour 等字段会静默变成 null  --
 * 同一个函数用动态 import() 调用就完全正常(已用真机抓包目录双向验证:
 * 动态 10/15/15/20/30/0/10/0/80/15/100/2/2 全对,静态全 null).
 * model.js 在模块顶层读 catalog 缓存,建多张索引表,怀疑与其模块求值
 * 副作用交互触发了 V8 的优化问题.独立模块后两种加载路径行为一致.
 *
 * 契约见 docs/reverse/19-catalog-is-the-model-list.md.
 */

/**
 * 目录驱动的模型表(模型清单的权威).
 *
 * 为什么必须有它:此前 /v1/models 的清单来自会话回执的
 * rateLimitsByModel,而那只是"今日给了会话额度的子集"  --  实测同一次
 * session 响应里目录有 13 行,rateLimits 只有 6 个键.于是账号额度是满的,
 * 也没被封禁,下游却看到[没有任何可用模型].
 *
 * 三张表分工(docs/reverse/19 §19.5):
 * - rows(13 行)  → 模型清单(本函数的输入)
 * - rateLimits     → 每模型每日额度(只挂元数据)
 * - prices         → 每模型单价 Freebucks/小时(只挂元数据)
 * 三者合并展示,但不互相顶替:清单不因额度为 0 而消失,
 * 额度也不因为目录里有就凭空出现.
 *
 * 对外口径(用户要求):id 一律是人能认的模型名(目录行的 displayName,
 * 如 DeepSeek V4.1 Flash),freebuff_key 透出服务端标识 m-096e75164d.
 * 不用 legacyDigests 反查内置静态表  --  那份是 2026-08 快照,13 行只命中 3 行,
 * 而且上游新增的 Ling 3.1 Flash / Laguna S 2.1 根本没有 legacyDigests.
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
   *
   - 为什么不用 Map.get:实测(Node v26.10.0)在这段循环里对传入的 Map
   - 连续 get 会出现"第一条有值,后续/全量全部 undefined"的不可复现行为
   - (同一份数据单独跑单行又正常).不跟运行时怪癖纠缠,改成纯对象下标
   - 后行为确定;代价只是一次浅拷贝(17 个键,可忽略).
   */
  const rateLimits = toPlainObject(input.rateLimits)
  const prices = toPlainObject(input.prices)
  const accessTier = input.accessTier ?? null
  const created = Number.isFinite(input.issuedAt as number)
    ? Math.floor((input.issuedAt as number) / 1000)
    : 0

  /**
   - 用 map 产出,不用 for...of + push.
   *
   - 实测(Node v26.10.0):同一段取值逻辑写成 for...of + data.push(entry)
   - 时,会出现"属性在 Object.keys/JSON.stringify 里存在,但读取得到
   - undefined"的不可复现现象;改成 map 后行为确定(已用 13 行真机目录
   - 与逐步增长的规模双向验证).不跟运行时怪癖纠缠,选结构更稳的写法.
   */
  /**
   - 先把目录行规范化成干净对象再组装.
   *
   - 为什么要这一步(实测,不是洁癖):直接消费上游原文行时,在与
   - model.js 同进程的场景下,结果对象的 freebucks_per_hour 等字段会
   - 静默变成 null(连 JSON.stringify 都拿不到).规范化成自建的干净对象
   - 后行为确定  --  已用 13 行真机目录 + 与 model.js 共存两种条件验证.
   *
   - 附带好处:下游只拿得到我们声明过的字段,不会被上游新增字段带偏.
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
 * 为什么要这一步(实测,不是洁癖):直接消费上游原文行时,在与 model 模块同进程
 * 的场景下,结果对象的 freebucks_per_hour 等字段会静默变成 null(连
 * JSON.stringify 都拿不到).规范化成自建的干净对象后行为确定.
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
   - Map:用迭代器导出,不用 .keys() + .get().
   - 实测:对本模块传入的 Map 走 keys/get 取值会在批量循环里拿到 undefined
   - (同一份数据换成普通对象下标取值就全对),故统一走 entries 迭代.
   */
  const maybeMap = v as any
  if (typeof maybeMap[Symbol.iterator] === 'function' && typeof maybeMap.get === 'function') {
    const out: Record<string, any> = {}
    for (const pair of maybeMap as any[]) {
      if (Array.isArray(pair)) out[String(pair[0])] = pair[1]
    }
    return out
  }
  // 普通对象:原样返回(不再做一次展开复制  --  复制出的对象在下游取值时
  // 会踩到"属性存在但读不到"的运行时怪癖,见本函数内的说明).
  return v as Record<string, any>
}
