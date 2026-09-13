import fs from 'node:fs'
import path from 'node:path'
import { readJsonFileState, noteDataFile } from '../util/json-store.js'

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
    /** 装载结果（'ok' | 'missing' | 'invalid'）——损坏时=没有全局代理池（直连），
     * 必须显式暴露：用户会以为"代理设置被重置了"。 */
    this.loadStatus = 'missing'
    this.loadReason = null
    this.load()
  }

  load() {
    const st = readJsonFileState(this.file)
    noteDataFile(this.file, st)
    this.loadStatus = st.status
    this.loadReason = st.status === 'invalid' ? st.reason : null
    if (st.status === 'ok' && Array.isArray(st.data?.proxies)) {
      this.proxies = st.data.proxies.map(String).filter(Boolean)
    } else if (st.status === 'invalid') {
      console.error(`[freebuff-proxy] 数据文件损坏: ${this.file} — ${st.reason}（全局代理池按空处理）`)
    }
    return st
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
