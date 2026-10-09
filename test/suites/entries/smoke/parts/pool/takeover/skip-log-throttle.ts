/**
 * pool: 拦截日志限频表的容量契约
 *
 * 表必须有硬上限, 且不得为腾位置删掉未过期的记录(删了就等于让那个账号在窗口内
 * 又记一条, 限频被自己的清理破坏).
 *
 * 判据(可证伪): 表满去掉上限 -> 红在[必须有硬上限]; 表满改回淘汰最旧 ->
 * 红在窗口内未过期的记录不得被清理删除.
 */

import { configureLogger, skipLogOnce } from '../../../../../../../src/util/log.ts'
import assert from 'node:assert/strict'

// --- (5) 限频窗口表有硬上限, 且不得为腾位置删掉未过期的记录 -----------------
{
  const originalLog = console.log
  configureLogger({ level: 'info' })
  console.log = () => {}
  try {
    /**
     * 判据(可证伪):
     *  - 去掉表满时的判断(即无上限)-> 红在[表大小不得越上限];
     *  - 改回[表满就淘汰最旧]-> 红在k0 的记录不得被清理删除 k0 是最旧的, 会被删.
     */
    const pool: any = {}
    const N = 600
    for (let i = 0; i < N; i++) {
      skipLogOnce(pool, 'k' + i, 'freebucks_exhausted', 'skip account: x', { key: 'k' + i })
    }
    assert.ok(
      pool._skipLogSeen.size <= 513,
      '限频窗口表必须有界(回收阈值 512, 允许 +1), got ' + pool._skipLogSeen.size,
    )
    assert.ok(
      pool._skipLogSeen.has('freebucks_exhausted\0k0'),
      '窗口内未过期的记录不得被清理删除(它会因此在窗口内再记一条)',
    )
  } finally {
    console.log = originalLog
    configureLogger({ level: 'error' })
  }
}

// --- 被级别过滤的 info 不开窗, 恢复 info 后首条立即输出 ---
{
  const originalLog = console.log
  const lines: string[] = []
  console.log = (text: string) => lines.push(text)
  try {
    for (const level of ['warn', 'error']) {
      const pool: any = {}
      configureLogger({ level })
      const filtered = skipLogOnce(pool, 'visible', 'units_exhausted', 'skip account: visible', {})
      assert.equal(filtered, false, `${level} 下 info 被过滤应返回 false, got ${filtered}`)
      assert.equal(pool._skipLogSeen, undefined, `${level} 下不应创建窗口表`)
      const fallback = skipLogOnce(null, 'visible', 'units_exhausted', 'skip account: fallback', {})
      assert.equal(fallback, false, `${level} 下无 self 回退应返回 false, got ${fallback}`)
      assert.equal(lines.length, 0, `${level} 下应无输出, got ${lines.length}`)
      configureLogger({ level: 'info' })
      const emitted = skipLogOnce(pool, 'visible', 'units_exhausted', 'skip account: visible', {})
      assert.equal(emitted, true, `恢复 info 后首条应立即输出, got ${emitted}`)
      assert.equal(lines.length, 1, `恢复 info 后应输出一条, got ${lines.length}`)
      const id = 'units_exhausted\0visible'
      const timestamp = pool._skipLogSeen.get(id)
      const size = pool._skipLogSeen.size
      configureLogger({ level })
      const suppressed = skipLogOnce(pool, 'visible', 'units_exhausted', 'skip account: visible', {})
      assert.equal(suppressed, false, `${level} 下已有窗口的调用应返回 false, got ${suppressed}`)
      assert.equal(pool._skipLogSeen.get(id), timestamp, `${level} 下已有窗口时间戳不得改变`)
      assert.equal(pool._skipLogSeen.size, size, `${level} 下已有窗口表大小不得改变`)
      assert.equal(lines.length, 1, `${level} 下已有窗口的调用不得输出, got ${lines.length}`)
      configureLogger({ level: 'info' })
      const repeated = skipLogOnce(pool, 'visible', 'units_exhausted', 'skip account: visible', {})
      assert.equal(repeated, false, `已输出的同一键应受窗口限制, got ${repeated}`)
      assert.equal(lines.length, 1, `窗口内重复调用不得输出, got ${lines.length}`)
      const visibleFallback = skipLogOnce(null, 'visible', 'units_exhausted', 'skip account: fallback', {})
      assert.equal(visibleFallback, true, `info 下无 self 回退应输出, got ${visibleFallback}`)
      assert.equal(lines.length, 2, `info 下无 self 回退应增加一条输出, got ${lines.length}`)
      lines.length = 0
    }
  } finally {
    console.log = originalLog
    configureLogger({ level: 'error' })
  }
}
console.log('拦截日志限频容量与可见输出验证通过(warn, error, info 与无 self 回退)')
