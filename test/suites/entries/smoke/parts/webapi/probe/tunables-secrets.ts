/**
 * web api: 可调项(admin 专属; 凭据项永不回显)
 *
 * 三条独立判据, 每条都对应一个真实风险:
 *   1. GET /api/settings 只对 admin 开放 ---- 它带着全部可调项现值(含
 *      server.apiKeys / users.defaultAdminPassword 的取值与设置状态). 一个
 *      普通用户(或任何拿到他那把 Bearer Key 的下游)不该看到服务配置.
 *   2. 凭据项(secret)的[值]在任何响应体里都不出现: GET 的 tunables 里是
 *      null, POST 的回执里也是 null ---- 只在 secrets 里回布尔[有没有设置].
 *      这是 [明文凭据绝不离开服务端] 这条性质的唯一可证伪观测点.
 *   3. 非凭据项照常回显(否则上面两条可以靠[什么都不回]作弊).
 *
 * 由 test/suites/entries/smoke/smoke.ts 按导入顺序求值.
 */
import { cookie, settingsStore, wport } from './fixture.ts'
import assert from 'node:assert/strict'

/** 测试用凭据值: 形状取真, 但从不该出现在任何响应体里. */
const SECRET_KEY = 'sk-canary-0000-1111-2222'
const SECRET_PW = 'pw-canary-3333'

/** 响应文本里搜凭据 --------- 用[整体 JSON 文本]判, 不是挑字段判. */
function bodyHasText(text: any, needle: any) {
  return String(text).includes(needle)
}

// (1) 先把凭据写进去(admin) ---- 用 POST /api/settings, 与前端保存同一条路.
{
  const res = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      'server.apiKeys': [SECRET_KEY],
      'users.defaultAdminPassword': SECRET_PW,
      'session.admitTimeoutMs': 12_345,
    }),
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(
    !bodyHasText(text, SECRET_KEY),
    'POST /api/settings 的回执里不得出现刚保存的 API Key 明文',
  )
  assert.ok(
    !bodyHasText(text, SECRET_PW),
    'POST /api/settings 的回执里不得出现刚保存的管理员密码明文',
  )
  const j = JSON.parse(text)
  assert.equal(j.restartRequired, true, '可调项保存后必须提示需重启')
  // 非凭据项照常回显: 这条同时排除了"靠什么都不回"通过上面两条.
  assert.equal(j.tunables['session.admitTimeoutMs'], 12_345, '非凭据项必须照常回显')
  assert.equal(j.secrets['server.apiKeys'], true, 'secrets 必须报告[已设置]')
  assert.equal(j.secrets['users.defaultAdminPassword'], true)
}

// (2) GET /api/settings 的值里凭据恒为 null, 只回布尔; 且明文不出现在响应体里.
{
  const res = await fetch(`http://127.0.0.1:${wport}/api/settings`, { headers: { cookie } })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(!bodyHasText(text, SECRET_KEY), 'GET /api/settings 不得回显 API Key 明文')
  assert.ok(!bodyHasText(text, SECRET_PW), 'GET /api/settings 不得回显管理员密码明文')
  const j = JSON.parse(text)
  assert.equal(j.tunables['server.apiKeys'], null, '凭据项的值必须是 null(不回显)')
  assert.equal(j.tunables['users.defaultAdminPassword'], null)
  assert.equal(j.secrets['server.apiKeys'], true)
  assert.equal(j.secrets['users.defaultAdminPassword'], true)
  // 声明里必须标 secret, 前端据此渲染成密码框; 漏标 = 明文又回到页面上.
  const spec = (j.tunableSpecs || []).find((s: any) => s.path === 'server.apiKeys')
  assert.equal(spec?.secret, true, 'server.apiKeys 的声明必须标 secret')
  const pwSpec = (j.tunableSpecs || []).find((s: any) => s.path === 'users.defaultAdminPassword')
  assert.equal(pwSpec?.secret, true, 'users.defaultAdminPassword 的声明必须标 secret')
  const normal = (j.tunableSpecs || []).find((s: any) => s.path === 'session.pollIntervalSec')
  assert.notEqual(normal?.secret, true, '普通项不得被标成 secret（否则前端会隐藏本该显示的现值）')
}

// (3) 普通用户: 读得到设置页(只读态), 但永远读不到凭据明文; 写一律 403.
{
  const { userStore } = await import('./fixture.ts')
  userStore.create({ username: 'viewer', password: 'viewer123', role: 'user' })
  const lr = await fetch(`http://127.0.0.1:${wport}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: 'viewer123' }),
  })
  assert.equal(lr.status, 200)
  const viewerCookie = lr.headers.get('set-cookie').split(';')[0]
  const get = await fetch(`http://127.0.0.1:${wport}/api/settings`, { headers: { cookie: viewerCookie } })
  assert.equal(get.status, 200, 'GET /api/settings 对已认证用户开放(前端渲染只读态)')
  const text = await get.text()
  assert.ok(!bodyHasText(text, SECRET_KEY), '普通用户读到的设置里不得有 API Key 明文')
  assert.ok(!bodyHasText(text, SECRET_PW), '普通用户读到的设置里不得有管理员密码明文')
  assert.equal(
    JSON.parse(text).tunables['server.apiKeys'],
    null,
    '凭据项对任何身份都只回 null',
  )
  const post = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    method: 'POST',
    headers: { cookie: viewerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ 'session.admitTimeoutMs': 1 }),
  })
  assert.equal(post.status, 403, '普通用户写 /api/settings 必须 403')
}

// (4) 落盘的那一份仍是真值 ---- 屏蔽只发生在响应体, 不能顺手把配置写坏.
{
  const saved = settingsStore.savedTunables()
  assert.deepEqual(saved['server.apiKeys'], [SECRET_KEY], '盘上必须保存真值')
  assert.equal(saved['users.defaultAdminPassword'], SECRET_PW)
  // 清场: 别把 canary 留在 settings.json 里影响后面的块.
  const res = await fetch(`http://127.0.0.1:${wport}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ 'server.apiKeys': [], 'users.defaultAdminPassword': null }),
  })
  assert.equal(res.status, 200)
  const after = JSON.parse(await res.text())
  assert.equal(after.secrets['server.apiKeys'], false, '清空后 secrets 必须报未设置')
  assert.equal(after.secrets['users.defaultAdminPassword'], false)
}
