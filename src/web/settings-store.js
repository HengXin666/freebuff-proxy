import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_SETTINGS = Object.freeze({
  freeToolSignatureEnabled: true,
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
    } catch (err) {
      console.error(
        `settings store load failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  get() {
    return { ...this.settings }
  }

  /** @param {{ freeToolSignatureEnabled: boolean }} next */
  save(next) {
    if (typeof next?.freeToolSignatureEnabled !== 'boolean') {
      throw new TypeError('freeToolSignatureEnabled must be a boolean')
    }
    const settings = {
      freeToolSignatureEnabled: next.freeToolSignatureEnabled,
    }
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

export { DEFAULT_SETTINGS }
