/**
 * freebucks: 两道闸门与扣费顺序
 *
 * 粘性调度下 warm 请求落同一账号; 428 等候室必须带同一 instanceId 续用那一小时, 不得被买不起下一小时拦下.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { state } from '../../../../../smoke/state.ts'
import { fbChat, fbConfig, fbRuntimes, futureReset } from '../refund/fixture.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// (2.2) 同号重试(forceReadmit)也必须过额度闸门:它会先 DELETE 再 admit,
//       等于新买一条计费会话.余额买不起还去 admit,正好命中上游
//       "所需 Freebucks > 余额 → 直接封号"的判定----这是最现实的一条封号路径.
{
  const model = 'deepseek/deepseek-v4-flash'
  const fbLow = {
    balance: 0.5,
    daily: { limit: 25, spent: 24.5, remaining: 0.5, resetAt: futureReset },
    wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
    prices: { [model]: 2 },
    quotaExempt: false,
    planId: null,
    monthly: null,
    peak: null,
    updatedAt: new Date().toISOString(),
  }
  for (const key of ['a', 'b', 'c']) {
    fbRuntimes.get(key).sessions.freebucks = { ...fbLow }
  }
  // 同号 gate 重试路径:给一个 session 可恢复的 gate code,走 forceReadmit 分支
  const postsBefore = state.sessionPosts
  let threw = null
  try {
    await fbRuntimes.reacquireAfterGate(model, {
      preferredKey: 'a',
      gateCode: 'session_expired',
    })
  } catch (err) {
    threw = err
  }
  assert.ok(threw, '余额不足时同号重试必须失败，而不是硬买一条新会话')
  assert.equal(
    threw.code,
    'freebucks_exhausted',
    `应报 freebucks_exhausted，got ${threw.code}: ${threw.message}`,
  )
  assert.equal(
    state.sessionPosts,
    postsBefore,
    '余额不足不得经 forceReadmit 再 admit 新会话（再买断一小时 + 触发封号判定）',
  )
  fbRuntimes.clearCooldown('a', model)
}

// (2.4) session_units 是独立于 Freebucks 的第二道闸门:一手实测证明一笔会话
//       两本账都扣(units +1.0 且 Freebucks −单价),所以 units 用尽时同样不得
//       去 admit(上游会用 rate_limited 拒掉,白跑一次往返).注意 recentCount
//       是小数,比较必须用 >=.见
//       .agents/notes/implemented/architecture/2026-09-14-two-ledgers-parallel-gates.md
{
  const model = 'deepseek/deepseek-v4-flash'
  // Freebucks 故意留得足足的 ---- 只有 units 卡住,才能证明两道闸门是独立的.
  for (const key of ['a', 'b', 'c']) {
    const sm = fbRuntimes.get(key).sessions
    sm.freebucks = {
      balance: 999,
      daily: { limit: 999, spent: 0, remaining: 999, resetAt: futureReset },
      wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
      prices: { [model]: 2 },
      quotaExempt: false,
      planId: null,
      monthly: null,
      peak: null,
      updatedAt: new Date().toISOString(),
    }
    // units 已满:6/6(实测里 recentCount 可为小数,这里同时覆盖整数边界).
    sm.quota = {
      byModel: {
        [model]: {
          model,
          limit: 6,
          pool: 'limited',
          poolLabel: 'Daily',
          resetAt: futureReset,
          recentCount: 6,
        },
      },
      rateLimit: null,
      updatedAt: new Date().toISOString(),
    }
    await sm.release()
    const u = sm.sessionUnitsFor(model)
    assert.equal(u.known, true, `${key} 应识别出 units 账本`)
    assert.equal(u.exhausted, true, `${key} units 6/6 应判为用尽`)
    assert.equal(u.remaining, 0, `${key} 剩余应为 0`)
    // 小数边界:5.4/6 未满,6/6 已满(不能用整数假设)
    assert.equal(
      sm.sessionUnitsFor(model).exhausted,
      true,
      'units 比较必须覆盖等号边界',
    )
  }
  const postsBefore = state.sessionPosts
  const res = await fbChat({
    model,
    messages: [{ role: 'user', content: 'units-gate' }],
  })
  assert.equal(res.status, 429, await res.clone().text())
  const j = await res.json()
  assert.equal(
    j.error.code,
    'units_exhausted',
    `全账号 units 用尽应报 units_exhausted，got ${JSON.stringify(j.error)}`,
  )
  assert.equal(
    state.sessionPosts,
    postsBefore,
    'units 用尽不得再 admit 新会话（两本账都扣，白跑一次往返）',
  )
  // fail-open:没有 units 行的模型不得被这道闸门误拦.
  const noRow = fbRuntimes.get('a').sessions.sessionUnitsFor('openai/gpt-5.6-nope')
  assert.equal(noRow.known, false, '无 units 行的模型必须 fail-open')
  assert.equal(noRow.exhausted, false, '无 units 行的模型不得被判用尽')
  // 清场:后续用例不该继承这里的 6/6(否则会一直被 units 闸门拦下).
  for (const key of ['a', 'b', 'c']) fbRuntimes.get(key).sessions.quota = null
}

// (2.5) 重启后额度闸门不得失忆:账号账本(account-state.json)落盘 →
//       新进程起来后仍知道"这个号余额买不起",不会拿重启当重置去撞已知
//       余额不足的账号(那正是封禁的触发条件).
{
  const model = 'deepseek/deepseek-v4-flash'
  // 把 a 标成"余额 0.5 < 单价 2",走完整落盘路径(不是直接改内存).
  const smA = fbRuntimes.get('a').sessions
  smA.freebucks = {
    balance: 0.5,
    daily: { limit: 25, spent: 24.5, remaining: 0.5, resetAt: futureReset },
    wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
    prices: { [model]: 2 },
    quotaExempt: false,
    planId: null,
    monthly: null,
    peak: null,
    updatedAt: new Date().toISOString(),
  }
  fbRuntimes._persistAccountState('a', { freebucks: smA.freebucks })
  fbRuntimes.accountState.flush()

  const stateFile = fbRuntimes.accountState.file
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.ok(
    onDisk.accounts?.a?.freebucks,
    'freebucks 必须落盘（否则重启后闸门失忆）',
  )
  assert.equal(onDisk.accounts.a.freebucks.balance, 0.5)
  assert.ok(onDisk.accounts?.a?.firstSeenAt, '账号加入时间必须落盘')
  assert.equal(
    typeof onDisk.accounts?.a?.requests,
    'number',
    '请求计数必须落盘',
  )

  // 模拟"进程重启":同一 dataDir 上重新构造一套 runtime.
  const restarted = new AccountRuntimes(fbConfig)
  const rtA = restarted.get('a')
  assert.equal(
    rtA.sessions.freebucks?.balance,
    0.5,
    '重启后必须从账本回灌 freebucks',
  )
  const fbAfter = rtA.sessions.freebucksFor(model)
  assert.equal(fbAfter.known, true, '重启后额度应仍是"已知"（不得 fail-open）')
  assert.equal(
    fbAfter.affordable,
    false,
    '重启后仍必须判定为买不起（fail-open 就等于拿重启当额度重置）',
  )
  await restarted.shutdown()
}

// (2.6) 账本回灌的前缀撞车:账号 key "acc" 与 "acc2" 是不同账号,冷却/记录
//       绝不能因为 startsWith 就互相串台(单字符 key 的用例测不出来).
{
  const pDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-prefix-'))
  try {
    saveAccountUser(pDir, { id: 'acc', email: 'acc@x.com', authToken: 't1' })
    saveAccountUser(pDir, { id: 'acc2', email: 'acc2@x.com', authToken: 't2' })
    const pCfg = loadConfig()
    pCfg.upstream.credentialsDir = pDir
    pCfg.session.pollIntervalSec = 3600
    const p1 = new AccountRuntimes(pCfg)
    p1.get('acc')
    p1.get('acc2')
    // 只冷却 acc2(账号级 + 模型级各一条),走真实 markCooldown 路径
    p1.markCooldown('acc2', { code: 'rate_limited' })
    p1.markCooldown('acc2', { code: 'model_unavailable' }, 'some/model')
    // 关键:触发一次针对 acc 的归集(clearCooldown 也会写账本).
    // 没有这一步,startsWith('acc') 的撞车永远不会真正发生----acc 从不被写,
    // 于是 bug 潜伏而测试恒绿(第一版就是这么写空的).
    p1.clearCooldown('acc')
    p1.accountState.flush()

    // 归集必须精确:acc2 的冷却绝不能写进 acc 的记录(startsWith("acc")
    // 会把 "acc2" 一起匹配进来----单字符 key 的用例测不出这种前缀撞车).
    const accRec = p1.accountState.account('acc')
    assert.ok(
      !accRec.cooldowns || Object.keys(accRec.cooldowns).length === 0,
      `acc 的记录不得含任何冷却，got ${JSON.stringify(accRec.cooldowns)}`,
    )
    const acc2Rec = p1.accountState.account('acc2')
    assert.ok(
      acc2Rec.cooldowns?.acc2,
      'acc2 的账号级冷却应记在 acc2 自己名下',
    )
    assert.ok(
      acc2Rec.cooldowns?.['acc2\0some/model'],
      'acc2 的模型级冷却应记在 acc2 自己名下',
    )

    // 回灌同样要精确
    const p2 = new AccountRuntimes(pCfg)
    p2.get('acc')
    p2.get('acc2')
    assert.equal(
      p2.isCoolingDown('acc'),
      false,
      'acc 不得继承 acc2 的冷却（前缀撞车）',
    )
    assert.equal(p2.isCoolingDown('acc2'), true, 'acc2 的账号级冷却应回灌')
    assert.equal(
      p2.isCoolingDown('acc2', 'some/model'),
      true,
      'acc2 的模型级冷却应回灌',
    )
    await p2.shutdown()
    // 封禁时间要落盘:chat 阶段撞到 banned 与探测发现 banned 同等重要,
    // 控制台"已被封禁"分区靠它(否则重启后这个号会被当成干净号).
    const p3 = new AccountRuntimes(pCfg)
    p3.get('acc')
    p3.markCooldown('acc', { code: 'banned' })
    p3.accountState.flush()
    assert.ok(
      p3.accountState.account('acc').bannedAt,
      'banned 冷却必须记下 bannedAt',
    )
    const p4 = new AccountRuntimes(pCfg)
    const accRow = p4.list().find((x) => x.key === 'acc')
    assert.ok(accRow.bannedAt, '重启后 bannedAt 仍应在账号列表里')
    await p3.shutdown()
    await p4.shutdown()
  } finally {
    fs.rmSync(pDir, { recursive: true, force: true })
  }
}
