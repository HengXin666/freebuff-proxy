import fs from 'node:fs'
import path from 'node:path'

/**
 * 前端管理的自定义模型列表（全局生效）。
 *
 *   data/custom-models.json
 *     {
 *       version: 1,
 *       models: [
 *         { id: "z-ai/glm-5.3-flash", displayName: "GLM 5.3 Flash", pool: "daily",
 *           multimodal: true, agentId: "base2-free-glm-flash",
 *           fallbackAgentId: "base3-free-glm-flash", note: "..." },
 *         ...
 *       ],
 *       hidden: ["stealth/ox-alpha", "deepseek/deepseek-v4-pro"]
 *     }
 *
 * 用途：
 *  - 修正内置目录里过时/错误的模型名（比如上游改了 id，代码还没发版）。
 *  - 添加内置目录没有的新模型（上游新上了一个模型，操作者马上就能配，不用等代码更新）。
 *  - 覆盖某个模型的 agentId / pool / multimodal 等字段。
 *  - hidden：用户在前端「模型管理」删除的模型（含内置 catalog 里的），
 *    从 /v1/models 列表、调度、模型表里彻底隐藏；点「恢复」可取消隐藏。
 *
 * 自定义列表在 /v1/models、/api/models、isFreeModel、agentIdForModel 等
 * 所有读模型元信息的地方优先于内置 FREEBUFF_AVAILABLE_MODELS（同 id 覆盖）。
 * 保存后立即生效（runtime 取最新值，无需重启）。
 */
export class ModelStore {
  /**
   * @param {string} file e.g. /data/custom-models.json
   */
  constructor(file) {
    this.file = file
    /** @type {Array<{ id: string, displayName?: string, pool?: string, multimodal?: boolean, agentId?: string, fallbackAgentId?: string, note?: string }>} */
    this.models = []
    /** @type {string[]} 用户在前端「模型管理」删除/隐藏的模型 id（含内置目录的） */
    this.hiddenIds = []
    this.load()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && Array.isArray(raw.models)) {
        this.models = raw.models
          .map((m) => normalizeCustomModel(m))
          .filter(Boolean)
      }
      if (raw && Array.isArray(raw.hidden)) {
        this.hiddenIds = raw.hidden
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim())
      }
    } catch (err) {
      console.error(
        `model store load failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  /**
   * @returns {Array<{ id: string, displayName?: string, pool?: string, multimodal?: boolean, agentId?: string, fallbackAgentId?: string, note?: string }>}
   */
  list() {
    return this.models.map((m) => ({ ...m }))
  }

  /** 被隐藏（前端删除）的模型 id 列表 */
  hidden() {
    return [...this.hiddenIds]
  }

  /**
   * 隐藏一个模型（含内置目录的）：加入 hidden 列表并持久化。
   * 同时清理同 id 的自定义覆盖（避免隐藏了还残留覆盖数据）。
   * @param {string} id
   */
  hide(id) {
    if (!id) return this.hidden()
    this.models = this.models.filter((m) => m.id !== id)
    if (!this.hiddenIds.includes(id)) this.hiddenIds.push(id)
    this.#persist()
    return this.hidden()
  }

  /**
   * 彻底移除一个用户手动添加的自定义模型（不加入 hidden，不等到同步覆盖）。
   * 与 hide 的区别：hide 标记"隐藏内置模型"（可恢复、同步会拉回），
   * remove 是真正删除一条自定义条目（该 id 不再有自定义覆盖，回退 catalog）。
   * @param {string} id
   */
  remove(id) {
    if (!id) return this.models
    this.models = this.models.filter((m) => m.id !== id)
    this.#persist()
    return this.models
  }

  /**
   * 恢复一个被隐藏的模型。
   * @param {string} id
   */
  unhide(id) {
    if (!id) return this.hidden()
    this.hiddenIds = this.hiddenIds.filter((x) => x !== id)
    this.#persist()
    return this.hidden()
  }

  /**
   * @param {unknown} models
   * @returns {Array<{ id: string, displayName?: string, pool?: string, multimodal?: boolean, agentId?: string, fallbackAgentId?: string, note?: string }>}
   *   保存后的自定义模型列表（空数组 = 清除自定义，回退到内置目录）
   */
  save(models) {
    const list = (Array.isArray(models) ? models : [])
      .map((m) => normalizeCustomModel(m))
      .filter(Boolean)
    // 去重：同 id 保留最后一条
    const byId = new Map()
    for (const m of list) byId.set(m.id, m)
    this.models = [...byId.values()]
    // 一致性：写回的模型（用户手动添加/同步上游）自动解除隐藏，
    // 避免「models 里有 + hidden 里也有」的矛盾状态（删不掉的模型）。
    // 「同步上游不复活已删模型」由同步调用方负责过滤 hidden（见 api.js）。
    const added = new Set(this.models.map((m) => m.id))
    if (added.size) {
      this.hiddenIds = this.hiddenIds.filter((id) => !added.has(id))
    }
    this.#persist()
    return this.list()
  }

  /** 写盘（models + hidden 一起持久化） */
  #persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        { version: 1, models: this.models, hidden: this.hiddenIds },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    fs.renameSync(tmp, this.file)
  }
}

/**
 * @param {unknown} m
 * @returns {{ id: string, displayName?: string, pool?: string, multimodal?: boolean, agentId?: string, fallbackAgentId?: string, note?: string } | null}
 */
function normalizeCustomModel(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const id = typeof m.id === 'string' ? m.id.trim() : ''
  if (!id) return null
  /** @type {any} */
  const out = { id }
  if (typeof m.displayName === 'string' && m.displayName.trim()) {
    out.displayName = m.displayName.trim()
  }
  if (typeof m.pool === 'string' && m.pool.trim()) {
    out.pool = m.pool.trim()
  }
  if (typeof m.multimodal === 'boolean') out.multimodal = m.multimodal
  if (typeof m.agentId === 'string' && m.agentId.trim()) {
    out.agentId = m.agentId.trim()
  }
  if (typeof m.fallbackAgentId === 'string' && m.fallbackAgentId.trim()) {
    out.fallbackAgentId = m.fallbackAgentId.trim()
  }
  if (typeof m.note === 'string' && m.note.trim()) {
    out.note = m.note.trim()
  }
  return out
}
