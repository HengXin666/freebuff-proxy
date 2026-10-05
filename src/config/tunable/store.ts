/**
 * 可调项的读写工具: 按点分路径取值/写值, 校验, 以及把 settings.json 合进 config.
 *
 * 三处共用(启动装配 / /api/settings 读写 / 门禁), 因此只在这里实现一次.
 * 真源与生效方式见 ./specs.ts 的文档注释.
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
 * 只判"类型 + 范围", 不猜意图: 非法值一律报错, 不静默纠正成默认值.
 * @param {TunableSpec} spec 项声明
 * @param {unknown} value 待校验值
 * @returns {string | null} 合法返回 null, 不合法时返回给用户看的错误文案
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
 * 逐条按可调项表校验后写进 config, 不改动 config 的读取点.
 *
 * 非法/未知键的处置:
 * - 未登记的路径一律忽略(不写进 config).
 * - 非法值回落 config 现值并在返回值里报回来.
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
 *
 * 凭据项(secret)的值一律不回: 这里直接写 null, 让[明文凭据绝不离开
 * 服务端]成为这一层的性质, 而不是靠每个调用方自觉屏蔽一次. 任何一个新加的
 * 快照消费方(日志导出 / 调试接口 / 未来的第三个前端)都不会漏掉这条.
 * 前端据值恒空 + secretsEffective() 的布尔渲染成[留空即不改]的密码框.
 *
 * 为什么不在前端屏蔽: 屏蔽留在响应体里就永远有一份明文在路上, 一次
 * 截图 / 一次浏览器插件 / 一次代理日志就够把它抄走. 屏蔽必须发生在真源.
 * @param {Record<string, any>} config 配置对象
 * @returns {Record<string, any>} 路径 → 值(凭据项恒为 null)
 */
export function snapshotTunables(config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const spec of TUNABLES) {
    out[spec.path] = spec.secret ? null : readPath(config, spec.path)
  }
  return out
}

/**
 * 把一份[路径 → 值]表里的凭据项抹成布尔(值换成 null).
 *
 * 任何要出网络的快照都必须过这一道: 包括 POST /api/settings 的回执
 * (它回的是刚写进盘的原值 ---- 不回抹的话, 用户刚填的那个 Key 会原样
 * 出现在响应体与任何记录响应的地方).
 * @param {Record<string, any>} values 路径 → 值
 * @returns {Record<string, any>} 抹掉凭据值后的副本
 */
export function redactTunables(values: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [path, value] of Object.entries(values || {})) {
    out[path] = specOf(path)?.secret ? null : value
  }
  return out
}

/**
 * 各凭据项[是否已设置] ---- 以盘上保存值为准的生效视图.
 *
 * 为什么不能只看 config: 可调项要重启才合并进 config, 所以用户刚在设置页
 * 保存一把 Key 之后, config 里还是旧值 ---- 只看 config 会让页面显示
 * "未设置", 与事实相反. 盘上保存过就以盘为准(它才是下次启动会生效的那份),
 * 没保存过才看 config(config.yaml / 环境变量里的现值).
 * @param {Record<string, any>} config 配置对象(启动时的当前生效值)
 * @param {Record<string, any>} saved settings.json 里已保存的可调项
 * @returns {Record<string, boolean>} 路径 → 是否已设置
 */
export function secretsEffective(
  config: Record<string, any>,
  saved: Record<string, any>,
): Record<string, boolean> {
  const values: Record<string, any> = {}
  for (const spec of TUNABLES) {
    if (!spec.secret) continue
    values[spec.path] = saved && spec.path in saved
      ? saved[spec.path]
      : readPath(config, spec.path)
  }
  return secretsFromValues(values)
}

/**
 * 各凭据项[是否已设置] ---- 从一块[路径 → 值]表上判(不做 readPath).
 *
 * POST /api/settings 的回执用它: 那一刻真值还在刚写盘的对象里, 而 config
 * 要等下次启动才合并.
 * @param {Record<string, any>} values 路径 → 值
 * @returns {Record<string, boolean>} 路径 → 是否已设置(判据 = 非空)
 */
export function secretsFromValues(values: Record<string, any>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const spec of TUNABLES) {
    if (!spec.secret) continue
    const v = values?.[spec.path]
    out[spec.path] = Array.isArray(v)
      ? v.length > 0
      : v !== null && v !== undefined && String(v).length > 0
  }
  return out
}
