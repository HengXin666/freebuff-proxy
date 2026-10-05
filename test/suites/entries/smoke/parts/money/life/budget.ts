/**
 * freebucks: 新会话预算
 *
 * 单请求最多新建 maxNewSessionsPerRequest 条会话, 其余走有界排队.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { waitFor } from '../../../harness/helpers.ts'
import { fbChat, fbRuntimes } from '../refund/fixture.ts'
import assert from 'node:assert/strict'

// (3) 单请求新会话预算:chat 一直 500(账号级故障 → 换号),3 个账号最多
//     新建 2 个计费会话,不会把每个账号都买一条计费会话.
state.mockFreebucks = null
// 清掉 (2) 里缓存的"余额 0.5": 留着它这一步会被余额拦截, 测不到预算
for (const key of ['a', 'b', 'c']) fbRuntimes.get(key).sessions.freebucks = null
state.mockMode = 'err_500_all'
state.sessionPosts = 0
state.sessionDeletes = 0
state.completionAttempts = 0
{
  const res = await fbChat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(res.status, 429, await res.clone().text())
  const j = await res.json()
  // 全部账号都只是被[本次请求的新会话预算]拦下 ---- 必须报独立错误码,
  // 不能混成笼统的 no_available_account(那会让用户去查账号/上游额度,
  // 而真正该做的是重试或调高[额度保护]→ 单请求新会话上限).
  assert.equal(j.error.code, 'session_budget_exhausted')
  assert.equal(state.sessionPosts, 2, `新会话预算 2，不得轮询全部账号，got ${state.sessionPosts}`)
  assert.ok(
    (j.error.details?.failures || []).every(
      (f) => f.code === 'session_budget_exhausted',
    ),
    '应记录 session_budget_exhausted',
  )
  /**
   * - 断言: 付费时段内(expiresAt 未到)不释放已买断的会话.
   *
   * 上游对早退 DELETE 只回 freebucksRefundPending(观察 2 分钟未到账),
   * Freebucks 是买断制(POST 当场扣整小时单价), 释放等于扔掉已付的钱.
   * 留着它下一跳还能续用(readmitToContinue), 闲置不额外花钱.
   *
   * - 本用例的 mock 会话是 Date.now() + 3600_000(+1 小时),
   * - 所以期望是 sessionDeletes === 0.
   *
   * "不能空挂后台"由付费时段结束后的释放保证(另见 idle release 与
   * release_on_shutdown 的用例).
   */
  await waitFor('付费时段内未释放已买断的会话', () => state.sessionPosts >= 2, 3_000)
  assert.equal(
    state.sessionDeletes,
    0,
    `付费时段内不得 DELETE 已买断的会话（那是直接烧钱），got ${state.sessionDeletes}`,
  )
}
