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
 * 有界是硬要求：不带上限会让长期运行的实例被日志吃光内存。超容量丢最旧的。
 * @type {Array<Record<string, any>>}
 */
const ring = []
/** @type {number} */
let ringCap = 500

export function configureLogger(opts) {
  if (opts?.level) settings = { level: opts.level }
}

export function log(level, msg, fields = undefined) {
  if ((LEVELS[level] ?? 99) < (LEVELS[settings.level] ?? 20)) return
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields && typeof fields === 'object' ? fields : {}),
  }
  const text = JSON.stringify(line)
  // 留一份进环形缓冲（控制台「日志」页要读）。缓冲在 configureLogger 之后
  // 才可能被改容量，这里按当前容量裁剪。
  if (ringCap > 0) {
    ring.push(line)
    if (ring.length > ringCap) ring.splice(0, ring.length - ringCap)
  }
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

export const logger = {
  debug: (msg, fields) => log('debug', msg, fields),
  info: (msg, fields) => log('info', msg, fields),
  warn: (msg, fields) => log('warn', msg, fields),
  error: (msg, fields) => log('error', msg, fields),
};

/** 设置/读取缓冲容量（0 = 不缓冲）。 */
export function configureLogBuffer(cap) {
  if (Number.isFinite(cap)) ringCap = Math.max(0, Math.floor(cap))
  if (ring.length > ringCap) ring.splice(0, ring.length - ringCap)
  return ringCap
}

/**
 * 读取缓冲里的日志（新的在后）。
 * @param {{ level?: string, q?: string, limit?: number, sinceTs?: string }} [opts]
 * @returns {Array<Record<string, any>>}
 */
export function readLogBuffer(opts = {}) {
  let out = ring;
  if (opts.level && opts.level !== 'all') {
    const min = LEVELS[opts.level];
    if (Number.isFinite(min)) out = out.filter((l) => (LEVELS[l.level] ?? 99) >= min);
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
