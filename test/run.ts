/**
 * 测试总入口 -- npm test 只调它一个.
 *
 * 做的事: 按固定顺序逐个套件起子进程跑, 任一失败即中止并透传其退出码,
 * 全部通过打印 ALL SUITES PASS.
 *
 * 一个套件一个子进程: 各套件都会起 mock 上游 / 监听端口 / 改全局 fetch,
 * 同进程串行 import 会让它们的全局状态互相继承.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 测试目录(相对本文件). */
const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)

/**
 * 套件清单, 按依赖顺序.
 *
 * smoke 建的是整套调度/会话的 mock 上游, 它的断言最全; 后面的 verify-* 是各自
 * 独立的真源对账, 不依赖 smoke 的产物. 顺序只决定先看到哪一类失败.
 */
const SUITES = [
  ['smoke', 'suites/entries/smoke/smoke.ts'],
  ['smoke-frontend', 'suites/entries/smoke/smoke-frontend.ts'],
  ['model-name-chain', 'suites/entries/verify/model-name-chain.ts'],
  ['catalog-models', 'suites/entries/verify/catalog-models.ts'],
  ['model-mapping-truth', 'suites/entries/verify/model-mapping-truth.ts'],
  ['tool-name-mapping', 'suites/entries/verify/tool-name-mapping.ts'],
  ['catalog-freshness', 'suites/entries/verify/catalog/freshness.ts'],
  ['tool-restore-declared', 'suites/entries/verify/tool/restore-declared.ts'],
  ['tool-param-idempotent', 'suites/entries/verify/tool/param-idempotent.ts'],
  ['tool-official-select', 'suites/entries/verify/tool/official-select.ts'],
  ['tool-stream-rewrite', 'suites/entries/verify/tool/stream-rewrite.ts'],
  ['chat-payload-contract', 'suites/entries/verify/chat-payload-contract.ts'],
  ['dashboard-cold-start-state', 'suites/entries/verify/dashboard/cold-start-account-state.ts'],
]

let failed = 0
const started = Date.now()
for (const [label, rel] of SUITES) {
  const file = path.join(TEST_DIR, rel)
  if (!fs.existsSync(file)) {
    // 套件文件不存在时直接报错: "少跑一个套件"与"那个套件全绿"在退出码上完全一样.
    console.error(`FAIL ${label}: 套件文件不存在 ${rel}`)
    failed = 1
    break
  }
  const t0 = Date.now()
  const res = spawnSync(process.execPath, [file], { stdio: 'inherit', cwd: path.dirname(TEST_DIR) })
  const ms = Date.now() - t0
  if (res.status !== 0) {
    console.error(`FAIL ${label} (exit ${res.status}, ${(ms / 1000).toFixed(1)}s)`)
    failed = res.status ?? 1
    break
  }
  console.log(`ok   ${label} (${(ms / 1000).toFixed(1)}s)`)
}

if (failed !== 0) process.exit(failed)
console.log(`ALL SUITES PASS (${SUITES.length} 个, ${((Date.now() - started) / 1000).toFixed(1)}s)`)
