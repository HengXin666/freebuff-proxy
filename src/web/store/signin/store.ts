/**
 * 连续签到(streak)服务 ---- 读取签到状态 + 触发当日签到.
 *
 * ## 真相先说清(实证来源: 官方客户端产物)
 *
 * 官方客户端 orchestrator/orchestrator.js 里的
 * src/server/services/streak.ts 只有一个 fetch():
 *
 *   GET ${apiHost}/api/v1/freebuff/streak   (只读, 全仓唯一调用点)
 *
 * 也就是说 这个端点不产生签到 ---- 它只报告状态:
 *   streak / todayUsed / lastUsageDate / timeZone / freebucksDailyBonus /
 *   nextResetAt / todayCredited / bonusExpiresAt
 *
 * 真正的签到(streak 累加, bonus 计入当日额度)由官方文案里的那句定义:
 *
 *   "+{freebucksDailyBonus} to your daily allowance with each day's first message"
 *
 * 即 当天第一条消息. 所以本模块做两件事:
 *   1. readStreak   ---- 读状态(只读, 零成本, 不建会话);
 *   2. signInAccount ---- 用[发一条最小消息]来落当天的签到.
 *
 * ## 签到的成本, 以及为什么它仍值得做
 *
 * admit = 买断一小时(见 .agents/notes/.../2026-09-14-paid-hour-hold.md):
 * 一条消息会按所选中模型的整小时单价预扣. 所以本模块先读 streak,
 * 若 todayCredited === true 或 todayUsed === true 就直接跳过 ----
 * 当天已签到过的账号不再重复付费.
 *
 * ## 防抖(用户要求)
 *
 * 手动一键签到 18 小时内只允许触发一次; 自动签到按 25 小时间隔.
 * 判据用服务端落盘的 lastSignInAt(不是前端计时), 这样刷新页面 /
 * 换浏览器 / 重启进程都不会绕过.
 */
import path from 'node:path'
import fs from 'node:fs'

import { readJsonFileState, noteDataFile } from '../../../util/json-store.ts'
import { logger } from '../../../util/log.ts'

/** 手动一键签到的防抖窗口(小时). 用户要求 18 小时. */
export const MANUAL_COOLDOWN_HOURS = 18
/** 自动签到的间隔(小时). 用户要求 25 小时(比 24 多一点, 避开跨时区边界). */
export const AUTO_INTERVAL_HOURS = 25

/** 落盘状态: 只记[什么时候签过]与[自动签到设置], 不记账号数据. */
export interface SignInState {
  /** 上次手动一键签到完成的时间戳(ms). */
  lastManualAt: number | null
  /** 上次自动签到完成的时间戳(ms). */
  lastAutoAt: number | null
  /** 每个账号上次[成功]签到的时间(账号 key -> ms). */
  perAccount: Record<string, number>
}

/** 签到状态文件的读取与写入. */
export class SignInStore {
  declare file: string
  declare state: SignInState

  /** @param {string} file 落盘路径(通常 <data>/signin.json) */
  constructor(file: string) {
    this.file = file
    this.state = { lastManualAt: null, lastAutoAt: null, perAccount: {} }
    this.load()
  }

  /**
   * 读盘. 文件不存在或损坏时用空状态 ----
   * 签到记录坏了不该拦住服务启动(最坏情况是允许提前签一次).
   * @returns {void} 无返回值
   */
  load() {
    const st = readJsonFileState(this.file)
    noteDataFile(this.file, st)
    if (st.status !== 'ok' || !st.data || typeof st.data !== 'object') return
    const raw: any = st.data
    this.state = {
      lastManualAt: Number.isFinite(raw.lastManualAt) ? raw.lastManualAt : null,
      lastAutoAt: Number.isFinite(raw.lastAutoAt) ? raw.lastAutoAt : null,
      perAccount: raw.perAccount && typeof raw.perAccount === 'object' ? { ...raw.perAccount } : {},
    }
  }

  /**
   * 原子落盘(临时文件 + rename), 与设置存储同一套写法.
   * @returns {void} 无返回值
   */
  save() {
    try {
      // 临时文件 + rename: 与 SettingsStore.save 同一套写法(进程被杀也不会
      // 留下半份文件). 0o600 因为它是运行数据, 与其它 data/ 下文件一致.
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...this.state }, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (err) {
      logger.warn('sign-in state save failed', { error: String(err) })
    }
  }

  /** @returns {SignInState} 当前状态(副本) */
  get(): SignInState {
    return { ...this.state, perAccount: { ...this.state.perAccount } }
  }

  /**
   * 手动签到是否还在防抖窗口内.
   * @param {number} [now] 当前时间(测试可注入)
   * @returns {{ allowed: boolean, remainMs: number }} 是否允许与剩余毫秒
   */
  manualAllowed(now = Date.now()) {
    const last = this.state.lastManualAt
    if (!last) return { allowed: true, remainMs: 0 }
    const elapsed = now - last
    const windowMs = MANUAL_COOLDOWN_HOURS * 3600_000
    return elapsed >= windowMs
      ? { allowed: true, remainMs: 0 }
      : { allowed: false, remainMs: windowMs - elapsed }
  }

  /**
   * 自动签到是否到点.
   * @param {number} [now] 当前时间
   * @returns {boolean} 该发起自动签到为真
   */
  autoDue(now = Date.now()) {
    const last = this.state.lastAutoAt
    if (!last) return true
    return now - last >= AUTO_INTERVAL_HOURS * 3600_000
  }

  /**
   * 记一次签到结果.
   * @param {'manual' | 'auto'} kind 触发方式
   * @param {string[]} okKeys 本次成功的账号 key
   * @param {number} [now] 时间戳
   * @returns {void} 无返回值
   */
  markDone(kind: 'manual' | 'auto', okKeys: string[], now = Date.now()) {
    if (kind === 'manual') this.state.lastManualAt = now
    else this.state.lastAutoAt = now
    for (const k of okKeys) this.state.perAccount[k] = now
    this.save()
  }
}

/**
 * 该账号今天是否已经签到过.
 *
 * 判据是上游回执的 todayCredited / todayUsed ---- 不是我们自己的记录.
 * 我们记的 perAccount 只用于展示与排障, 判定权永远在上游.
 *
 * @param {any} streak 上游 streak 回执
 * @returns {boolean} 今天已签到为真
 */
export function alreadySignedToday(streak: any): boolean {
  if (!streak || typeof streak !== 'object') return false
  return streak.todayCredited === true || streak.todayUsed === true
}
