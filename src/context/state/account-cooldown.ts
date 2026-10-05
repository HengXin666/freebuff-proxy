/**
 * 账号 / 模型的冷却账: 记冷却, 查冷却, 落盘.
 *
 * 从 app-context.js 按职责切出. 冷却分两档(账号级 key, 模型级 key + NUL + model),
 * 判据码表在 ./codes.ts. 这里只碰冷却表与账本, 不碰会话与网络.
 * @param {any} this 账号池(runtimes)
 * @returns {any} 见实现
 */
import { logger } from '../../util/log.js'
import {
  ACCOUNT_COOLDOWN_CODES,
  BANNED_COOLDOWN_MS,
  DAY_MS,
  DEFAULT_COOLDOWN_MS,
} from './codes.ts'

/**
 * 冷却表的键: 账号级用 key, 模型级用 key + NUL + model.
 *
 * 用 NUL 而不是其他分隔符: 账号 key 可能是邮箱, 任何可见字符都可能出现在里面.
 * @param {any} this 账号池(runtimes)
 * @param {string} key 账号 key
 * @param {string | null} model 模型(为真时返回模型级键)
 * @returns {string} 冷却表键
 */
export function _cooldownKey(this: any, key: any, model: any) {
  return model ? `${key}\0${model}` : key
}

/**
 * Account-level OR (if model given) model-level cooldown blocks selection.
 * @param {any} this 账号池(runtimes)
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @param {string | null} [model]
 * @returns {any} 见实现
 */
export function isCoolingDown(this: any, key: any, model: any = null) {
  this._pruneCooldown(key)
  if (this.cooldowns.has(key)) return true
  if (model) {
    const k = this._cooldownKey(key, model)
    this._pruneCooldown(k)
    if (this.cooldowns.has(k)) return true
  }
  return false
}

/**
 * 丢弃已到期的冷却条目.
 * @param {any} this 账号池(runtimes)
 * @param {string} key 冷却表键
 * @returns {void}
 */
export function _pruneCooldown(this: any, key: any) {
  const cd = this.cooldowns.get(key)
  if (cd && cd.until <= Date.now()) this.cooldowns.delete(key)
}

/**
 * @param {any} this 账号池(runtimes)
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @param {import('./upstream/client.js').UpstreamError | { code?: string, retryAfterMs?: number }} err
 * @param {string | null} [model]
 */
export function markCooldown(this: any, key: any, err: any, model: any = null) {
  const code = err?.code
  let ms =
    typeof err?.retryAfterMs === 'number' && err.retryAfterMs > 0
      ? err.retryAfterMs
      : DEFAULT_COOLDOWN_MS

  if (code === 'banned') {
    ms = Math.max(ms, BANNED_COOLDOWN_MS)
    // 封禁是账号生命周期的终点:不只冷却,还要记下"什么时候开始被封的"
    // (chat 阶段撞到 banned 与探测发现 banned 同等重要,控制台分区靠它).
    const rec = this.accountState.account(key, this._importedAtHint(key))
    if (rec && !rec.bannedAt) {
      this.accountState.patch(key, { bannedAt: new Date().toISOString() })
    }
  }

  // model_unavailable / similar: only block that model on this account
  const perModel =
    code === 'model_unavailable' && model && !ACCOUNT_COOLDOWN_CODES.has(code)
  const k = perModel ? this._cooldownKey(key, model) : key
  const until = Date.now() + Math.min(ms, DAY_MS)
  this.cooldowns.set(k, {
    until,
    code,
    model: perModel ? model : undefined,
  })
  this._persistCooldowns(key)
  logger.info('account cooling down; will try others', {
    key,
    code,
    until: new Date(until).toISOString(),
    model: perModel ? model : null,
    scope: perModel ? 'model' : 'account',
  })
}

/**
 * 清掉账号级(与可选模型级)冷却, 并落盘.
 * @param {any} this 账号池(runtimes)
 * @param {string} key 账号 key
 * @param {string | null} [model] 模型
 * @returns {void}
 */
export function clearCooldown(this: any, key: any, model: any = null) {
  this.cooldowns.delete(key)
  if (model) this.cooldowns.delete(this._cooldownKey(key, model))
  this._persistCooldowns(key)
}

/**
 * 把内存里的账号状态写进账本:
 *   - _persistCooldowns(key):某账号整组冷却(账号级 + 各模型级)
 *   - _persistAccountState(key, snap):freebucks / quota / lastProbe
 * 都在热路径上调用,落盘本身由 AccountStateStore 去抖合并,不阻塞转发.
 * @param {any} this 账号池(runtimes)
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @returns {any} 见实现
 */
export function _persistCooldowns(this: any, key: any) {
  if (!key) return
  const prefix = `${key}\0`
  const cooldowns: Record<string, any> = {}
  for (const [k, cd] of this.cooldowns) {
    if (k !== key && !k.startsWith(prefix)) continue
    cooldowns[k] = { until: cd.until, code: cd.code ?? null }
    if (cd.model) cooldowns[k].model = cd.model
  }
  this.accountState.patch(key, { cooldowns })
}

/**
 * 最早到期的那条冷却还有多少毫秒(全池无冷却时返回默认冷却时长).
 * @param {any} this 账号池(runtimes)
 * @returns {number} 毫秒
 */
export function earliestCooldownMs(this: any) {
  const now = Date.now()
  let min = null
  for (const cd of this.cooldowns.values()) {
    if (cd.until > now) {
      const left = cd.until - now
      if (min == null || left < min) min = left
    }
  }
  return min ?? DEFAULT_COOLDOWN_MS
}
