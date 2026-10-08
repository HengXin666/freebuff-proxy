/**
 * pool: 拦截日志限频表的容量契约
 *
 * 表必须有硬上限, 且不得为腾位置删掉未过期的记录(删了就等于让那个账号在窗口内
 * 又记一条, 限频被自己的清理破坏).
 *
 * 判据(可证伪): 表满去掉上限 -> 红在[必须有硬上限]; 表满改回淘汰最旧 ->
 * 红在窗口内未过期的记录不得被清理删除.
 */

import { skipLogOnce } from '../../../../../../../src/util/log.ts'
import assert from 'node:assert/strict'

// --- (5) 限频窗口表有硬上限, 且不得为腾位置删掉未过期的记录 -----------------
{
  /**
   * 判据(可证伪):
   *  - 去掉表满时的判断(即无上限)-> 红在[表大小不得越上限];
   *  - 改回[表满就淘汰最旧]-> 红在k0 的记录不得被清理删除 k0 是最旧的, 会被删.
   */
  const { skipLogOnce } = await import('../../../../../../../src/util/log.ts')
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
}
