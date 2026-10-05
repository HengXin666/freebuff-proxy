/**
 * freebucks: 排队等 chat 锁
 *
 * 等 chat 锁的请求不得被空闲释放误删会话(选号阶段已 admit).
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { fbChat, fbConfig, fbRuntimes } from '../refund/fixture.ts'
import assert from 'node:assert/strict'

// (3.5) 单请求新会话预算 = 0 表示不限制(控制台 b || '不限',配置文档,
//       API 校验三处一致的契约).0 被存成 remaining:0 时,闸门会把每个账号都
//       判成 session_budget_exhausted 跳过,整个代理固定 429 no_available_account.
//       见 .agents/notes/implemented/bug-fix/2026-09-24-zero-session-budget-means-unlimited.md
for (const key of ['a', 'b', 'c']) fbRuntimes.clearCooldown(key)
fbConfig.limits.maxNewSessionsPerRequest = 0
state.mockFreebucks = null
for (const key of ['a', 'b', 'c']) fbRuntimes.get(key).sessions.freebucks = null
/**
 * - 必须显式清掉上一段留下的热会话.
 *
 * - 上一个用例"付费时段内不释放已买断的会话"会把会话留在原地(那一小时已付款).
 * 而本用例断言 sessionPosts === 1(首个请求应正常 admit),复用一个热 session
 * 就不会再 admit.
 *
 * - 所以本用例自足地建立前置状态.用 releaseStrict({force:true}) 真正结束它
 *   ---- 这里测的是预算语义, 不是付费时段保护, 所以显式要求连付费时段内也删
 *   (force 的唯一合法用途: 调用方明确了"我就是要删"这个意图).
 */
for (const key of ['a', 'b', 'c']) {
  await fbRuntimes.get(key).sessions.releaseStrict({ force: true }).catch(() => {})
}
state.mockMode = 'ok'
state.sessionPosts = 0
state.sessionDeletes = 0
state.completionAttempts = 0
{
  const res = await fbChat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'unlimited-budget' }],
  })
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(state.sessionPosts, 1, '0 = 不限制：首个请求仍应正常 admit')
}
// 预算不限时,故障换号不再被数字卡住:3 个账号全 500 时也不得报预算耗尽
// (预算为 0 被误当零预算时,这里会立刻抛 session_budget_exhausted).
for (const key of ['a', 'b', 'c']) fbRuntimes.clearCooldown(key)
state.mockMode = 'err_500_all'
state.sessionPosts = 0
state.sessionDeletes = 0
state.completionAttempts = 0
{
  const res = await fbChat({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'unlimited-budget-failover' }],
  })
  const j = await res.json()
  assert.equal(res.status, 429, JSON.stringify(j))
  assert.notEqual(
    j.error.code,
    'session_budget_exhausted',
    '0 = 不限制：不得再出现预算耗尽（那是本地自锁）',
  )
  assert.ok(
    !(j.error.details?.failures || []).some(
      (f) => f.code === 'session_budget_exhausted',
    ),
    '0 = 不限制：failures 里也不得有 session_budget_exhausted',
  )
}
