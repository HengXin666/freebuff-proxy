/**
 * billing: 上游客户端
 *
 * createUpstreamClient 的端点与错误映射.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { loadConfig } from '../../../../../../../src/config.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 登录链路的瞬时故障重试与可诊断原因码(issue #22 / PR #23).
//
// 为什么必须钉住:buildFetchWithProxy 的池内回落只存在于 kind==='pool',
// 而"代理设置留空"(官方推荐的家庭部署)返回 kind:'none' → 裸 fetch 零回落.
// 修复靠 fetchLoginUpstream 补一次重试,并把失败翻译成稳定原因码.
// 这里钉三件事:重试只发生一次,code 是稳定业务码,cause 保留底层原始码.
{
  const { createUpstreamClient } = await import('../../../../../../../src/upstream/client.ts')
  const loginCfg = loadConfig()
  loginCfg.upstream.apiBase = 'http://127.0.0.1:9'
  loginCfg.upstream.loginBase = 'http://127.0.0.1:9'
  loginCfg.upstream.credentialsDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'fb-loginprobe-'),
  )
  const client = createUpstreamClient(loginCfg, '', { accountId: 'loginprobe' })

  const realFetch = globalThis.fetch
  /** @type {string[]} */
  const seen = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    seen.push(u)
    throw Object.assign(new Error('probe fetch failed'), {
      name: 'TypeError',
      code: 'ECONNREFUSED',
    })
  }
  let caught = null
  try {
    await client.loginCode('fp-loginprobe')
  } catch (err) {
    caught = err
  }
  globalThis.fetch = realFetch
  fs.rmSync(loginCfg.upstream.credentialsDir, { recursive: true, force: true })

  assert.ok(caught, 'loginCode 最终必须抛出（不可静默吞掉）')
  // 1) 重试一次:只算登录端点,目录抓取不算进来
  const loginCalls = seen.filter((u) => u.includes('/api/auth/cli/code'))
  assert.equal(loginCalls.length, 2, `登录应尝试 2 次（重试一次）, got ${loginCalls.length}`)
  // 2) code 是稳定业务码,不是裸 socket 码
  assert.equal(caught.code, 'upstream_network', `code 应为稳定业务码, got ${caught.code}`)
  // 3) cause 保留底层原始错误码(排障要能看见)
  assert.equal(caught.cause, 'ECONNREFUSED', `cause 应保留底层码, got ${caught.cause}`)
  // 4) 给人看的 message 里也要带底层码
  assert.match(caught.message, /ECONNREFUSED/, 'message 应含底层码供肉眼排查')
}
