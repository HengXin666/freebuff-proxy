/**
 * 配置合并原语:纯对象判定,键归一,深拷贝,深合并.
 *
 * 全部是纯函数(无 IO),因此可以单独测试.deepMerge 的深拷贝不是优化
 * 而是正确性要求(历史 bug:浅拷贝让 DEFAULTS 被污染).
 *
 * 从 src/config.js 拆出(原 446 行单文件).
 */
import { DROPPED_KEYS, KEY_MAP } from './defaults.ts'

/**
 * 判定是否"纯对象"(非 null,非数组).
 *
 * @param {unknown} value 待判定值
 * @returns {boolean} true 表示可直接做键遍历合并
 */
export function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 深拷贝纯对象/数组(DEFAULTS 只含 JSON 可表达的值).
 *
 * @param {any} value 任意值
 * @returns {any} 深拷贝结果(原始值原样返回)
 */
export function clonePlain(value: any): any {
  if (Array.isArray(value)) return value.map(clonePlain)
  if (isPlainObject(value)) {
    /** @type {Record<string, any>} */
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) out[k] = clonePlain(v)
    return out
  }
  return value
}

/**
 * YAML snake_case → camelCase,并丢弃已知废弃键.
 *
 * 未知键保留原样(不静默吞掉),这样新增配置项不会因为漏登记 KEY_MAP
 * 而"看起来写了但没生效".
 *
 * @param {any} input YAML 解析结果
 * @returns {any} 键归一后的结构
 */
export function normalizeKeys(input: any): any {
  if (Array.isArray(input)) return input.map(normalizeKeys)
  if (!isPlainObject(input)) return input
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(input)) {
    if (Object.prototype.hasOwnProperty.call(KEY_MAP, key)) {
      out[KEY_MAP[key]] = normalizeKeys(value)
      continue
    }
    // Drop known-removed dual-track keys silently
    if (DROPPED_KEYS.includes(key)) continue
    out[key] = normalizeKeys(value)
  }
  return out
}

/**
 * 深合并:override 覆盖 base.
 *
 * 必须深拷贝 base(历史 bug):旧实现用 { ...base } 浅拷贝,当 override 为
 * 空(没有 config.yaml 时 fileConfig = {})嵌套的 session/limits/web/upstream
 * 就与全局 DEFAULTS 共享同一个对象引用.任何一处 config.session.xxx = y
 * 都会污染 DEFAULTS,污染进程内后续所有 loadConfig() 结果(测试套件之间互相串味,
 * 表现为莫名其妙的 "fetch failed" / no_available_account).有 config.yaml 时因为
 * 递归到嵌套键恰好新建了对象,所以才"看起来正常" -- 这个 bug 因此潜伏了很久.
 *
 * @param {any} base 基底
 * @param {any} override 覆盖值
 * @returns {any} 合并结果(与两个入参都不共享引用)
 */
export function deepMerge(base: any, override: any): any {
  if (!isPlainObject(override)) return clonePlain(base)
  const out: Record<string, any> = clonePlain(base)
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else if (value !== undefined) {
      out[key] = clonePlain(value)
    }
  }
  return out
}

/**
 * 去掉 URL 末尾斜杠.
 *
 * @param {any} url URL 字符串
 * @returns {string} 去尾斜杠结果
 */
export function stripTrailingSlash(url: any): string {
  return String(url || '').replace(/\/+$/, '')
}
