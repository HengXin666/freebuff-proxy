const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/** @type {{ level: string }} */
let settings = { level: 'info' }

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
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

export const logger = {
  debug: (msg, fields) => log('debug', msg, fields),
  info: (msg, fields) => log('info', msg, fields),
  warn: (msg, fields) => log('warn', msg, fields),
  error: (msg, fields) => log('error', msg, fields),
}
