/**
 * 只读视图 -- 从 CatalogHolder 的取数方法按职责抽出.
 *
 * 这些方法全部是"读索引 + 排序 / 拼头", 不含任何可变状态写入, 所以与
 * 查询函数分开放: 查询回答"某个标识对应什么", 视图回答"整体长什么样".
 */
import {
  CATALOG_PROTOCOL_VERSION,
  HEADER_CATALOG_FETCH,
  HEADER_CATALOG_PROTOCOL,
} from './constants.ts'

/**
 * 目录行全量(模型清单的权威), 按 sortOrder 升序.
 * 每行是服务端原文, 调用方直接读 displayName / premium / access 等字段,
 * 不要再从内置静态 catalog 反查(那份是 2026-08 快照, 13 行只命中 3 行).
 * @param {Map<string, any>} rowByKey 目录行索引
 * @returns {any[]} 目录行(已排序)
 */
export function rowsOf(rowByKey: Map<string, any>): any[] {
  return [...rowByKey.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
}

/**
 * 单个目录行(原文). 查不到返回 null.
 * @param {Map<string, any>} rowByKey 目录行索引
 * @param {string} key 目录 key
 * @returns {any|null} 目录行
 */
export function rowOf(rowByKey: Map<string, any>, key: string): any | null {
  return rowByKey.get(key) || null
}

/**
 * 目录相关的两个头(未持有时返回空对象, 让调用方走 legacy).
 * @param {string|null} fetchId 目录 fetchId
 * @returns {Record<string, string>} 头集
 */
export function headersOf(fetchId: string | null): Record<string, string> {
  if (typeof fetchId !== 'string' || !fetchId) return {}
  return {
    [HEADER_CATALOG_PROTOCOL]: CATALOG_PROTOCOL_VERSION,
    [HEADER_CATALOG_FETCH]: fetchId,
  }
}

/**
 * 只给 x-freebuff-catalog-fetch, 不给 -protocol.
 *
 * 官方 chat 头部恒为 8 项(抓包 8 个样本 diff 为空集):
 * Authorization / Content-Type / 三段 UA / acting-user-id /
 * catalog-fetch / device-key / device-sig / device-ts
 * 没有 catalog-protocol -- 它只出现在 catalog 与 admission 上.
 * 见 docs/reverse/15-protocol-review.md P0-1.
 * @param {string|null} fetchId 目录 fetchId
 * @returns {Record<string, string>} 头集
 */
export function fetchOnlyHeadersOf(fetchId: string | null): Record<string, string> {
  if (typeof fetchId !== 'string' || !fetchId) return {}
  return { [HEADER_CATALOG_FETCH]: fetchId }
}
