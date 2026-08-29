#!/usr/bin/env node
/**
 * 从 Codebuff 开源源码一键同步 Freebuff 模型目录（含 agent 映射）。
 *
 *   node scripts/sync-catalog.mjs
 *   node scripts/sync-catalog.mjs --source /path/to/codebuff-checkout
 *
 * 数据源：CodebuffAI/codebuff（本地 checkout）
 *   - common/src/constants/freebuff-model-ids.ts → 模型 id 常量（字符串字面量）
 *   - common/src/constants/freebuff-models.ts     → 模型 id 常量 + displayName/pool
 *   - common/src/constants/free-agents.ts         → model → agentId (base2) / fallbackAgentId (base3)
 *
 * 输出：src/catalog/freebuff-catalog.json（随包发布的内置目录）
 *
 * 解析逻辑见 src/catalog/parser.mjs（与运行时自动同步共用一份，避免漂移）。
 * 运行时自动同步见 src/catalog/runtime-sync.mjs（启动后每 6h 拉上游源码，
 * 写 data/catalog-cache.json，失败保留旧缓存——对齐 trefeon/freebuff-proxy
 * 的 Registry.Refresh）。
 *
 * 以后上游上了新模型，clone 最新 Codebuff 源码跑一次本脚本即可，
 * 不需要手改 src/model.js。catalog 里没有的未知模型，运行时还会用
 * 命名规则推导 agent（见 model.js deriveAgentId）继续兜底。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCatalogFromSources } from '../src/catalog/parser.mjs'

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

function main() {
  const modelIdsTs = readTs('common/src/constants/freebuff-model-ids.ts')
  const modelsTs = readTs('common/src/constants/freebuff-models.ts')
  const agentsTs = readTs('common/src/constants/free-agents.ts')

  const catalog = buildCatalogFromSources(modelIdsTs, modelsTs, agentsTs)

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2))
  console.log(`[sync-catalog] wrote ${OUT}`)
  console.log(`[sync-catalog] ${catalog.models.length} models`)
  for (const m of catalog.models) {
    console.log(
      `  ${m.id}  base2=${m.agentId || '-'}  base3=${m.fallbackAgentId || '-'}`,
    )
  }
  if (!catalog.models.length) {
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
