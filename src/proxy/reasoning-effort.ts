/**
 * 思考强度(reasoning effort)覆盖: 从运行设置解析出本次请求要强制使用的档位.
 *
 * 档位枚举与[每模型可用的档位]来源见 docs/reverse/05-thinking-effort.md; 覆盖的
 * 落点与实现取舍见
 * .agents/notes/implemented/feature/2026-10-06-reasoning-effort-override.md.
 */
import { logger } from '../util/log.ts'

/** 上游认识的思考档位(官方 REASONING_EFFORTS). */
export const REASONING_EFFORTS = Object.freeze([
  'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
])

/** 运行设置里 reasoningOverride 字段的形态: 开关 + 逐模型档位. */
export interface ReasoningOverride {
  /** 是否启用覆盖. */
  enabled: boolean
  /** 逐模型的强制档位(model 为目录 key 或可读模型名). */
  models: Array<{ model: string, effort: string }>
}

/** 未配置时的默认值: 关闭 + 空表(不改变任何出站形态). */
export const DEFAULT_REASONING_OVERRIDE: ReasoningOverride = Object.freeze({
  enabled: false,
  models: [],
})

/**
 * 该值是否是上游认识的一个档位.
 * @param {unknown} value 待判定值
 * @returns {boolean} 命中为真
 */
export function isReasoningEffort(value: unknown): boolean {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value)
}

/**
 * 归一化运行设置里的 reasoningOverride 字段.
 *
 * 只接受合法档位与非空模型名, 非法项直接丢弃(不猜也不纠正成默认档位).
 * @param {any} raw 盘上或请求里的原值
 * @returns {ReasoningOverride} 归一后的对象
 */
export function normalizeReasoningOverride(raw: any): ReasoningOverride {
  const enabled = raw?.enabled === true
  const models: Array<{ model: string, effort: string }> = []
  const seen = new Set<string>()
  for (const item of Array.isArray(raw?.models) ? raw.models : []) {
    const model = typeof item?.model === 'string' ? item.model.trim() : ''
    const effort = isReasoningEffort(item?.effort) ? String(item.effort) : null
    if (!model || !effort || seen.has(model.toLowerCase())) continue
    seen.add(model.toLowerCase())
    models.push({ model, effort })
  }
  return { enabled, models }
}

/**
 * 该值是否是合法的 reasoningOverride 形态(路由层校验用).
 * @param {any} raw 待校验值
 * @returns {boolean} 合法为真
 */
export function isReasoningOverrideShape(raw: any): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  if (typeof raw.enabled !== 'boolean') return false
  if (!Array.isArray(raw.models)) return false
  return raw.models.every((item: any) => item && typeof item === 'object'
    && typeof item.model === 'string' && item.model.trim().length > 0
    && isReasoningEffort(item.effort))
}

/**
 * 目录 key 归一: 把任一形式的模型标识落回目录 key; 目录未就绪时返回 null.
 * @param {any} catalog 目录持有者
 * @param {any} name 模型标识
 * @returns {string|null} 目录 key
 */
function catalogKeyOf(catalog: any, name: any): string | null {
  if (typeof name !== 'string' || !name) return null
  if (typeof catalog?.keyForName !== 'function') return null
  try {
    const key = catalog.keyForName(name)
    return typeof key === 'string' && key ? key : null
  } catch {
    return null
  }
}

/**
 * 解析本次请求要强制使用的思考档位.
 *
 * 命中行已声明 efforts 且不含该档位时不覆盖(有正面证据说明该模型不支持);
 * 未声明 efforts 或查不到该行时照配置发(用户显式指定, 判定权留给上游).
 * @param {any} settings settingsStore.get() 的结果
 * @param {any} catalog 目录持有者(只用于把模型标识归一到目录 key)
 * @param {any} modelIds 本次请求已知的模型标识(会话指派值 / 请求值 / 上线值)
 * @returns {{ model: string, effort: string, declared: boolean } | null} 命中项;未命中为 null
 */
export function resolveForcedEffort(settings: any, catalog: any, modelIds: any) {
  const cfg = normalizeReasoningOverride(settings?.reasoningOverride)
  if (!cfg.enabled || cfg.models.length === 0) return null
  const ids = (Array.isArray(modelIds) ? modelIds : [modelIds])
    .filter((id: any) => typeof id === 'string' && id)
  const keys = new Set<string>()
  for (const id of ids) {
    const key = catalogKeyOf(catalog, id)
    if (key) keys.add(key)
  }
  for (const entry of cfg.models) {
    const entryKey = catalogKeyOf(catalog, entry.model)
    const hit = ids.includes(entry.model) || (entryKey !== null && keys.has(entryKey))
    if (!hit) continue
    const row = entryKey !== null && typeof catalog?.row === 'function' ? catalog.row(entryKey) : null
    const declared = Array.isArray(row?.efforts) && row.efforts.length ? row.efforts : null
    if (declared && !declared.includes(entry.effort)) {
      logger.warn('reasoning effort override skipped: model does not declare it', {
        model: entry.model,
        key: entryKey,
        effort: entry.effort,
        efforts: declared,
      })
      continue
    }
    return { model: entryKey || entry.model, effort: entry.effort, declared: Boolean(declared) }
  }
  return null
}

/**
 * 把强制档位写进出站体: 清掉顶层 reasoning_effort, 只留一个 reasoning.effort.
 * @param {any} body 出站请求体
 * @param {string} effort 强制档位
 * @returns {any} 写入后的新体
 */
export function applyForcedEffort(body: any, effort: string): any {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  delete out.reasoning_effort
  out.reasoning = {
    ...(out.reasoning && typeof out.reasoning === 'object' ? out.reasoning : {}),
    effort,
  }
  return out
}
