/**
 * 目录响应体的纯解析 -- CatalogHolder._apply 的实现.
 *
 * 只做"取 fetchId / 建索引 / 记版本字段"三件事, 不碰 this, 可被单独喂样本断言.
 *
 * 边界: legacy 摘要索引(摘要到 key / 摘要到句柄)与 keyForName 留在真源文件
 * catalog-protocol.js -- 真源唯一性判据要求上游 id 到目录 key 的实现只存在于真源.
 *
 * 解析顺序与覆盖规则逐字保留(顺序会影响"同名不同 key 时谁生效", 属行为).
 */
import { isModelHandle } from './constants.ts'

/**
 * 取目录行数组(响应字段是 rows, 不是 models / data).
 * @param {any} body 目录响应原文
 * @returns {any[]} 目录行数组
 */
function rowsOf(body: any): any[] {
  return Array.isArray(body?.rows) ? body.rows : Array.isArray(body?.models) ? body.models : []
}

/**
 * 建 key 到句柄 / 目录行原文 / 显示名的三张表.
 *
 * 目录行全量留档: 模型清单的权威是 rows(13 行), 而会话回执的
 * rateLimitsByModel 只有 6 个键 -- 用后者当清单会漏掉一半以上模型.
 * @param {any[]} rows 目录行
 * @returns {{handles: Map<string,string>, displayNames: Map<string,string>,
 *   keyByName: Map<string,string>, rowByKey: Map<string,any>}} 四张表
 */
function indexRows(rows: any[]) {
  const handles = new Map()
  const displayNames = new Map()
  const keyByName = new Map()
  const rowByKey = new Map()
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue
    const key = m.key
    const handle = m.handle
    if (typeof handle === 'string' && isModelHandle(handle)) {
      if (typeof key === 'string') handles.set(key, handle)
    }
    if (typeof key === 'string' && key) rowByKey.set(key, m)
    if (typeof key === 'string' && typeof m.displayName === 'string' && m.displayName) {
      displayNames.set(key, m.displayName)
      // 反向: 显示名到 key. 下游照着 display_name 填 model 时用它落回服务端
      // 认的口径(key); 裸显示名发给上游会被拒.
      const name = m.displayName.trim()
      if (name && !keyByName.has(name)) keyByName.set(name, key)
      if (name && !keyByName.has(name.toLowerCase())) {
        keyByName.set(name.toLowerCase(), key)
      }
    }
  }
  return { handles, displayNames, keyByName, rowByKey }
}

/**
 * 解析一份目录响应.
 * @param {any} body 目录响应原文
 * @returns {{ok: boolean, fetchId?: string, handles?: Map<string,string>,
 *   displayNames?: Map<string,string>, keyByName?: Map<string,string>,
 *   rowByKey?: Map<string,any>, recommendedKey?: string|null, fallbackKey?: string|null,
 *   issuedAt?: number|null, refreshAt?: number|null, version?: string|null}}
 *   解析结果; ok=false 表示缺 fetchId
 */
export function parseCatalogBody(body: any) {
  const fetchId = body && (body.fetchId || body.catalogFetchId)
  if (typeof fetchId !== 'string' || !fetchId) return { ok: false }
  const rows = rowsOf(body)
  const rowsIndex = indexRows(rows)
  return {
    ok: true,
    fetchId,
    ...rowsIndex,
    recommendedKey: typeof body?.recommendedKey === 'string' ? body.recommendedKey : null,
    fallbackKey: typeof body?.fallbackKey === 'string' ? body.fallbackKey : null,
    issuedAt: Number.isFinite(body?.issuedAt) ? body.issuedAt : null,
    refreshAt: Number.isFinite(body?.refreshAt) ? body.refreshAt : null,
    version: typeof body?.version === 'string' ? body.version : null,
  }
}
