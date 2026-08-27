#!/usr/bin/env node
/**
 * 从 Codebuff 开源源码一键同步 Freebuff 模型目录（含 agent 映射）。
 *
 *   node scripts/sync-catalog.mjs
 *   node scripts/sync-catalog.mjs --source /path/to/codebuff-checkout
 *
 * 数据源：CodebuffAI/codebuff
 *   - common/src/constants/freebuff-model-ids.ts → 模型 id 常量（字符串字面量）
 *   - common/src/constants/freebuff-models.ts     → 模型 id 常量 + displayName/pool
 *   - common/src/constants/free-agents.ts         → model → agentId (base2) / fallbackAgentId (base3)
 *
 * 输出：src/catalog/freebuff-catalog.json（随包发布的内置目录）
 *
 * 以后上游上了新模型，clone 最新 Codebuff 源码跑一次本脚本即可，
 * 不需要手改 src/model.js。catalog 里没有的未知模型，运行时还会用
 * 命名规则推导 agent（见 model.js deriveAgentId）继续兜底。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'src', 'catalog', 'freebuff-catalog.json')

const args = process.argv.slice(2)
const srcFlag = args.indexOf('--source')
const SRC =
  srcFlag >= 0 && args[srcFlag + 1]
    ? path.resolve(args[srcFlag + 1])
    : path.join(ROOT, '.codebuff-src')

function readTs(rel) {
  const p = path.join(SRC, rel)
  if (!fs.existsSync(p)) {
    throw new Error(`missing ${p}`)
  }
  return fs.readFileSync(p, 'utf8')
}

/**
 * 收集所有 `export const <NAME>_MODEL_ID = '<value>'` 常量（值必须是
 * 字符串字面量；跨行定义也支持）。返回 { NAME: 'model-id' }。
 */
function collectModelIdConstants(...sources) {
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
 */
function parseStringConstMap(src, pattern) {
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

function main() {
  const modelIdsTs = readTs('common/src/constants/freebuff-model-ids.ts')
  const modelsTs = readTs('common/src/constants/freebuff-models.ts')
  const agentsTs = readTs('common/src/constants/free-agents.ts')

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
      note: 'Synced from CodebuffAI/codebuff free-agents.ts + freebuff-models.ts',
    })
  }

  const catalog = {
    version: 1,
    syncedAt: new Date().toISOString(),
    source:
      'CodebuffAI/codebuff common/src/constants/free-agents.ts + freebuff-models.ts + freebuff-model-ids.ts',
    models,
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2))
  console.log(`[sync-catalog] wrote ${OUT}`)
  console.log(`[sync-catalog] ${models.length} models`)
  for (const m of models) {
    console.log(
      `  ${m.id}  base2=${m.agentId || '-'}  base3=${m.fallbackAgentId || '-'}`,
    )
  }
  if (!models.length) {
    console.error(
      '[sync-catalog] WARNING: no models extracted — check source path',
    )
    process.exitCode = 1
  }
}

try {
  main()
} catch (err) {
  console.error(
    `[sync-catalog] failed: ${err instanceof Error ? err.message : err}`,
  )
  console.error(
    'Need the Codebuff source checkout. Either:\n' +
      `  git clone --depth=1 https://github.com/CodebuffAI/codebuff.git ${SRC}\n` +
      'or pass --source /path/to/codebuff',
  )
  process.exitCode = 1
}
