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
 * 三条纪律:
 *   1. 没有规则的组合一律返回 null, 调用方原样保留参数 ----
 *      宁可下游看到陌生的官方字段, 也不要被错误规则改坏.
 *   2. 翻译后按下游 schema 的 properties 裁剪, 丢掉下游不认识的多余字段.
 *   3. 下游 schema 要求而官方没有的字段(如 bash 的 description), 由 rules 里的
 *      synth 兜底补上 ---- 否则回程调用仍会被下游判为参数缺失.
 */

/** 一个字段级翻译规则. */
interface FieldRule {
  /** 官方字段名 -> 下游字段名. 省略表示同名. */
  to?: string
  /** 自定义取值(返回值 undefined 表示不产出该字段). */
  get?: (value: any, src: any) => any
  /** 取到的值是对象时是否摊平成顶层键(edit 的 replacements[0] 用). */
  flatten?: boolean
}

/** 单条工具的参数翻译规则. */
interface ParamRule {
  /** 官方字段名 -> 规则. 未列出的官方字段一律丢弃. */
  fields: Record<string, FieldRule>
  /** 下游必填但官方 schema 里没有的字段: 名字 -> 由整份官方参数合成. */
  synth?: Record<string, (src: any) => any>
}

/**
 * 下游工具名 -> 参数翻译规则.
 *
 * 只列形态确实不同的组合; 同形的(ask_questions / write_todos)不在这里.
 */
const PARAM_RULES: Record<string, ParamRule> = {
  /** read_files(paths: (string | {path,offset,limit})[]) -> read(file_path, offset?, limit?). */
  read: {
    fields: {
      // paths 是数组, 下游是单文件: 取第一条. 元素是对象时整条摊平(带 offset/limit).
      paths: {
        to: 'file_path',
        flatten: true,
        get: (paths: any) => (Array.isArray(paths) ? paths[0] : paths),
      },
    },
  },
  /** str_replace(path, replacements[]) -> edit(file_path, old_string, new_string, replace_all?). */
  edit: {
    fields: {
      path: { to: 'file_path' },
      replacements: {
        flatten: true,
        get: (reps: any) => (Array.isArray(reps) ? reps[0] : reps),
      },
    },
  },
  /** write_file(path, instructions, content) -> write(file_path, content). */
  write: {
    fields: { path: { to: 'file_path' }, content: { to: 'content' } },
  },
  /**
   * run_terminal_command(command, cwd?, timeout_seconds?) -> bash(command, description, workdir?, timeoutMs?).
   *
   * description 是下游的必填项而官方没有对应字段(官方把意图放在工具调用外层),
   * 用 command 原文合成一句, 保证下游 required 校验能过.
   */
  bash: {
    fields: {
      command: { to: 'command' },
      cwd: { to: 'workdir' },
      timeout_seconds: {
        to: 'timeoutMs',
        get: (v: any) => (typeof v === 'number' ? v * 1000 : undefined),
      },
    },
    synth: {
      description: (src: any) =>
        typeof src?.command === 'string' && src.command
          ? `run: ${src.command}`
          : 'run command',
    },
  },
  /** code_search(pattern, cwd?) -> grep(pattern, path?). */
  grep: {
    fields: { pattern: { to: 'pattern' }, cwd: { to: 'path' } },
  },
  /** list_directory(path) -> ls(path). */
  ls: { fields: { path: { to: 'path' } } },
  /** read_url(url, max_chars?) -> web_fetch(url). */
  web_fetch: { fields: { url: { to: 'url' } } },
  /**
   * 同名工具的形态差异: 官方 glob(pattern, cwd?, max_results?) ->
   * 下游 glob(pattern, path?). 名字相同但参数名不同, 同样必须翻译.
   */
  glob: {
    fields: { pattern: { to: 'pattern' }, cwd: { to: 'path' } },
  },
  /** web_search(query, depth?) -> web_search(queries: string[]). */
  web_search: {
    fields: {
      query: { to: 'queries', get: (q: any) => (q == null ? undefined : [String(q)]) },
    },
  },
}

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
  if (Object.keys(out).length === 0) return null
  return JSON.stringify(applySchemaKeys(out, clientSchema))
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
