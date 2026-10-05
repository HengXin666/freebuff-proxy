/**
 * teardown: 拆掉 mock 与临时目录
 *
 * 还原 globalThis.fetch, 删临时目录, 打印 smoke ok. 之后的用例只用动态 import, 不再需要 mock 上游.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../smoke/state.ts'
import { tmpDir } from '../../harness/runtime.ts'
import fs from 'node:fs'

globalThis.fetch = state.originalFetch
fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('smoke ok')
