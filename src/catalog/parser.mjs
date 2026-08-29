/**
 * Freebuff catalog parser — 共享解析逻辑。
 *
 * 从 Codebuff/Freebuff 开源常量源码（TS 文本）解析模型目录：
 *   - common/src/constants/freebuff-model-ids.ts → 模型 id 常量（字符串字面量）
 *   - common/src/constants/freebuff-models.ts     → 模型 id 常量 + displayName/pool
 *   - common/src/constants/free-agents.ts         → model → agentId (base2) / fallbackAgentId (base3)
 *
 * 无副作用纯函数。两个入口复用同一份解析逻辑（避免漂移）：
 *   - scripts/sync-catalog.mjs     手动同步（读本地 checkout → 写内置 catalog）
 *   - src/catalog/runtime-sync.mjs 运行时自动同步（拉上游源码 → 写 data 缓存，失败保留旧值）
 *
 * 对齐参考：trefeon/freebuff-proxy internal/registry（Registry.Refresh +
 * parseRootAgentMap + parseAgentModels + retiredRootOverrides 的等价物）。
 */

/**
 * 收集所有 `export const <NAME>_MODEL_ID = '<value>'` 常量（值必须是
 * 字符串字面量；跨行定义也支持）。返回 { NAME: 'model-id' }。
 * @param {...string} sources
 * @returns {Record<string, string>}
 */
export function collectModelIdConstants(...sources) {
  const out = {}
  const re = /export const ([A-Za-z0-9_]+_MODEL_ID)\s*=\s*'([^']+)'/g
  for (const src of sources) {
    let m
    while ((m = re.exec(src))) out[m[1]] = m[2]
  }
  return out
}

/**
 * 解析 `export const MAP: Record<string, string> = { [CONST]: 'x', 'id': 'y' }`。
 * 返回 { key: value }，key 可能是常量名或字面 id——调用方用 modelIdConsts 解引用。
 * @param {string} src
 * @param {string} pattern
 * @returns {Record<string, string>}
 */
export function parseStringConstMap(src, pattern) {
  const m = src.match(
    new RegExp(`export const ${pattern}[\\s\\S]*?=\\s*\\{[\\s\\S]*?\\n\\}`, 'm'),
  )
  if (!m) return {}
  const out = {}
  const body = m[0]
  const re = /^\s*(?:\[([A-Za-z0-9_]+)\]|'([^']+)'):\s*'([^']+)'/gm
  let entry
  while ((entry = re.exec(body))) {
    const key = entry[1] || entry[2]
    out[key] = entry[3]
  }
  return out
}

/**
 * 从三份常量源码构建完整 catalog（model 列表 + base2/base3 agent 映射 + 元信息）。
 * @param {string} modelIdsTs  freebuff-model-ids.ts 全文
 * @param {string} modelsTs    freebuff-models.ts 全文
 * @param {string} agentsTs    free-agents.ts 全文
 * @returns {{ models: Array<{id: string, displayName: string, pool: string, multimodal: boolean, agentId?: string, fallbackAgentId?: string, note: string}> }}
 */
export function buildCatalogFromSources(modelIdsTs, modelsTs, agentsTs) {
  const modelIdConsts = collectModelIdConstants(modelIdsTs, modelsTs)
  // mimoModels.mimoV25 是间接引用（model-config.ts 里 'mimo/mimo-v2.5'），
  // 常量收集抓不到字符串字面量——这里手动补上。
  modelIdConsts.FREEBUFF_MIMO_V25_MODEL_ID = 'mimo/mimo-v2.5'
  const idOf = (k) => modelIdConsts[k] || k

  /** model → base2 agent */
  const base2 = parseStringConstMap(agentsTs, 'FREEBUFF_ROOT_AGENT_ID_BY_MODEL')
  /** model → base3 agent（Web + CLI 两张表合并） */
  const base3 = {
    ...parseStringConstMap(agentsTs, 'FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL'),
    ...parseStringConstMap(agentsTs, 'FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL'),
  }

  const base2Resolved = {}
  for (const [k, v] of Object.entries(base2)) {
    const id = idOf(k)
    // 解引用失败的残留常量名（如 FREEBUFF_MIMO_V25_MODEL_ID 若抓不到）跳过，
    // 不让常量名本身进 catalog。
    if (id && !id.includes('MODEL_ID')) base2Resolved[id] = v
  }
  const base3Resolved = {}
  for (const [k, v] of Object.entries(base3)) {
    const id = idOf(k)
    if (id && !id.includes('MODEL_ID')) base3Resolved[id] = v
  }

  // 模型元信息：displayName 从 freebuff-models.ts 的行内模型对象里提取。
  const meta = {}
  const rowRe =
    /const ([A-Za-z0-9_]+_MODEL) = \{\s*id:\s*([A-Za-z0-9_]+_MODEL_ID|'[^']+'),[\s\S]*?displayName:\s*'([^']+)'/g
  let row
  while ((row = rowRe.exec(modelsTs))) {
    const id = idOf(row[2])
    if (id && !id.includes('MODEL_ID')) meta[id] = { displayName: row[3] }
  }

  const ids = new Set([
    ...Object.keys(base2Resolved),
    ...Object.keys(base3Resolved),
    ...Object.keys(meta),
  ])

  const models = []
  for (const id of [...ids].sort()) {
    const m = meta[id] || {}
    const agentId = base2Resolved[id]
    const fallbackAgentId = base3Resolved[id]
    models.push({
      id,
      displayName: m.displayName || id,
      pool: 'daily',
      multimodal: false,
      ...(agentId ? { agentId } : {}),
      ...(fallbackAgentId ? { fallbackAgentId } : {}),
      note: 'Synced from CodebuffAI/freebuff common/src/constants/free-agents.ts + freebuff-models.ts',
    })
  }

  return {
    version: 1,
    syncedAt: new Date().toISOString(),
    source:
      'CodebuffAI/freebuff common/src/constants/free-agents.ts + freebuff-models.ts + freebuff-model-ids.ts',
    models,
  }
}
