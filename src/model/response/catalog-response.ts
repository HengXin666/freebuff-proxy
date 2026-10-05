/**
 * 内置模型的对外信息行.
 *
 * 这里是"目录 -> 对外模型信息"的投影, 与"清单里该有谁"(rows / isModelAllowed)
 * 是两个不同的判据. 惰性 Proxy 的行为约束见 FREEBUFF_AVAILABLE_MODELS 的注释.
 */
import { catalogModels } from '../catalog-store.ts'

/**
 * @typedef {import('../agents.ts').FreebuffModelInfo} FreebuffModelInfo
 */

/**
 * 目录模型 -> 对外模型信息行.
 * Regular Freebuff picker models + documented extras Agents may request.
 *
 * @returns {FreebuffModelInfo[]} 对外模型信息
 */
export function freebuffAvailableModels() {
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
 * @deprecated 用 freebuffAvailableModels()(惰性).保留为惰性 Proxy 以兼容
 * 既有 import 的调用点,不会在模块顶层读盘.
 */
export const FREEBUFF_AVAILABLE_MODELS: any[] = new Proxy([] as any[], {
  get(_t, prop) {
    const list = freebuffAvailableModels()
    const v = Reflect.get(list, prop)
    return typeof v === 'function' ? v.bind(list) : v
  },
  has(_t, prop) {
    return Reflect.has(freebuffAvailableModels(), prop)
  },
  ownKeys() {
    return Reflect.ownKeys(freebuffAvailableModels())
  },
  getOwnPropertyDescriptor(_t, prop) {
    return Reflect.getOwnPropertyDescriptor(freebuffAvailableModels(), prop)
  },
})
