/**
 * 官方工具参数形态 -> 下游工具参数形态的翻译.
 *
 * 为什么需要: 下行把下游工具名映射成官方等价名(bash -> run_terminal_command,
 * read -> read_files), 上游按官方 schema 生成 tool_call. 回程只把名字还原成
 * 下游名是不够的 ---- 参数仍是官方形态, 下游按自己的 schema 解析必然报错.
 *
 * 线上实测(2026-10-05, 远程 2.2.0, 带 tools 的真实请求):
 *   {"name":"read","arguments":"{\"paths\":[\"src/index.ts\"]}"}
 * 下游 dsh 的 read 只认 file_path -> invalid arguments: missing required
 * property "file_path". 本地会话记录里这一类共 4 条, 另有 edit 的
 * old_string was not found(同样成因: 官方对应物是 replacements[].oldString).
 *
 * 判据来源: 官方 schema 取 docs/reverse/captures/official-tools.json,
 * 下游 schema 取调用方本次声明(dsh 的 read / edit / write / bash / grep).
 *
 * 规则数据(接口 + PARAM_RULES 表)已按 300 行上限切到 ./tools/param-rules.ts;
 * 本文件只剩翻译引擎(按规则改参数并裁剪). 语义零改动.
 *
 * 三条纪律:
 *   1. 没有规则的组合一律返回 null, 调用方原样保留参数 ----
 *      宁可下游看到陌生的官方字段, 也不要被错误规则改坏.
 *   2. 翻译后按下游 schema 的 properties 裁剪, 丢掉下游不认识的多余字段.
 *   3. 下游 schema 要求而官方没有的字段(如 bash 的 description), 由 rules 里的
 *      synth 兜底补上 ---- 否则回程调用仍会被下游判为参数缺失.
 */

import { PARAM_RULES } from './tools/param-rules.ts'

export { PARAM_RULES } from './tools/param-rules.ts'
export type { FieldRule, ParamRule } from './tools/param-rules.ts'

/**
 * 该下游工具名是否有参数翻译规则.
 *
 * 给流式回程用: 没有规则的工具名(55 个里的大多数)完全不该被缓冲,
 * 直接透传即可. 缓冲只在"确有规则且参数还没构齐"时才发生.
 *
 * @param {unknown} clientName 下游工具名
 * @returns {boolean} 有规则为真
 */
export function hasParamRule(clientName: unknown): boolean {
  return typeof clientName === 'string' && Object.prototype.hasOwnProperty.call(PARAM_RULES, clientName)
}

/**
 * 把官方形态的 tool_call 参数翻译成下游形态.
 *
 * @param {any} clientName 还原后的下游工具名
 * @param {any} argsText 官方形态的参数 JSON 文本
 * @param {any} [clientSchema] 下游本次为该工具声明的 parameters(用于裁剪)
 * @returns {string | null} 翻译后的 JSON 文本; 无规则/解析失败/无需翻译时返回 null
 */
export function translateParamsForDownstream(
  clientName: any,
  argsText: any,
  clientSchema?: any,
): string | null {
  if (typeof clientName !== 'string' || typeof argsText !== 'string' || !argsText) return null
  const rule = PARAM_RULES[clientName]
  if (!rule) return null
  let src: any
  try {
    src = JSON.parse(argsText)
  } catch {
    return null
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null
  const out: Record<string, any> = {}
  for (const [from, fieldRule] of Object.entries(rule.fields)) {
    if (!(from in src)) continue
    const value = src[from]
    const target = fieldRule.to || from
    if (typeof fieldRule.get !== 'function') {
      if (value !== undefined) out[target] = value
      continue
    }
    const converted = fieldRule.get(value, src)
    if (converted === undefined || converted === null) continue
    if (fieldRule.flatten && typeof converted === 'object' && !Array.isArray(converted)) {
      // 对象值摊平成顶层键(edit 的 replacements[0]).
      Object.assign(out, flattenObject(converted))
      continue
    }
    out[target] = converted
  }
  // 下游必填而官方没有的字段: 合成. 只在下游 schema 真的要求它时才补.
  for (const [key, make] of Object.entries(rule.synth || {})) {
    if (out[key] !== undefined) continue
    if (!requiresField(clientSchema, key)) continue
    const value = make(src)
    if (value !== undefined && value !== null) out[key] = value
  }
  /**
   * 旁路保留: 上游参数里[已经是下游形态]的字段, 规则没消费也要留下.
   *
   * 为什么必须有(2026-10-06 实测): 上游偶尔直接回下游 schema 的字段名
   * (回程链路不是每次都能保证是官方形态). write_file 的规则只认 path,
   * 于是 {"file_path":"a.txt","content":"hi"} 会被翻成 {"content":"hi"} ----
   * file_path 落在 src 里没人接, 下游 required 校验直接失败.
   *
   * 判据是[下游 schema 声明过这个键], 不是[规则里没有] ---- 只放行下游自己
   * 认识的字段, 不把上游的多余字段泄给下游.
   */
  for (const [key, value] of Object.entries(src)) {
    if (out[key] !== undefined) continue
    // 规则已消费的源字段不得回头再加一遍(否则官方名与下游名会同时出现).
    if (key in rule.fields) continue
    if (!declaresField(clientSchema, key)) continue
    out[key] = value
  }
  if (Object.keys(out).length === 0) return null
  return JSON.stringify(applySchemaKeys(out, clientSchema))
}

/**
 * 下游 schema 是否声明过该字段(properties 里出现).
 *
 * 与 requiresField 的区别: 这个只管[认识], 不管[必填] ---- 旁路保留放行的
 * 是下游自己知道的键, 包括可选字段(offset / limit / workdir 之类).
 *
 * @param {any} schema 下游工具的 parameters
 * @param {string} key 字段名
 * @returns {boolean} 声明过则为真
 */
function declaresField(schema: any, key: string): boolean {
  const props = schema?.properties
  return Boolean(props && typeof props === 'object' && key in props)
}

/**
 * 下游 schema 是否把该字段列为必填.
 *
 * @param {any} schema 下游工具的 parameters
 * @param {string} key 字段名
 * @returns {boolean} 必填则为真
 */
function requiresField(schema: any, key: string): boolean {
  const required = schema?.required
  return Array.isArray(required) && required.includes(key)
}

/**
 * 官方字段值是对象时, 把它摊平成顶层键(edit 的 replacements[0] 用).
 *
 * @param {any} obj 官方侧的对象值
 * @returns {Record<string, any>} 摊平后的字段
 */
function flattenObject(obj: any): Record<string, any> {
  const map: Record<string, string> = {
    oldString: 'old_string',
    newString: 'new_string',
    allowMultiple: 'replace_all',
    path: 'file_path',
    offset: 'offset',
    limit: 'limit',
  }
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    const to = map[k]
    if (to && v !== undefined) out[to] = v
  }
  return out
}

/**
 * 按下游 schema 的 properties 裁剪键.
 *
 * 下游普遍声明 additionalProperties: false, 多一个键就整条被判非法.
 * 拿不到 schema 时不裁剪(返回原对象).
 *
 * @param {Record<string, any>} obj 待裁剪字段
 * @param {any} schema 下游工具的 parameters
 * @returns {Record<string, any>} 裁剪后的字段
 */
function applySchemaKeys(obj: Record<string, any>, schema: any): Record<string, any> {
  const props = schema?.properties
  if (!props || typeof props !== 'object') return obj
  const allowed = new Set(Object.keys(props))
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (allowed.has(k)) out[k] = v
  }
  return Object.keys(out).length > 0 ? out : obj
}
