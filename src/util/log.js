const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/** @type {{ level: string }} */
let settings = { level: 'info' }

/**
 * 进程内环形缓冲：最近 N 条日志留一份在内存，供控制台「日志」页查看。
 *
 * 为什么需要：上游的故障判据（例如 countryBlockReason）以往只写进 stdout，
 * 用户在容器里看不到、也不想 docker logs —— 于是只能看到一串 503 却不知道
 * 为什么。控制台要能直接读到完整字段才能排障。
 *
 * 有界是硬要求：不带上限会让长期运行的实例被日志吃光内存。超容量丢最旧的
 * （**及时清理**：默认 500 条，可由 config.log.ringCap 调整；0 = 不保留）。
 * @type {Array<Record<string, any>>}
 */
const ring = []
/** @type {number} */
let ringCap = 500

/**
 * 日志上下文：一次下游请求的全链路标识。
 *
 * 为什么需要：此前每条日志只有 ts/level/msg/fields，
 * **看不出是哪个账号的哪一次请求** —— 多账号池并发时日志完全交织，
 * 排障只能靠猜。现在用 AsyncLocalStorage 把上下文透传进所有下游调用，
 * logger 自动带上 `reqId` / `account` / `model`，前端再按 reqId 聚合。
 */
let als = null
try {
  // 延迟 require：AsyncLocalStorage 在 Node 18+ 可用，缺了就降级为无上下文
  const { AsyncLocalStorage } = await import('node:async_hooks')
  als = new AsyncLocalStorage()
} catch {
  als = null
}

/** 当前上下文（无 ALS 时为 null）。 */
export function currentLogContext() {
  return als ? als.getStore() || null : null
}

/**
 * 在给定上下文里执行 fn，其内部所有日志都会自动带上这些字段。
 * @param {Record<string, any>} ctx { reqId?, account?, model? }
 * @param {() => any} fn
 * @returns {any}
 */
export function runWithLogContext(ctx, fn) {
  if (!als) return fn()
  const prev = als.getStore() || {}
  return als.run({ ...prev, ...ctx }, fn)
}

/** 给当前上下文补字段（例如账号选定后才拿到 account）。 */
export function patchLogContext(patch) {
  const store = als ? als.getStore() : null
  if (store && patch && typeof patch === 'object') Object.assign(store, patch)
}

export function configureLogger(opts) {
  if (opts?.level) settings = { level: opts.level }
  if (Number.isInteger(opts?.ringCap) && opts.ringCap >= 0) ringCap = opts.ringCap
}

export function log(level, msg, fields = undefined) {
  if ((LEVELS[level] ?? 99) < (LEVELS[settings.level] ?? 20)) return
  const ctx = currentLogContext()
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    // 上下文优先放前面，读日志时一眼看到"谁的哪次请求"
    ...(ctx?.reqId ? { reqId: ctx.reqId } : {}),
    ...(ctx?.account ? { account: ctx.account } : {}),
    ...(ctx?.model ? { model: ctx.model } : {}),
    ...(fields && typeof fields === 'object' ? fields : {}),
  }
  const text = JSON.stringify(line)
  if (ringCap > 0) {
    ring.push(line)
    // 及时清理：只保留最近 ringCap 条
    if (ring.length > ringCap) ring.splice(0, ring.length - ringCap)
  }
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

/** 设置/读取缓冲容量（0 = 不缓冲）—— 及时清理，避免长期运行吃内存。 */
export function configureLogBuffer(cap) {
  if (Number.isFinite(cap)) ringCap = Math.max(0, Math.floor(cap))
  if (ring.length > ringCap) ring.splice(0, ring.length - ringCap)
  return ringCap
}

/** 清空缓冲（及时释放内存）。 */
export function clearRing() {
  ring.length = 0
}

/**
 * 读取缓冲里的日志（新的在后）。
 * @param {{ level?: string, q?: string, limit?: number, sinceTs?: string, reqId?: string, account?: string }} [opts]
 * @returns {Array<Record<string, any>>}
 */
export function readLogBuffer(opts = {}) {
  let out = ring
  if (opts.level && opts.level !== 'all') {
    const min = LEVELS[opts.level]
    if (Number.isFinite(min)) out = out.filter((l) => (LEVELS[l.level] ?? 99) >= min)
  }
  // 按一次请求聚合：控制台日志页据此把同一次请求的多条日志归为一组
  if (opts.reqId) {
    const rid = String(opts.reqId)
    out = out.filter((l) => String(l.reqId || '') === rid)
  }
  if (opts.account) {
    const who = String(opts.account).toLowerCase()
    out = out.filter((l) => String(l.account || '').toLowerCase().includes(who))
  }
  if (opts.q) {
    const needle = String(opts.q).toLowerCase()
    out = out.filter((l) => JSON.stringify(l).toLowerCase().includes(needle))
  }
  if (opts.sinceTs) {
    const since = Date.parse(opts.sinceTs)
    if (Number.isFinite(since)) out = out.filter((l) => Date.parse(l.ts) > since)
  }
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 200
  return out.slice(-limit)
}

export const logger = {
  debug: (msg, fields) => log('debug', msg, fields),
  info: (msg, fields) => log('info', msg, fields),
  warn: (msg, fields) => log('warn', msg, fields),
  error: (msg, fields) => log('error', msg, fields),
}
