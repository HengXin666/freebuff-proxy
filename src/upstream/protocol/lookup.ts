/**
 * 目录索引的查询 -- CatalogHolder 的只读表查找.
 *
 * 这几张表(handles / displayNames / digestByKey)由 parse 与真源一次性建好,
 * 之后只被读.
 *
 * 边界: "上游 id 到目录 key"与它的 displayName 兜底留在真源文件
 * catalog-protocol.js -- test/verify-model-mapping-truth.mjs 的真源唯一性判据
 * 按路径核对 keyByDigest 的读写. 本文件只留不碰摘要索引的查询.
 * 摘要函数与映射所需的摘要值由调用方传入.
 */
import { isModelHandle } from './constants.ts'

/** 查询所需的索引集合(由真源与 parseCatalogBody 填充). */
export type CatalogIndex = {
  handles: Map<string, string>
  displayNames: Map<string, string>
  keyByName: Map<string, string>
  legacyIndex: Map<string, string>
  digestByKey: Map<string, string>
  rowByKey: Map<string, any>
}

/**
 * 目录 key 到可读显示名; 查不到返回 null(调用方回落到原 key).
 * @param {CatalogIndex} idx 索引
 * @param {string} key 目录 key
 * @returns {string | null} 显示名
 */
export function displayNameForKey(idx: CatalogIndex, key: string): string | null {
  if (typeof key !== 'string' || !key) return null
  return idx.displayNames.get(key) || null
}

/**
 * 目录 key 到 legacy 摘要(用于反查人类可读 id). 查不到返回 null.
 * @param {CatalogIndex} idx 索引
 * @param {string} key 目录 key
 * @returns {string | null} 摘要
 */
export function digestForKey(idx: CatalogIndex, key: string): string | null {
  if (typeof key !== 'string' || !key) return null
  return idx.digestByKey.get(key) || null
}

/**
 * 把一个模型标识映射成服务端句柄; 没有对应句柄时原样返回(legacy 路径).
 *
 * 接受的输入: m-xxxx(目录 key, 主路径) / fbm1.xxx(已是句柄) /
 * provider/name(legacy 模型 id). 真机证据: 官方 chat 的 model 是句柄,
 * 而会话回执给的是 key, 所以这层映射必须做.
 * @param {CatalogIndex} idx 索引
 * @param {string} modelId 模型标识
 * @param {(id: string) => string} digestOf 摘要函数(真源在 catalog-protocol.js)
 * @returns {string} 句柄; 命中不了原样返回 modelId
 */
export function handleFor(idx: CatalogIndex, modelId: string, digestOf: (id: string) => string): string {
  if (typeof modelId !== 'string' || !modelId) return modelId
  if (isModelHandle(modelId)) return modelId
  const byKey = idx.handles.get(modelId)
  if (byKey) return byKey
  const legacy = idx.legacyIndex.get(digestOf(modelId))
  if (legacy) return legacy
  return modelId
}

/**
 * 句柄映射的 displayName 兜底: 用完全一致的显示名反查 key, 再取句柄.
 *
 * 主服务 /v1/models 的 id 来自静态快照, 而目录是实时的, 两者会漂移:
 * 快照里的 deepseek/deepseek-v4.1-flash 在实时目录里的 legacyDigest 对应的是
 * deepseek/deepseek-v4-flash. 兜底只做这一件稳妥的事.
 * @param {CatalogIndex} idx 索引
 * @param {string} modelId legacy 模型 id
 * @param {string|null} [displayName] 静态快照里的可读名
 * @param {(name: string) => string|null} keyOf 由真源提供的 keyForName
 * @param {(id: string) => string} digestOf 摘要函数(真源在 catalog-protocol.js)
 * @returns {string} 句柄; 都命中不了则原样返回 modelId
 */
export function handleForModelWith(
  idx: CatalogIndex,
  modelId: string,
  displayName: string | null,
  keyOf: (name: string) => string | null,
  digestOf: (id: string) => string,
): string {
  const direct = handleFor(idx, modelId, digestOf)
  if (direct !== modelId) return direct
  if (!displayName) return modelId
  const key = keyOf(displayName)
  if (!key) return modelId
  return idx.handles.get(key) || modelId
}
