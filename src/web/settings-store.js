import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_SETTINGS = Object.freeze({
  freeToolSignatureEnabled: true,
  // 每个账号同一时间可并发的 SSE 响应流数（负载均衡），默认 1:1。
  accountMaxConcurrency: 1,
})

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
