/**
 * e2e: 前端页面加载速度与懒加载守护.
 *
 * ## 为什么有这个套件
 *
 * 用户反馈[设置页打开要加载半天], 实测 1.81s ---- 根因是页面加载时调了
 * /api/models/upstream, 它会 force 抓上游目录 + 刷会话(白等 1.65s), 且违反
 * [零自动探测]约定. 另有 Monaco(3.7MB)在进设置页时被同步加载.
 * 这两类退化都是[量级]级别(秒级), 普通断言拦不住, 所以单列一个套件钉死.
 *
 * ## 判据
 *
 *   - 首屏 / 设置页 / 设置页的[系统提示词]分区各有加载时间上限;
 *   - 进设置页不得加载 Monaco(懒加载守护);
 *   - 页面加载不得 force 抓上游(零自动探测守护).
 *
 * ## 环境降级
 *
 * 优先用真浏览器. 本仓[禁止新增运行时依赖], 所以浏览器测量交给环境里已存在的
 * python playwright; 没有就降级成纯 HTTP 计时(只保留状态码/字节/缓存接口耗时).
 * 降级只减少覆盖度, 不让套件因环境而红 ---- 总因环境红的套件等于没有.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// test/suites/entries/e2e/ -> 仓库根: 往上 4 级.
const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..')
const PORT = Number(process.env.E2E_PORT || 28399)
const BASE = `http://127.0.0.1:${PORT}`

/** 阈值(毫秒). 留宽裕: 目的是拦[退化到秒级], 不是拦几十毫秒抖动. */
const LIMITS = { firstLoadMs: 3000, settingsMs: 3000, promptsMs: 3000 }

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

/**
 * 找 Chromium 可执行文件.
 *
 * @returns {string|null} 路径;没有为 null
 */
function findChrome() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright')
  try {
    for (const d of fs.readdirSync(base).filter((x) => x.startsWith('chromium-'))) {
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const p = path.join(base, d, sub, 'chrome')
        if (fs.existsSync(p)) return p
      }
    }
  } catch {
    // 没有 playwright 缓存
  }
  return null
}

/**
 * 探测 python playwright 是否可用.
 *
 * @returns {boolean} 可用为真
 */
function hasPythonPlaywright() {
  try {
    execFileSync('python3', ['-c', 'import playwright'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * 轮询等端口可连接.
 *
 * @param {number} port 端口
 * @param {number} timeoutMs 最长等待
 * @returns {Promise<boolean>} 连上了为真
 */
async function waitPort(port: number, timeoutMs: number) {
  const net = await import('node:net')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const okPort = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true) })
      s.on('error', () => resolve(false))
      s.setTimeout(1000, () => { s.destroy(); resolve(false) })
    })
    if (okPort) return true
    await delay(400)
  }
  return false
}

/**
 * 起一个被测服务(独立端口 + 独立 data 目录, 绝不碰开发用的实例).
 *
 * @returns {Promise<{stop: () => void}>} 停止句柄
 */
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fb-'))
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  // 服务只认 --config(没有端口环境变量), 所以写一份临时 config.yaml.
  const cfgPath = path.join(dir, 'config.yaml')
  fs.writeFileSync(cfgPath, [
    'server:', '  host: 127.0.0.1', `  port: ${PORT}`, `  dataDir: ${dataDir}`, '',
  ].join('\n'))
  const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'serve.ts'), '--config', cfgPath], {
    cwd: ROOT,
    env: { ...process.env, ADMIN_PASSWORD: 'e2e-admin-pw' },
    stdio: 'ignore',
  })
  if (!await waitPort(PORT, 30_000)) {
    proc.kill('SIGKILL')
    throw new Error('服务在 30s 内没有起来')
  }
  return { stop: () => proc.kill('SIGKILL') }
}

/**
 * 生成浏览器测量脚本(python playwright).
 *
 * @param {string} chrome Chromium 路径
 * @returns {string} 脚本内容
 */
