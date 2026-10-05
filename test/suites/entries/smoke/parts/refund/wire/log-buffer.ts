/**
 * refund: 日志环形缓冲
 *
 * 缓冲容量与级别过滤.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import assert from 'node:assert/strict'

/* ================================================================
   回归:日志缓冲可清空 + 可按账号过滤
   ================================================================ */
{
  const { clearRing, readLogBuffer, configureLogBuffer, configureLogger, log } =
    await import('../../../../../../../src/util/log.ts')
  const cap = configureLogBuffer(100)
  // smoke 全局把 level 设成了 error,info 会被过滤掉;这里临时放开再还原.
  configureLogger({ level: 'info' })
  clearRing()
  log('info', 'alpha line', { account: 'a@gmail.com' })
  log('info', 'beta line', { account: 'b@outlook.com' })
  log('error', 'gamma line', { account: 'a@gmail.com' })
  assert.equal(readLogBuffer().length, 3, 'info 级别必须能进缓冲')

  // 按账号过滤:后端早已支持,但前端从未传 ---- 这里钉住它不被简化掉.
  const onlyA = readLogBuffer({ account: 'a@gmail.com' })
  assert.equal(onlyA.length, 2, 'account 过滤必须命中该账号的两条')
  assert.ok(onlyA.every((l) => l.account === 'a@gmail.com'))
  const onlyB = readLogBuffer({ account: 'b@outlook.com' })
  assert.equal(onlyB.length, 1)
  // 大小写不敏感(用户手打邮箱不会刻意对齐大小写)
  assert.equal(readLogBuffer({ account: 'A@GMAIL.COM' }).length, 2)

  // 级别过滤仍然有效(不能被 account 分支挤掉)
  assert.equal(readLogBuffer({ level: 'error' }).length, 1)

  // 清空:控制台[清空]按钮依赖它
  clearRing()
  assert.equal(readLogBuffer().length, 0, '清空后必须为空')
  configureLogger({ level: 'error' })
  configureLogBuffer(cap)
}
