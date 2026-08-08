import fs from 'node:fs'
import path from 'node:path'

/**
 * 前端管理的全局代理池。
 *
 *   data/proxies.json
 *     { version: 1, proxies: ["http://...", "socks5://..."] }
 *
 * 优先级高于 config.yaml 的 upstream.proxies；前端保存后立即生效（缓存 runtime 重建）。
 */
export class ProxyStore {
  /**
   * @param {string} file e.g. /data/proxies.json
   */
  constructor(file) {
    this.file = file
    /** @type {string[]} */
    this.proxies = []
    this.load()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && Array.isArray(raw.proxies)) {
        this.proxies = raw.proxies.map(String).filter(Boolean)
      }
    } catch (err) {
      console.error(
        `proxy store load failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  list() {
    return [...this.proxies]
  }

  /**
   * @param {unknown} proxies
   * @returns {string[]} 保存后的代理列表（空数组 = 清除全局池，走 env/直连）
   */
  save(proxies) {
    const list = (Array.isArray(proxies) ? proxies : [])
      .map((u) => (typeof u === 'string' ? u.trim() : ''))
      .filter(Boolean)
    this.proxies = list
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, proxies: list }, null, 2),
      { mode: 0o600 },
    )
    fs.renameSync(tmp, this.file)
    return this.list()
  }
}
