/**
 * unit: loadConfig 不得污染全局 DEFAULTS
 *
 * 深拷贝缺失会导致跨用例污染.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { loadConfig } from '../../../../../../src/config.ts'
import assert from 'node:assert/strict'

// --- unit: loadConfig 不得污染全局 DEFAULTS(深拷贝缺失的 bug) ---
// 场景: deepMerge 用 { ...base } 浅拷贝时, 无 config.yaml 时 fileConfig={},
// 嵌套的 session/limits/web/upstream 与 DEFAULTS 共享同一对象;任何一处
// config.session.xxx = y(测试与运行时代码都这么改)都会改写 DEFAULTS,
// 使同一进程内后续所有 loadConfig() 拿到被改坏的配置.有 config.yaml 时因递归
// 新建对象而被掩盖.
{
  const { DEFAULTS } = await import('../../../../../../src/config.ts')
  const snapshot = JSON.stringify(DEFAULTS)
  const c = loadConfig()
  // 模拟调用方就地改写配置(smoke 其它块与运行时都这么做)
  c.session.idleReleaseSec = 0.15
  c.limits.maxNewSessionsPerRequest = 99
  c.limits.accountMaxConcurrency = 7
  c.web.sessionTtlHours = 1
  c.upstream.proxies.push('http://pushed.example:1')
  assert.equal(
    JSON.stringify(DEFAULTS),
    snapshot,
    '修改 loadConfig() 的结果不得改动全局 DEFAULTS（需深拷贝）',
  )
  const again = loadConfig()
  assert.equal(again.session.idleReleaseSec, JSON.parse(snapshot).session.idleReleaseSec, '后续 loadConfig 必须拿到干净默认值')
  assert.equal(again.limits.maxNewSessionsPerRequest, 2)
  assert.equal(again.limits.accountMaxConcurrency, 2)
  assert.equal(again.web.sessionTtlHours, 24 * 7)
  assert.deepEqual(again.upstream.proxies, [])

  // 嵌套对象/数组必须与 DEFAULTS 无共享引用
  const d = loadConfig()
  assert.notEqual(d.session, DEFAULTS.session, '嵌套对象不得共享引用')
  assert.notEqual(d.limits, DEFAULTS.limits, '嵌套对象不得共享引用')
  assert.notEqual(d.upstream.proxies, DEFAULTS.upstream.proxies, '数组不得共享引用')
}
