// CDP 前端 UI 验证：登录 → 逐路由检查 select 样式 / 模型管理 / 负载均衡 UI。
// 用法: node test/cdp-ui-check.mjs <cdpPort> <baseUrl> [password]
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cdpPort = process.argv[2] || '9225'
const baseUrl = process.argv[3] || 'http://127.0.0.1:28287'
const password = process.argv[4] || 'testpass123'

const pages = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json())
let page = pages.find((p) => p.url.startsWith(baseUrl))
if (!page) {
  // 用 /json/new 开新标签页
  const resp = await fetch(
    `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(baseUrl)}`,
    { method: 'PUT' },
  )
  page = await resp.json()
}
if (!page?.webSocketDebuggerUrl) throw new Error('no debugger url')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
const events = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  } else if (m.method) {
    events.push(m)
  }
}
await new Promise((r) => (ws.onopen = r))
function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.result?.exceptionDetails) {
    return { error: r.result.exceptionDetails.exception?.description || 'eval error' }
  }
  return r.result?.result?.value
}

// 登录（通过页面 fetch 或直接 cookie 注入）
const login = await evalJs(`(async () => {
  const r = await fetch('${baseUrl}/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '${password}' }),
  })
  return { ok: r.ok, status: r.status }
})()`)
console.log('login:', JSON.stringify(login))

// 登录后刷新页面（SPA 重新拉 /api/me 进入已登录态）
await cdp('Page.navigate', { url: `${baseUrl}/#overview` })
await new Promise((r) => setTimeout(r, 1500))

const results = {}
// 总览路由
await cdp('Page.navigate', { url: `${baseUrl}/#overview` })
await new Promise((r) => setTimeout(r, 1200))
results.overview = await evalJs(`(() => {
  const selects = [...document.querySelectorAll('select')]
  const sels = selects.map((s) => {
    const cs = getComputedStyle(s)
    return {
      id: s.id || s.dataset.f || '?',
      appearance: cs.appearance,
      bgRepeat: cs.backgroundRepeat,
      bgSize: cs.backgroundSize,
      bgPos: cs.backgroundPosition,
      paddingRight: cs.paddingRight,
    }
  })
  return { selectCount: selects.length, sels, hasSettings: !!document.querySelector('#app')?.innerText?.includes('负载均衡设置') }
})()`)

// 模型管理在 overview 路由内
results.models = await evalJs(`(() => {
  const body = document.body.innerText
  const poolSelect = document.querySelector('#custom-models-editor select')
  const cs = poolSelect ? getComputedStyle(poolSelect) : null
  const optionStyles = poolSelect ? [...poolSelect.options].slice(0, 3).map((o) => ({
    text: o.text, value: o.value,
  })) : []
  return {
    hasSyncBtn: body.includes('同步上游模型'),
    hasSaveBtn: body.includes('保存自定义模型'),
    hasPoolZh: body.includes('高级') || body.includes('每日') || body.includes('限时'),
    poolSelectBgRepeat: cs?.backgroundRepeat,
    poolSelectBgSize: cs?.backgroundSize,
    optionStyles,
  }
})()`)

// 用户管理路由（角色 select）
await cdp('Page.navigate', { url: `${baseUrl}/#users` })
await new Promise((r) => setTimeout(r, 1200))
results.users = await evalJs(`(() => {
  const body = document.body.innerText
  return { hasRoleSelect: !!document.querySelector('#nu-role'), bodySnippet: body.slice(0, 80) }
})()`)

// playground
await cdp('Page.navigate', { url: `${baseUrl}/#playground` })
await new Promise((r) => setTimeout(r, 1500))
results.playground = await evalJs(`(() => {
  const pg = document.querySelector('#pg-model')
  return { hasModelSelect: !!pg, modelOptions: pg ? pg.options.length : 0 }
})()`)

console.log('=== results ===')
console.log(JSON.stringify(results, null, 2))
ws.close()
