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

/**
 * 拦截类日志的限频(同一账号同一拦截码在窗口内只记一条).
 *
 * 池内多个账号同时额度不足时, 每个请求都会对每个账号各记一条 skip 日志
 * (13 个并发请求 x N 个账号 = 数百条), 把真正有用的选号日志淹掉.
 * 限频不丢信息: 窗口内沉默, 窗口外再记一条, 首条带完整账目.
 * 窗口表挂在账号池上(每进程一份), 不进账本 ---- 它只是日志节流.
 *
 * 见 .agents/notes/implemented/feature/2026-10-08-quota-gate-probe-throttle.md
 * @param {any} self 账号池(runtimes); 缺窗口表时直接记一条
 * @param {string} key 账号 key
 * @param {string} code 拦截码(freebucks_exhausted / units_exhausted)
 * @param {string} msg 日志消息
 * @param {any} fields 附加字段
 * @returns {boolean} 本次是否真的记了日志
 */
export function skipLogOnce(self: any, key: any, code: any, msg: any, fields: any): boolean {
  if (!self) {
    logger.info(msg, fields)
    return true
  }
  const now = Date.now()
  let seen = self._skipLogSeen
  if (!(seen instanceof Map)) {
    seen = new Map()
    self._skipLogSeen = seen
  }
  const id = `${code}\0${key}`
  /**
   * 先判当前(账号, 码): 命中就直接沉默.
   *
   * 顺序不能反 ---- 容量淘汰删的是最旧的一条, 若先淘汰再判, 表满时重复命中的
   * 那个最旧账号会被删掉从而再记一条, 限频被自己的清理破坏.
   */
  const last = seen.get(id)
  if (Number.isFinite(last) && now - last < SKIP_LOG_WINDOW_MS) return false
  /**
   * 阈值语义: 表大小达到 SKIP_LOG_MAX 时触发一次回收; 回收后若仍满, 本次不记.
   * 之所以允许[回收后恰好等于上限]时再插一条(稳态最多 SKIP_LOG_MAX + 1),
   * 是为了不删任何未过期记录.
   */
  if (seen.size >= SKIP_LOG_MAX) {
    /**
     * 表满即只回收过期项, 不给新键腾位置.
     *
     * 腾位置必然要删一条未过期的记录, 那等于让被删的账号在窗口内又记一条 ----
     * 限频被自己的清理破坏. 表满时的正确取舍是[宁可少记新键]: 盘内 key 数
     * 本来就是有界的, 一旦窗口内的活跃键多于上限, 说明限频已到边际收益.
     */
    retireSkipLogSeen(seen, now)
    if (seen.size >= SKIP_LOG_MAX) return false
  }
  seen.set(id, now)
  logger.info(msg, fields)
  return true
}

/**
 * 回收窗口表里已经过期的条目(只回收过期项, 不删未过期的).
 * @param {Map<string, number>} seen 窗口表
 * @param {number} now 当前时间戳
 * @returns {void}
 */
function retireSkipLogSeen(seen: Map<string, number>, now: number): void {
  for (const [k, at] of seen) {
    if (now - at >= SKIP_LOG_WINDOW_MS) seen.delete(k)
  }
}

/** 限频窗口(毫秒): 同一账号同一拦截码在窗口内只记一条. */
const SKIP_LOG_WINDOW_MS = 60_000

/** 限频窗口表的回收阈值(达到即回收过期项, 防无限增长). */
const SKIP_LOG_MAX = 512

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