function browserScript(chrome: string) {
  return `import json, time, sys
from playwright.sync_api import sync_playwright
BASE = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=${JSON.stringify(chrome)}, args=['--no-sandbox'])
    pg = b.new_page()
    seen = []
    pg.on('request', lambda r: seen.append(r.url))
    t0 = time.time()
    pg.goto(BASE, wait_until='networkidle', timeout=30000)
    first_ms = (time.time() - t0) * 1000
    pg.fill('#login-user', 'admin')
    pg.fill('#login-pass', 'e2e-admin-pw')
    pg.click('button')
    pg.wait_for_timeout(2000)
    seen.clear()
    t0 = time.time()
    pg.evaluate("location.hash='settings'")
    pg.wait_for_selector('.settings-section', timeout=30000)
    settings_ms = (time.time() - t0) * 1000
    monaco = len([u for u in seen if 'vendor/monaco' in u])
    forced = len([u for u in seen if '/api/models/upstream' in u and 'cached=1' not in u])
    t0 = time.time()
    pg.evaluate("location.hash='settings/prompt'")
    pg.wait_for_selector('.monaco-editor', timeout=30000)
    prompts_ms = (time.time() - t0) * 1000
    rows = len(pg.query_selector_all('.monaco-editor .view-line'))
    b.close()
    print('__RESULT__' + json.dumps({
        'firstMs': first_ms, 'settingsMs': settings_ms, 'promptsMs': prompts_ms,
        'monacoHits': monaco, 'forcedUpstream': forced, 'toolRows': rows,
    }))
`
}

const chrome = findChrome()
const useBrowser = Boolean(chrome) && hasPythonPlaywright()
console.log(`[e2e] 模式: ${useBrowser ? '真浏览器' : 'HTTP 计时(降级)'}`)

const server = await startServer()
try {
  // 登录(两种模式都要)
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'e2e-admin-pw' }),
  })
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ')
  ok(cookie.length > 0, '登录必须拿到会话 cookie')

  if (useBrowser) {
    // 浏览器只负责[量], 判定留在 node 侧.
    const script = path.join(os.tmpdir(), `e2e-browser-${Date.now()}.py`)
    fs.writeFileSync(script, browserScript(chrome as string))
    const out = execFileSync('python3', [script, BASE], { encoding: 'utf8', timeout: 120_000 })
    const m = out.match(/__RESULT__(.*)/)
    assert.ok(m, `浏览器脚本没有返回结果: ${out.slice(0, 300)}`)
    const res = JSON.parse(m[1])
    ok(res.firstMs < LIMITS.firstLoadMs, `首屏应 < ${LIMITS.firstLoadMs}ms, got ${Math.round(res.firstMs)}ms`)
    ok(res.settingsMs < LIMITS.settingsMs, `设置页应 < ${LIMITS.settingsMs}ms, got ${Math.round(res.settingsMs)}ms`)
    ok(res.promptsMs < LIMITS.promptsMs, `提示词分区应 < ${LIMITS.promptsMs}ms, got ${Math.round(res.promptsMs)}ms`)
    ok(res.monacoHits === 0, `进设置页不得加载 Monaco(懒加载守护), got ${res.monacoHits} 个`)
    ok(res.forcedUpstream === 0, `页面加载不得 force 抓上游(零自动探测守护), got ${res.forcedUpstream} 个`)
    ok(res.toolRows > 5, `提示词编辑器应渲染出正文, got ${res.toolRows} 行`)
    console.log(
      `[e2e] 首屏 ${Math.round(res.firstMs)}ms · 设置页 ${Math.round(res.settingsMs)}ms`
      + ` · 提示词分区 ${Math.round(res.promptsMs)}ms`,
    )
  } else {
    // 降级: 没有浏览器就没有渲染时间, 只看传输与缓存接口.
    const t0 = performance.now()
    const index = await fetch(BASE)
    const indexMs = performance.now() - t0
    ok(index.status === 200, `首屏应 200, got ${index.status}`)
    ok(indexMs < 8000, `首屏传输应 < 8000ms, got ${Math.round(indexMs)}ms`)

    const t1 = performance.now()
    const cached = await fetch(`${BASE}/api/models/upstream?cached=1`, { headers: { cookie } })
    const cachedMs = performance.now() - t1
    ok(cached.status === 200, `cached 模式的 upstream 接口应 200, got ${cached.status}`)
    ok(cachedMs < 2000, `cached 模式应 < 2000ms(不打上游), got ${Math.round(cachedMs)}ms`)

    const pr = await fetch(`${BASE}/api/prompts`, { headers: { cookie } })
    const body: any = await pr.json()
    ok(pr.status === 200, `提示词接口应 200, got ${pr.status}`)
    ok(
      Array.isArray(body.officialTools) && body.officialTools.length === 37,
      `提示词接口应给出 37 个官方工具, got ${body.officialTools?.length}`,
    )
  }
} finally {
  server.stop()
}

console.log(`前端加载速度与懒加载守护验证通过(断言 ${n} 条)`)
