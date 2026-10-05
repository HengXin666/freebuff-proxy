/**
 * 可调项的读写工具: 按点分路径取值/写值, 校验, 以及把 settings.json 合进 config.
 *
 * 三处共用(启动装配 / /api/settings 读写 / 门禁), 因此只在这里实现一次.
 * 见 ./tunables.ts 的文档注释(为什么要有可调项表, 以及生效方式是"保存后重启").
 */
import { TUNABLES, type TunableSpec } from './specs.ts'

/**
 * 按点分路径读值.
 * @param {any} obj 目标对象
 * @param {string} path 点分路径
 * @returns {any} 取到的值; 路径不存在时 undefined
 */
export function readPath(obj: any, path: string): any {
  let cur = obj
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

/**
 * 按点分路径写值(中间层缺失时补建普通对象).
 * @param {any} obj 目标对象(就地修改)
 * @param {string} path 点分路径
 * @param {any} value 待写入值
 * @returns {any} 同一个 obj
 */
export function writePath(obj: any, path: string, value: any): any {
  const segs = path.split('.')
  let cur = obj
  for (const seg of segs.slice(0, -1)) {
    if (cur[seg] === null || typeof cur[seg] !== 'object') cur[seg] = {}
    cur = cur[seg]
  }
  cur[segs[segs.length - 1]] = value
  return obj
}

/**
 * 按路径找可调项声明.
 * @param {string} path 点分路径
 * @returns {TunableSpec | undefined} 声明; 未登记时 undefined
 */
export function specOf(path: string): TunableSpec | undefined {
  return TUNABLES.find((t: TunableSpec) => t.path === path)
}

/**
 * 校验一个值是否符合该项声明.
 *
 * 只判"类型 + 范围", 不猜意图 ---- 把非法值静默纠正成默认值是这类接口最典型的
 * 事故(用户填了 9999 并发, 系统悄悄按 16 跑, 而界面显示 9999).
 * @param {TunableSpec} spec 项声明
 * @param {unknown} value 待校验值
 * @returns {string | null} 合法返回 null, 否则返回给用户看的错误文案
 */
export function validateValue(spec: TunableSpec, value: unknown): string | null {
  const label = spec.label
  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${label}必须是布尔值`
    case 'integer': {
      if (!Number.isInteger(value)) return `${label}必须是整数`
      const n = value as number
      if (spec.min !== undefined && n < spec.min) return `${label}不能小于 ${spec.min}`
      if (spec.max !== undefined && n > spec.max) return `${label}不能大于 ${spec.max}`
      return null
    }
    case 'string':
      // null 是合法的: defaultAdminPassword 的语义就是"null = 随机生成".
      return value === null || typeof value === 'string' ? null : `${label}必须是字符串或 null`
    case 'stringList':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : `${label}必须是字符串数组`
    case 'enum':
      return spec.values?.includes(value as string)
        ? null
        : `${label}必须是 ${spec.values?.join(' / ')} 之一`
    default:
      return `${label}的类型声明异常`
  }
}

/**
 * 把 settings.json 的已保存值合进 config(就地修改).
 *
 * ## 为什么是"合并进 config"而不是给每项写 getter
 *
 * 用户裁决生效方式是"保存后重启", 那么启动时把值写进 config 之后, 全仓
 * config.limits.xxx / config.session.xxx 的读取点一行都不用改,
 * 也不必为二十多个项各写一个 getter(那是二十多个可能忘改的地方).
 *
 * ## 非法/未知键的处置
 *
 * - 未知键一律忽略(不认识的路径不写进 config): 老版本 settings.json 里
 *   可能留着已删除的项, 忽略比崩溃或误写更安全.
 * - 非法值回落 config 现值(即 config.yaml / DEFAULTS 里的值)并报回来:
 *   静默纠正会让用户"设置了但没生效"却毫无线索.
 *
 * @param {Record<string, any>} config 配置对象(就地修改)
 * @param {Record<string, any>} saved settings.json 里读到的原始对象
 * @returns {{ applied: string[], rejected: Array<{path: string, reason: string}> }} 应用与拒绝明细
 */
export function applySavedSettings(
  config: Record<string, any>,
  saved: Record<string, any> | null,
): { applied: string[]; rejected: Array<{ path: string; reason: string }> } {
  const applied: string[] = []
  const rejected: Array<{ path: string; reason: string }> = []
  if (!saved || typeof saved !== 'object') return { applied, rejected }

  for (const [path, value] of Object.entries(saved)) {
    // settings.json 里带 version 之类的元字段, 不在可调项表里 -> 忽略.
    const spec = specOf(path)
    if (!spec) continue
    const err = validateValue(spec, value)
    if (err) {
      rejected.push({ path, reason: err })
      continue
    }
    writePath(config, path, value)
    applied.push(path)
  }
  return { applied, rejected }
}

/**
 * 从 config 抽出全部可调项的当前值(扁平对象).
 *
 * 前端设置页拿它渲染控件初值; /api/settings 的 GET 也用它.
 * @param {Record<string, any>} config 配置对象
 * @returns {Record<string, any>} 路径 → 值
 */
export function snapshotTunables(config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const spec of TUNABLES) out[spec.path] = readPath(config, spec.path)
  return out
}
