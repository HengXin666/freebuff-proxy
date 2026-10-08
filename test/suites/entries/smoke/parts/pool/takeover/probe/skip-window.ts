/**
 * pool: 被跳过的探测不得开窗
 *
 * 有在途请求时 SessionManager.refresh 会自跳过(只置 lastProbeSkipped, 不碰上游),
 * 那不是[问过了] ---- 开了退避窗, 在途请求结束后真正想探测时会被挡住, 拿不到上游
 * 刚出现的可接管会话.
 *
 * 判据(可证伪): 去掉 probeUpstream 里 lastProbeSkipped 的判断 ->
 * 红在[被跳过的探测不得开窗].
 */

import { buildAppContext } from '../../../../../../../../src/app-context.ts'
import { makePaidUpstreamChecker } from '../../../../../../../../src/context/sched/account-gates.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- 被跳过的探测不得开窗 ---
{
  /**
   * 判据(可证伪): 把 probeUpstream 里 lastProbeSkipped 的判断去掉(即只要 refresh
   * 走了就开窗)-> 本条红(窗口被开, 在途请求结束后第一次真正探测被挡住).
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-skip-window-'))
  const cfgMod = await import('../../../../../../../../src/config.ts')
  const cfg = cfgMod.loadConfig()
  cfg.upstream.credentialsDir = dir
  cfg.session.pollIntervalSec = 3600
  fs.writeFileSync(
    path.join(dir, 'sk.json'),
    JSON.stringify({ id: 'sk', email: 'sk@example.com', authToken: 'tok-sk' }),
  )
  const ctx = buildAppContext(cfg)
  const rt = ctx.runtimes.get('sk')
  const MODEL = 'deepseek/deepseek-v4-flash'
  let probes = 0
  let skipping = true
  rt.sessions.refresh = async () => {
    probes += 1
    // 有在途请求: refresh 自跳过, 只置 lastProbeSkipped, 不碰上游
    rt.sessions.lastProbeSkipped = skipping
    return { status: 'none' }
  }
  const emailByKey = new Map([['sk', 'sk@example.com']])
  await makePaidUpstreamChecker(rt, 'sk', MODEL, emailByKey)()
  assert.equal(
    Number(rt.paidProbeRetryAt) || 0,
    0,
    '被跳过的探测(有在途请求)不得开窗, 否则在途结束后真探测被挡 60s, got ' +
      Number(rt.paidProbeRetryAt),
  )
  // 在途请求结束后必须立刻允许再探一次
  skipping = false
  await makePaidUpstreamChecker(rt, 'sk', MODEL, emailByKey)()
  assert.equal(probes, 2, '在途请求结束后应能立刻再探一次, got ' + probes)
  assert.ok(
    Number(rt.paidProbeRetryAt) > Date.now(),
    '这次确实问了上游, 窗口这时才该开',
  )
  // 跨请求退避的直接判据: 紧接着再调一次不得再问上游(与冷却/排序无关).
  await makePaidUpstreamChecker(rt, 'sk', MODEL, emailByKey)()
  assert.equal(
    probes,
    2,
    '开了窗之后的紧接着一次调用不得再探测(跨请求退避), got ' + probes,
  )
  await ctx.runtimes.shutdown().catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
}
