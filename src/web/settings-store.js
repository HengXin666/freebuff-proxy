import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_SETTINGS = Object.freeze({
  freeToolSignatureEnabled: true,
  // 每个账号同一时间可并发的 SSE 响应流数（负载均衡），默认 1:1。
  // 单账号在途达到上限即"满了换号"：选号排序中满员账号排末尾，新请求优先去
  // 有空闲槽位的账号；只有所有账号都满员时才排队（有界等待）。
  accountMaxConcurrency: 1,
  // 免费模型暴力分散到不同账号（默认开）：不钉死热 session，请求轮转分散，
  // 单账号被占死不再拖垮全部请求，且多账号并行吞吐更高。
  spreadFreeModels: true,
  // 极简路由（路由模式）：代理侧改写请求注入 persona/首轮核心工具面/近距离引导。
  minimalRoutingEnabled: false,
  // 路由风格钉死：auto（按任务分类）/ spec（计划-集体，we/let's 链）/ react（执行者）/ weak（内部路由）。
  minimalRoutingMode: 'auto',
  // 路由实现风格：standard（标准模式，默认——flash 恒走 weak 内路由 + 深度引导
  // 静态并入 persona，多轮稳定；参考 v4-flash-godmode） / minimal（极简模式，
  // 按任务分类三带 persona）。性能不佳可一键切回 minimal 或关闭总开关。
  minimalRoutingStyle: 'standard',
})

const ROUTING_MODES = Object.freeze(['auto', 'spec', 'react', 'weak'])
const ROUTING_STYLES = Object.freeze(['standard', 'minimal'])

/** Frontend-managed runtime settings persisted under /data. */
export class SettingsStore {
  /** @param {string} file e.g. /data/settings.json */
  constructor(file) {
    this.file = file
    this.settings = { ...DEFAULT_SETTINGS }
    this.load()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (typeof raw?.freeToolSignatureEnabled === 'boolean') {
        this.settings.freeToolSignatureEnabled = raw.freeToolSignatureEnabled
      }
      if (Number.isInteger(raw?.accountMaxConcurrency)) {
        this.settings.accountMaxConcurrency = clampConcurrency(
          raw.accountMaxConcurrency,
        )
      }
      if (typeof raw?.spreadFreeModels === 'boolean') {
        this.settings.spreadFreeModels = raw.spreadFreeModels
      }
      if (typeof raw?.minimalRoutingEnabled === 'boolean') {
        this.settings.minimalRoutingEnabled = raw.minimalRoutingEnabled
      }
      if (ROUTING_MODES.includes(raw?.minimalRoutingMode)) {
        this.settings.minimalRoutingMode = raw.minimalRoutingMode
      }
      if (ROUTING_STYLES.includes(raw?.minimalRoutingStyle)) {
        this.settings.minimalRoutingStyle = raw.minimalRoutingStyle
      }
    } catch (err) {
      console.error(
        `settings store load failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  get() {
    return { ...this.settings }
  }

  /** @param {{ freeToolSignatureEnabled?: boolean, accountMaxConcurrency?: number }} next */
  save(next) {
    if (next?.freeToolSignatureEnabled !== undefined) {
      if (typeof next.freeToolSignatureEnabled !== 'boolean') {
        throw new TypeError('freeToolSignatureEnabled must be a boolean')
      }
      this.settings.freeToolSignatureEnabled = next.freeToolSignatureEnabled
    }
    if (next?.accountMaxConcurrency !== undefined) {
      if (
        !Number.isInteger(next.accountMaxConcurrency) ||
        next.accountMaxConcurrency < 1
      ) {
        throw new TypeError('accountMaxConcurrency must be an integer >= 1')
      }
      this.settings.accountMaxConcurrency = clampConcurrency(
        next.accountMaxConcurrency,
      )
    }
    if (next?.spreadFreeModels !== undefined) {
      if (typeof next.spreadFreeModels !== 'boolean') {
        throw new TypeError('spreadFreeModels must be a boolean')
      }
      this.settings.spreadFreeModels = next.spreadFreeModels
    }
    if (next?.minimalRoutingEnabled !== undefined) {
      if (typeof next.minimalRoutingEnabled !== 'boolean') {
        throw new TypeError('minimalRoutingEnabled must be a boolean')
      }
      this.settings.minimalRoutingEnabled = next.minimalRoutingEnabled
    }
    if (next?.minimalRoutingMode !== undefined) {
      if (!ROUTING_MODES.includes(next.minimalRoutingMode)) {
        throw new TypeError(
          `minimalRoutingMode must be one of ${ROUTING_MODES.join('/')}`,
        )
      }
      this.settings.minimalRoutingMode = next.minimalRoutingMode
    }
    if (next?.minimalRoutingStyle !== undefined) {
      if (!ROUTING_STYLES.includes(next.minimalRoutingStyle)) {
        throw new TypeError(
          `minimalRoutingStyle must be one of ${ROUTING_STYLES.join('/')}`,
        )
      }
      this.settings.minimalRoutingStyle = next.minimalRoutingStyle
    }
    const settings = { ...this.settings }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, ...settings }, null, 2),
      { mode: 0o600 },
    )
    fs.renameSync(tmp, this.file)
    this.settings = settings
    return this.get()
  }
}

/** 并发上限：1..16，防止误配造成上游顶号。 */
function clampConcurrency(n) {
  return Math.min(16, Math.max(1, n))
}

export { DEFAULT_SETTINGS }
