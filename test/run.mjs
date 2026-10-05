/**
 * 测试总入口 -- npm test 只调它一个.
 *
 * ## 为什么要有这一层
 *
 * 此前 package.json 的 test 脚本是一条 6 段的 && 链:
 *
 *     node test/smoke.mjs && node test/smoke-frontend.mjs && node test/verify-*.mjs ...
 *
 * 它有两个问题:
 *
 *   1. 每个套件入口都必须待在 test/ 顶层 ---- 而"同一目录 <=5 个文件"是用户
 *      下的硬标准.6 个契约入口 + 5 个上限在算术上互斥, 无论怎么拆都过不了.
 *   2. 增删套件要改 JSON ---- 配置变更混进代码变更, 且 JSON 里没有注释的位置
 *      来解释"为什么要按这个顺序跑".
 *
 * 收敛成这一个入口之后: test/ 顶层只剩本文件 + 少量还没搬完的脚本; 套件清单是
 * 代码, 顺序与依赖能被注释说明; npm test 的对外语义(一次跑完全部套件, 非零
 * 退出即失败)完全不变, 所以 CI 一个字都不用改.
 *
 * ## 为什么用一个子进程跑每个套件, 而不是 import
 *
 * 这些套件各自会起 mock 上游,监听端口,改全局 fetch.同进程串行 import 会让
 * 它们的全局状态互相污染(实测: smoke 的 mock fetch 会被后一个套件继承).
 * 子进程隔离与原来的 && 链语义完全一致, 只是把调度从 shell 搬到了 Node.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 测试目录(相对本文件). */
const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)

/**
 * 套件清单, 按依赖顺序.
 *
 * 顺序不是随意的: smoke 建的是整套调度/会话的 mock 上游, 它的断言最全;
 * 后面的 verify-* 是各自独立的真源对账, 不依赖 smoke 的产物.因此顺序只影响
 * "先看到哪一类失败", 不影响正确性 ---- 但保持稳定顺序能让失败信息可复现.
 */
const SUITES = [
  ['smoke', 'suites/entries/smoke/smoke.mjs'],
  ['smoke-frontend', 'suites/entries/smoke/smoke-frontend.mjs'],
  ['model-name-chain', 'suites/entries/verify/model-name-chain.mjs'],
  ['catalog-models', 'suites/entries/verify/catalog-models.mjs'],
  ['model-mapping-truth', 'suites/entries/verify/model-mapping-truth.mjs'],
  ['tool-name-mapping', 'suites/entries/verify/tool-name-mapping.mjs'],
]

let failed = 0
const started = Date.now()
for (const [label, rel] of SUITES) {
  const file = path.join(TEST_DIR, rel)
  if (!fs.existsSync(file)) {
    // 套件文件不存在时必须报错而不是跳过: "少跑一个套件"与"那个套件全绿"
    // 在退出码上完全一样, 是最危险的静默失效.
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
