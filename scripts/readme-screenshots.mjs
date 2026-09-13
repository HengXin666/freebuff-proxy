
/**
 * README 截图生成器：通过 CDP 驱动无头 Chromium 抓取控制台各页面。
 * 用法: node scripts/readme-screenshots.mjs <cdpPort> <baseUrl> <password> <outDir>
 *
 * 关键点：
 *  1) 控制台是 hash 路由 SPA，切换 #route **不会重新加载页面**——必须整页
 *     navigate + reload，再等视图真正画出内容（轮询 #app 文本长度）。
 *  2) 截图用于 README，必须**打码**：API Key / 邮箱只保留前缀。
 */
import fs from 'node:fs'
import path from 'node:path'

const cdpPort = process.argv[2] || '9333'
const baseUrl = process.argv[3] || 'http://127.0.0.1:28787'
const password = process.argv[4] || 'demo1234'
const outDir = process.argv[5] || '/tmp/fb-research/shots'
const WIDTH = Number(process.env.SHOT_W || 1400)
const HEIGHT = Number(process.env.SHOT_H || 880)

fs.mkdirSync(outDir, { recursive: true })

const pages = await fetch('http://127.0.0.1:' + cdpPort + '/json').then((r) => r.json())
const target = pages.find((p) => p.type === 'page')
if (!target) throw new Error('no page target on CDP port ' + cdpPort)
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
await new Promise((r) => (ws.onopen = r))
function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
async function evalJs(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error')
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await cdp('Page.enable')
await cdp('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false })

await cdp('Page.navigate', { url: baseUrl + '/' })
await wait(1500)
const login = await evalJs(`(async () => {
  const r = await fetch('${baseUrl}/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '${password}' }),
  })
  return { ok: r.ok, status: r.status }
})()`)
console.log('login:', JSON.stringify(login))
if (!login?.ok) throw new Error('login failed')

async function waitRendered(minLen = 400, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const len = await evalJs('(document.querySelector("#app")?.innerText || "").length')
    if (len >= minLen) return len
    await wait(200)
  }
  return 0
}

async function goto(route, minLen = 400) {
  await cdp('Page.navigate', { url: baseUrl + '/#' + route })
  await wait(900)
  await cdp('Page.reload', { ignoreCache: false })
  await wait(2200)
  const len = await waitRendered(minLen)
  console.log(route, 'rendered chars:', len)
  await wait(400)
}

/** README 打码：API Key / 邮箱只留可辨识前缀。 */
async function maskSecrets() {
  return evalJs(`(() => {
    let n = 0
    const walk = (root) => {
      for (const node of root.querySelectorAll('*')) {
        for (const child of node.childNodes) {
          if (child.nodeType !== 3) continue
          const t = child.nodeValue
          if (!t) continue
          let v = t
          v = v.replace(/sk-fb-[A-Za-z0-9]{6,}/g, (m) => m.slice(0, 11) + '…' + m.slice(-4))
          v = v.replace(/\\b([a-z0-9._%+-]{2})[a-z0-9._%+-]*@([a-z0-9.-]+\\.[a-z]{2,})/gi, '$1***@$2')
          if (v !== t) { child.nodeValue = v; n++ }
        }
      }
    }
    walk(document.body)
    // input/textarea 里的 Key 同样打码
    for (const el of document.querySelectorAll('input, textarea')) {
      if (el.value && /^sk-fb-/.test(el.value)) {
        el.value = el.value.slice(0, 11) + '…' + el.value.slice(-4)
        n++
      }
    }
    return n
  })()`)
}

async function capture(file) {
  await maskSecrets()
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const buf = Buffer.from(r.result.data, 'base64')
  fs.writeFileSync(path.join(outDir, file), buf)
  console.log('wrote', path.join(outDir, file), buf.length + 'B')
}

// ---- 01 总览 ----
await goto('overview', 1500)
await capture('01-overview.png')

// ---- 02 测试对话：填表并真实发一次流式请求 ----
await goto('playground', 300)
const sent = await evalJs(`(async () => {
  const ta = document.querySelector('textarea')
  const sel = document.querySelector('select')
  if (!ta) return 'no-textarea'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '你好，介绍一下你自己')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  if (sel && sel.options.length) {
    // 明确选主力模型，别落到下拉第一项（可能是已撤出免费模式的模型）
    const want = [...sel.options].find((o) => o.value === 'deepseek/deepseek-v4-flash')
    sel.value = want ? want.value : sel.options[0].value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const btns = [...document.querySelectorAll('button')]
  const send = btns.find((b) => (b.textContent || '').includes('发送'))
  if (!send) return 'no-send-button'
  send.click()
  return 'clicked'
})()`)
console.log('playground send:', sent)
await wait(4500)
await capture('02-playground.png')

// ---- 03 用户管理 ----
await goto('users', 300)
await capture('03-users.png')

// ---- 04 我的 ----
await goto('me', 300)
await capture('04-me.png')

ws.close()