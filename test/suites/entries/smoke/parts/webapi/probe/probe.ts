/**
 * web api: 账号探测与运行设置
 *
 * probe 只读刷新 session 与额度缓存; 运行设置(开关 / 并发上限 / 额度保护)保存即生效并持久化.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { SettingsStore } from '../../../../../../../src/web/store/config/settings-store.ts'
import { cookie, settingsStore, wDir, wport } from './fixture.ts'
import assert from 'node:assert/strict'
import path from 'node:path'

const pr = await fetch(`http://127.0.0.1:${wport}/api/accounts/probe`, {
  method: 'POST',
  headers: { cookie },
})
assert.equal(pr.status, 200)
const pj = await pr.json()
assert.equal(pj.results.length, 1)
assert.equal(pj.results[0].ok, true)
assert.equal(pj.accounts[0].email, 'w@example.com')
// mock GET 返回 status none → 探测后 session 状态可见
assert.equal(pj.accounts[0].session.status, 'none')
// 账号凭证:任意已登录用户可查看完整凭据(含 authToken),404 与 401 正确
{
  const cred = await fetch(`http://127.0.0.1:${wport}/api/accounts/w/credential`, {
    headers: { cookie },
  })
  assert.equal(cred.status, 200)
  const cj = await cred.json()
  assert.equal(cj.ok, true)
  assert.equal(cj.key, 'w')
  assert.equal(cj.credential.email, 'w@example.com')
  assert.equal(cj.credential.authToken, 'token-w')
  assert.equal(cj.credential.id, 'w')

  const missing = await fetch(`http://127.0.0.1:${wport}/api/accounts/nope/credential`, {
    headers: { cookie },
  })
  assert.equal(missing.status, 404)

  const anon = await fetch(`http://127.0.0.1:${wport}/api/accounts/w/credential`)
  assert.equal(anon.status, 401)
}
// 运行设置:默认开启,保存关闭后立即返回并持久化,重建 store 仍为关闭
{
  const getDefault = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    headers: { cookie },
  })
  assert.equal(getDefault.status, 200)
  assert.equal((await getDefault.json()).freeToolSignatureEnabled, true)

  const invalid = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ freeToolSignatureEnabled: 'no' }),
  })
  assert.equal(invalid.status, 400)

  const saveSetting = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ freeToolSignatureEnabled: false }),
  })
  assert.equal(saveSetting.status, 200)
  assert.equal((await saveSetting.json()).freeToolSignatureEnabled, false)
  assert.equal(settingsStore.get().freeToolSignatureEnabled, false)
  assert.equal(
    new SettingsStore(path.join(wDir, 'settings.json')).get()
      .freeToolSignatureEnabled,
    false,
  )
}
// 运行设置:账号并发上限(粘性调度)----默认 2,校验非法值,保存后持久化
{
  const getDefault = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    headers: { cookie },
  })
  assert.equal((await getDefault.json()).accountMaxConcurrency, 2)

  for (const bad of [0, -1, 17, 1.5, 'x']) {
    const res = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accountMaxConcurrency: bad }),
    })
    assert.equal(res.status, 400, `accountMaxConcurrency=${bad} should be rejected`)
  }

  const save = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accountMaxConcurrency: 4 }),
  })
  assert.equal(save.status, 200)
  assert.equal((await save.json()).accountMaxConcurrency, 4)
  assert.equal(settingsStore.get().accountMaxConcurrency, 4)
  assert.equal(
    new SettingsStore(path.join(wDir, 'settings.json')).get()
      .accountMaxConcurrency,
    4,
  )
  // 恢复默认,避免影响其他用例
  await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accountMaxConcurrency: 1 }),
  })
}
// 运行设置:额度保护(空闲释放 + 单请求新会话预算)----非法值拒绝,保存即持久化
{
  const getDefault = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    headers: { cookie },
  })
  const def = await getDefault.json()
  // 早退 DELETE 不退 Freebucks(只回 pending, 见文档 §3.7), 所以默认回到
  // 60s: 付费时段结束后尽快腾出槽位给别的模型(早退省不下钱, 只丢掉已买断的一小时).
  assert.equal(def.idleReleaseSec, 60, '未保存过时应回落 config.yaml 默认值')
  assert.ok(
    def.idleReleaseSec > 0 && def.idleReleaseSec <= 300,
    '默认空闲释放应在 5s..300s 内：付费时段结束后尽快腾槽位，而不是为省钱早退',
  )
  assert.equal(def.maxNewSessionsPerRequest, 2)

  for (const bad of [-1, 'x', null, 999999]) {
    const res = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ idleReleaseSec: bad }),
    })
    assert.equal(res.status, 400, `idleReleaseSec=${bad} should be rejected`)
  }

  // 下限放宽到 5s:1..4 吸附到 5s(避免把每个回合切成一条新会话)
  const tiny = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ idleReleaseSec: 1 }),
  })
  assert.equal(tiny.status, 200)
  assert.equal((await tiny.json()).idleReleaseSec, 5, '1s 应被夹到最小生效值 5s')

  const save = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ idleReleaseSec: 600, maxNewSessionsPerRequest: 3 }),
  })
  assert.equal(save.status, 200)
  assert.equal((await save.json()).idleReleaseSec, 600)
  assert.equal(settingsStore.get().idleReleaseSec, 600)
  assert.equal(settingsStore.get().maxNewSessionsPerRequest, 3)
  const persisted = new SettingsStore(path.join(wDir, 'settings.json')).get()
  assert.equal(persisted.idleReleaseSec, 600, '保存后应持久化到 settings.json')
  assert.equal(persisted.maxNewSessionsPerRequest, 3)
}
