/**
 * 目录协议的常量与头名真值 -- 从 catalog-protocol.js 按职责切出.
 *
 * 为什么单独成文件: 真源文件 catalog-protocol.js 里的 CatalogHolder 与本目录
 * 下的 parse / fetch / views 都要用这些常量. 如果它们留在真源文件里, 就会
 * 形成 catalog-protocol.js 到 parse.ts 再到 catalog-protocol.js 的循环 import.
 * 切出来之后依赖是单向的: constants <- {parse, fetch, views} <- catalog-protocol.
 *
 * 口径: 纯搬移. 真源文件仍然 re-export 这些名字, 外部消费者无需改动.
 */

/** 官方常量真值(common/src/types/freebuff-model-catalog.ts). */
export const CATALOG_PATH = '/api/v1/freebuff/models'
export const HEADER_CATALOG_PROTOCOL = 'x-freebuff-catalog-protocol'
export const CATALOG_PROTOCOL_VERSION = '1'
export const HEADER_CATALOG_FETCH = 'x-freebuff-catalog-fetch'
export const MODEL_HANDLE_PREFIX = 'fbm1.'

/**
 * 官方 catalog 抓取的客户端头(抓包真值).
 * 官方 fetchOnce() 只在 catalog 这一跳同时带 protocol + client 两件套,
 * 其余头一概不带(见 docs/reverse/19 §19.2).
 */
export const HEADER_CLIENT = 'x-freebuff-client'
export const CLIENT_DESKTOP = 'desktop'
/** 官方 orchestrator 由 bun 执行,bun 的裸 fetch 默认 UA 就是它. */
export const CATALOG_FETCH_USER_AGENT = 'Bun/1.4.2'

/**
 * 判断一个字符串是不是目录模型句柄(fbm1. 前缀).
 * @param {unknown} value 待判断值
 * @returns {boolean} 是句柄则为真
 */
export function isModelHandle(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(MODEL_HANDLE_PREFIX)
}
