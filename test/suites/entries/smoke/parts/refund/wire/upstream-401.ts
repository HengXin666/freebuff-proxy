/**
 * refund: 上游 401 的真值
 *
 * 401 的真值回执与映射后的错误码.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { loadConfig } from '../../../../../../../src/config.ts'
import assert from 'node:assert/strict'

/* ================================================================
   回归:上游 401 必须归一成 auth_unauthorized(不是裸 unauthorized)
   ================================================================ */
{
  const origFetch = globalThis.fetch
  /**
   * 上游 401 的真值:
   * 无效 token → 401 {"error":"unauthorized","message":"Invalid API key"}
   * 无 token   → 401 {"error":"unauthorized","message":"Missing or invalid Authorization header"}
   */
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: 'unauthorized', message: 'Invalid API key' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )
  const { createUpstreamClient } = await import('../../../../../../../src/upstream/client.ts')
  const cfg = loadConfig()
  const cli = createUpstreamClient(cfg, 'bad-token', { accountId: 'u401' })
  let caught = null
  try {
    await cli.freebuffSession('GET')
  } catch (err) {
    caught = err
  }
  globalThis.fetch = origFetch
  assert.ok(caught, '401 必须抛出（不得被当成成功回执吞掉）')
  assert.equal(caught.status, 401)
  /**
   * - code 必须归一成 auth_unauthorized: 直接取 body.error = unauthorized 时,
   * - 前端 probeReason() 的宽匹配 includes('unauthorized') 会把网络/出口类 401
   * 也判成凭证失效.
   */
  assert.equal(
    caught.code,
    'auth_unauthorized',
    `401 必须归一成 auth_unauthorized，got ${caught.code}`,
  )
  // 上游原文必须带走:只说"凭证无效"用户不知道是 key 失效还是头没带
  assert.match(caught.message, /Invalid API key/, '错误消息必须带上游原文')
  assert.equal(caught.body?.error, 'unauthorized')
}
