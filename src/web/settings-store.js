import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_SETTINGS = Object.freeze({
  freeToolSignatureEnabled: true,
  // 每个账号同一时间可并发的 SSE 响应流数（账号内负载均衡），默认 1:1。
  // 单账号在途达到上限即"满了换号"：选号排序中满员账号排末尾，新请求优先去
  // 有空闲槽位的账号；只有所有账号都满员时才排队（有界等待）。
  accountMaxConcurrency: 1,
  // 平摊请求的账号数上限（账号间负载均衡）：并发请求最多同时铺开 N 个账号
  // 消费会话——账号并发没满时新请求可以直接开新账号，而不是钉在已有账号上
  // 排队；所有模型统一生效（不再区分免费/付费分散开关）。
  spreadAccounts: 3,
  // 极简路由（路由模式）：代理侧改写请求注入 persona/首轮核心工具面/近距离引导。
  minimalRoutingEnabled: false,
  // 路由风格钉死：auto（按任务分类）/ spec（计划-集体，we/let's 链）/ react（执行者）/ weak（内部路由）。
  minimalRoutingMode: 'auto',
  // 路由实现风格：standard（标准模式，默认——flash 恒走 weak 内路由 + 深度引导
  // 静态并入 persona，多轮稳定；参考 v4-flash-godmode） / minimal（极简模式，
  // 按任务分类三带 persona）。性能不佳可一键切回 minimal 或关闭总开关。
  minimalRoutingStyle: 'standard',
  // 一键屏蔽收费模型（pool=premium，如 gpt-5.6-luna / kimi-k3-eco / 各 -max）。
  // 免费反代用户用不了收费模型，放着在列表里既占位又容易误触风控——开/关由
  // 前端「模型管理」一键切换：开启则从 /v1/models 列表和调度（白名单）彻底排除。
  // 默认关闭以保持升级不改变现有行为；免费反代场景建议开启。
  blockPremiumModels: false,
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
      if (Number.isInteger(raw?.spreadAccounts)) {
        this.settings.spreadAccounts = clampSpread(
          raw.spreadAccounts,
        )
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
      if (typeof raw?.blockPremiumModels === 'boolean') {
        this.settings.blockPremiumModels = raw.blockPremiumModels
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
    if (next?.spreadAccounts !== undefined) {
      if (!Number.isInteger(next.spreadAccounts) || next.spreadAccounts < 1) {
        throw new TypeError('spreadAccounts must be an integer >= 1')
      }
      this.settings.spreadAccounts = clampSpread(next.spreadAccounts)
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
    if (next?.blockPremiumModels !== undefined) {
      if (typeof next.blockPremiumModels !== 'boolean') {
        throw new TypeError('blockPremiumModels must be a boolean')
      }
      this.settings.blockPremiumModels = next.blockPremiumModels
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

/** 平摊账号数：1..16（实际受账号总数约束，运行时再 clamp）。 */
function clampSpread(n) {
  return Math.min(16, Math.max(1, n))
}

export { DEFAULT_SETTINGS }
