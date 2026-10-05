/**
 * web api: 代理池与账号删除
 *
 * 代理池 GET/POST 往返; probe 测试的死代理与空池; 账号删除的三个语义(成功即无活跃会话 / 上游删不掉不许谎报 / 未知账号 404).
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../../smoke/state.ts'
import { cookie, loginFlows, poolUrls, wConfig, wDir, wport, wruntimes, wserver } from '../probe/fixture.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// 代理管理 API:GET 空池 → POST 保存(持久化 + 立即生效)→ GET 返回
{
  const g1 = await fetch(`http://127.0.0.1:${wport}/api/proxy`, { headers: { cookie } })
  assert.equal(g1.status, 200)
  assert.deepEqual((await g1.json()).proxies, [])

  const post = await fetch(`http://127.0.0.1:${wport}/api/proxy`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ proxies: ['http://p1.example:7890', 'http://p2.example:7890', '  '] }),
  })
  assert.equal(post.status, 200)
  const pj = await post.json()
  assert.deepEqual(pj.proxies, ['http://p1.example:7890', 'http://p2.example:7890'])
  assert.ok(pj.note)

  // 持久化到 /data/proxies.json,且运行配置已更新
  const saved = JSON.parse(fs.readFileSync(path.join(wDir, 'proxies.json'), 'utf8'))
  assert.deepEqual(saved.proxies, ['http://p1.example:7890', 'http://p2.example:7890'])
  assert.deepEqual(wConfig.upstream.proxies, ['http://p1.example:7890', 'http://p2.example:7890'])

  // 新 runtime 使用新池(invalidateProxies 后重建)
  const rt = wruntimes.get('w')
  assert.ok(poolUrls.includes(rt.effectiveProxy))

  const g2 = await fetch(`http://127.0.0.1:${wport}/api/proxy`, { headers: { cookie } })
  assert.deepEqual((await g2.json()).proxies, ['http://p1.example:7890', 'http://p2.example:7890'])

  // 清空 → 全局池空
  await fetch(`http://127.0.0.1:${wport}/api/proxy`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ proxies: [] }),
  })
  assert.deepEqual(wConfig.upstream.proxies, [])
}

// proxy test: 未配置代理 → 空结果
const pt1 = await fetch(`http://127.0.0.1:${wport}/api/proxy/test`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: '{}',
})
assert.equal(pt1.status, 200)
const ptj1 = await pt1.json()
assert.equal(ptj1.results.length, 0)
assert.ok(ptj1.note)
// proxy test: 死代理 → ok:false + 错误信息(真连接尝试,localhost 立即拒绝)
const pt2 = await fetch(`http://127.0.0.1:${wport}/api/proxy/test`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ proxy: 'http://127.0.0.1:9' }),
})
assert.equal(pt2.status, 200)
const ptj2 = await pt2.json()
assert.equal(ptj2.results.length, 1)
assert.equal(ptj2.results[0].ok, false)
assert.equal(ptj2.results[0].proxy, 'http://127.0.0.1:9')
assert.ok(ptj2.results[0].error)
// 操作列[关闭会话]:用户主动结束该账号的上游计费会话.
// 三个关键语义:① 成功即无活跃会话 ② 上游删不掉时不得谎报成功,句柄必须保留
// (留给重启扫尾继续退款)③ 未知账号 404.
{
  const sm = wruntimes.get('w').sessions
  await sm.ensureSession('deepseek/deepseek-v4-flash')
  assert.ok(sm.getSnapshot().instanceId, '关闭前应有活跃会话')

  const res = await fetch(`http://127.0.0.1:${wport}/api/accounts/w/session`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(res.status, 200, await res.clone().text())
  const j = await res.json()
  assert.equal(j.ok, true, `关闭会话应成功：${JSON.stringify(j)}`)
  assert.equal(j.key, 'w')
  assert.equal(j.interrupted, false, '无在途流时不应标记为中断')
  assert.equal(sm.getSnapshot().status, 'none', '关闭后该账号应无活跃会话')

  // 上游一直删不掉 → ok=false + 带原因,且句柄保留(不得静默丢弃)
  await sm.ensureSession('deepseek/deepseek-v4-flash')
  state.deleteFailuresLeft = 99
  const bad = await fetch(`http://127.0.0.1:${wport}/api/accounts/w/session`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  })
  const bj = await bad.json()
  assert.equal(bj.ok, false, '删不掉时必须 ok=false')
  assert.ok(bj.error, '失败要带原因')
  assert.ok(sm.getSnapshot().instanceId, '失败后句柄必须保留')
  state.deleteFailuresLeft = 0
  await sm.release()

  // 未知账号 → 404(且不误伤其它账号)
  const nf = await fetch(`http://127.0.0.1:${wport}/api/accounts/nope/session`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(nf.status, 404, '未知账号应 404')

  // 未登录 → 401
  const anon = await fetch(`http://127.0.0.1:${wport}/api/accounts/w/session`, {
    method: 'POST',
  })
  assert.equal(anon.status, 401, '未登录应 401')
}

loginFlows.shutdown()
await wruntimes.shutdown()
wserver.close()
fs.rmSync(wDir, { recursive: true, force: true })
