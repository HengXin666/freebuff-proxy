import type { LogEvent, LogKind } from './log-kinds.ts'
import { LOG } from '../shared/constants.ts'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/** @type {{ level: string }} */
let settings = { level: 'info' }

/**
 * 进程内环形缓冲:最近 N 条日志留一份在内存,供控制台[日志]页查看.
 *
 * 有界:超容量丢最旧的(默认 5000 条,由 logging.ring_cap 决定;
 * configureLogger() 启动时接线;0 = 不保留).
 * 决策与页面证据见 .agents/notes/implemented/feature/2026-09-30-console-log-viewer.md.
 * @type {Array<Record<string, any>>}
 */
const ring: Array<Record<string, any>> = []
/** @type {number} */
let ringCap: number = LOG.ringCapDefault

/**
 * 日志上下文:一次下游请求的全链路标识.
 *
 * 用 AsyncLocalStorage 把上下文透传进所有下游调用, logger 自动带上
 * reqId / account / model, 前端按 reqId 聚合.
 * 见 .agents/notes/implemented/feature/2026-10-03-log-context-reqid-account.md
 */
let als: any = null
try {
  // 延迟 require:AsyncLocalStorage 在 Node 18+ 可用,缺了就降级为无上下文
  const { AsyncLocalStorage } = await import('node:async_hooks')
  als = new AsyncLocalStorage()
} catch {
  als = null
}

/** 当前上下文(无 ALS 时为 null). */
export function currentLogContext(): Record<string, any> | null {
  return als ? als.getStore() || null : null
}

/**
 * 在给定上下文里执行 fn,其内部所有日志都会自动带上这些字段.
 * @param {Record<string, any>} ctx { reqId?, account?, model? }
 * @param {() => any} fn
 * @returns {any}
 */
export function runWithLogContext(ctx: any, fn: () => any): any {
  if (!als) return fn()
  const prev = als.getStore() || {}
  return als.run({ ...prev, ...ctx }, fn)
}

/** 给当前上下文补字段(例如账号选定后才拿到 account). */
export function patchLogContext(patch: Record<string, any>): void {
  const store = als ? als.getStore() : null
  if (store && patch && typeof patch === 'object') Object.assign(store, patch)
}

export function configureLogger(opts: Record<string, any>): void {
  if (opts?.level) settings = { level: opts.level }
  if (Number.isInteger(opts?.ringCap) && opts.ringCap >= 0) ringCap = opts.ringCap
}

export function log(level: string, msg: string, fields: any = undefined): void {
  const lv = LEVELS as Record<string, number>
  if ((lv[level] ?? 99) < (lv[settings.level] ?? 20)) return
  const ctx = currentLogContext()
  const f = fields && typeof fields === 'object' ? fields : {}
  /**
   * account 兜底: fields 里有 email 而上下文没给 account 时用 email.
   * 选号阶段(还没 patchLogContext)的日志点只带 email.
   */
  const account = ctx?.account || f.email || undefined
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    // 颗粒度: 在请求上下文里 = request(带 reqId), 其余 = 独立事件.
    kind: (ctx?.reqId ? 'request' : 'event') as LogKind,
    ...(ctx?.reqId ? { reqId: ctx.reqId } : {}),
    ...(account ? { account } : {}),
    ...(ctx?.model ? { model: ctx.model } : {}),
    ...f,
  }
  const text = JSON.stringify(line)
  if (ringCap > 0) {
    ring.push(line)
    // 及时清理:只保留最近 ringCap 条
    if (ring.length > ringCap) ring.splice(0, ring.length - ringCap)
  }
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

/** 设置/读取缓冲容量(0 = 不缓冲)---- 及时清理,避免长期运行吃内存. */
export function configureLogBuffer(cap: number): number {
  if (Number.isFinite(cap)) ringCap = Math.max(0, Math.floor(cap))
  if (ring.length > ringCap) ring.splice(0, ring.length - ringCap)
  return ringCap
}

/** readLogBuffer 的过滤条件. */
export interface LogQuery {
  limit?: number
  account?: string
  reqId?: string
  level?: string
  q?: string
  sinceTs?: number
  /** 颗粒度过滤: 'request'(按请求聚合) / 'event'(独立事件). */
  kind?: LogKind
  /** 事件类型过滤(仅 kind='event' 有意义). */
  event?: LogEvent
}

/** 清空缓冲(及时释放内存). */
export function clearRing(): void {
  ring.length = 0
}

/**
 * 读取缓冲里的日志(新的在后).
 * @param {{ level?: string, q?: string, limit?: number, sinceTs?: string, reqId?: string, account?: string }} [opts]
 * @returns {Array<Record<string, any>>}
 */
export function readLogBuffer(opts: LogQuery = {}): any[] {
  let out = ring
  if (opts.level && opts.level !== 'all') {
    const min = (LEVELS as Record<string, number>)[opts.level]
    if (Number.isFinite(min)) out = out.filter((l: any) => ((LEVELS as Record<string, number>)[l.level] ?? 99) >= min)
  }
  // 按一次请求聚合:控制台日志页据此把同一次请求的多条日志归为一组
  if (opts.reqId) {
    const rid = String(opts.reqId)
    out = out.filter((l) => String(l.reqId || '') === rid)
  }
  if (opts.account) {
    const who = String(opts.account).toLowerCase()
    out = out.filter((l) => String(l.account || '').toLowerCase().includes(who))
  }
  if (opts.kind) out = out.filter((l) => l.kind === opts.kind)
  if (opts.event) out = out.filter((l) => l.event === opts.event)
  if (opts.q) {
    const needle = String(opts.q).toLowerCase()
    out = out.filter((l) => JSON.stringify(l).toLowerCase().includes(needle))
  }
  if (opts.sinceTs) {
    const since = Date.parse(String(opts.sinceTs))
    if (Number.isFinite(since)) out = out.filter((l: any) => Date.parse(l.ts) > since)
  }
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit as number)) : 200
  return out.slice(-limit)
}

export const logger = {
  debug: (msg: string, fields?: any) => log('debug', msg, fields),
  info: (msg: string, fields?: any) => log('info', msg, fields),
  warn: (msg: string, fields?: any) => log('warn', msg, fields),
  error: (msg: string, fields?: any) => log('error', msg, fields),
  /**
   * 记一个独立事件(额度刷新 / 账号探测 / 模型获取等).
   * @param {LogEvent} event 事件类型
   * @param {string} level 日志级别
   * @param {string} msg 消息
   * @param {any} [fields] 附加字段
   * @returns {void}
   */
  event: (event: LogEvent, level: string, msg: string, fields?: any) =>
    log(level, msg, { event, ...(fields || {}) }),
}
