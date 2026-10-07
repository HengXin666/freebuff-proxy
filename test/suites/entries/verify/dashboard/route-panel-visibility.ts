/**
 * 控制台切页后[只应有当前页可见]的回归 ---- 钉死 2026-10-08 的实测缺陷.
 *
 * ## 缺陷原貌(用户在真机上看到的现象)
 *
 * 点导航栏切到新页后看不到该页内容, 而且访问过的每一页会纵向堆在一起:
 * 页面越滚越长, 正文却是别的页面的.
 *
 * 根因是 hidden 判据写反了. showRoute 里原本是
 *     node.hidden = key === route
 * 语义变成[是当前路由就藏起来], 于是当前页被隐藏, 历史页反而全部显示.
 * 首次进入某页时当前页是唯一面板, 这条规则恰好把唯一的面板藏起来 ----
 * 真浏览器实测: 首屏面板全 hidden, 内容区高度 0, 整页空白.
 *
 * ## 为什么原有防线全漏
 *
 * 加载速度套件只量[毫秒数], 页面全空也一样快; 其余结构断言都在各视图内部,
 * 而缺陷在路由装配层 ---- 没有一个套件看过[切页后到底哪个面板可见].
 *
 * 判据(可证伪): 沿导航逐个切页, 每次切完可见面板必须恒为 1; 已渲染过的页
 * 再切回必须复用面板(DOM 缓存语义: 不再拉一次接口); 被隐藏的面板必须仍在
 * DOM 里, 否则[表单改了一半切走再切回来]会丢值.
 * 把 node.hidden = key === route 写回去, 本文件立刻变红.
 */
import assert from 'node:assert/strict'
import { installDomStub, StubNode } from '../../../../helpers/dom-stub.ts'

const { document, body } = installDomStub()
// 真实浏览器里 location 是全局; Node 侧没有, 必须补一个可写载体 ----
// 路由层模块级就读 location.hash, 缺了它连装载都过不去.
const loc = { hash: '' }
;(globalThis as any).location = loc
// 进度条走的 rAF 在 Node 侧不存在: 给一个[立即执行]实现即可, 本套件不测动画.
;(globalThis as any).requestAnimationFrame = (fn: any) => { fn(0); return 0 }
;(globalThis as any).cancelAnimationFrame = () => {}

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

/** 每个接口被请求的次数(用于验证[切回已渲染页不再重拉]). */
const calls: Record<string, number> = {}

/** 各接口的最小可用回执: 只要让视图渲染完不抛异常即可, 内容不参与本套件判据. */
const RESPONSES: Record<string, any> = {
  '/api/me': { user: { username: 'admin', role: 'admin', apiKey: 'sk-fb-test' } },
  '/api/settings': {},
  '/api/overview': { accounts: [], accountCount: 0, models: 0, dataDir: '/data', upstream: { apiBase: 'x' } },
  '/api/accounts/login': { data: [] },
  '/api/proxy': {},
  '/api/models/custom': { custom: [], hidden: [] },
  '/api/models/upstream': { models: [], cached: true },
  '/api/system/data-status': { files: [], dataDir: '/data' },
  '/api/logs': { entries: [], total: 0 },
  '/api/users': { data: [] },
}

globalThis.fetch = (async (url: any) => {
  const path = String(url).split('?')[0]
  calls[path] = (calls[path] || 0) + 1
  const payload = RESPONSES[path]
  return {
    ok: payload !== undefined,
    status: payload === undefined ? 404 : 200,
    headers: { getSetCookie: () => [] },
    json: async () => payload ?? { error: 'not found' },
  }
}) as any

// 骨架里必须有 #progress 与 #toast: 总览页渲染时会去取进度条.
for (const id of ['progress', 'toast']) {
  const node = document.createElement('div')
  node.setAttribute('id', id)
  body.append(node)
}
const app = document.createElement('div')
app.setAttribute('id', 'app')
body.append(app)

// 必须在装桩之后再 import 路由: shell 模块级就引用 document / window.
const { render } = await import('../../../../../dashboard/views/shell/index.ts')
const { state } = await import('../../../../../dashboard/lib/state.ts')
state.me = { username: 'admin', role: 'admin', apiKey: 'sk-fb-test' }

/** 排空渲染里的 await 链(桩下不需要真定时器). */
async function drain() {
  for (let i = 0; i < 200; i += 1) await Promise.resolve()
}

/**
 * 切到某个路由并把渲染排空.
 *
 * @param {string} route 目标路由
 * @returns {Promise<void>} 渲染完成
 */
async function go(route: string) {
  loc.hash = '#' + route
  await render()
  await drain()
}

/**
 * 当前可见的路由面板.
 *
 * @returns {any[]} hidden 不为真的面板
 */
function visible() {
  return app.querySelectorAll('.route-panel').filter((p: any) => p.hidden !== true)
}

const ROUTES = ['overview', 'settings', 'system', 'users', 'me']

for (const [i, route] of ROUTES.entries()) {
  await go(route)
  if (i === 0) {
    // 首屏那一跳: 当前页是唯一面板, 它必须可见 ---- 原实现最直观的破绽.
    ok(
      (app.querySelectorAll('.route-panel')[0] as any).hidden !== true,
      '首个被渲染的路由面板必须可见, 不得被 hidden 判据藏起来',
    )
    ok(
      app.querySelectorAll('.route-panel').length === 1,
      '首屏只应有一个路由面板, got ' + app.querySelectorAll('.route-panel').length,
    )
  }
  const all = app.querySelectorAll('.route-panel')
  const shown = visible()
  ok(shown.length === 1, `切到 ${route} 后可见面板必须正好 1 个, got ${shown.length}`)
  ok(
    (all as any)[all.length - 1] === shown[0],
    `切到 ${route} 后可见的必须是刚渲染的那个面板`,
  )
}

// 已渲染过的页再切回必须复用面板: 不得重新渲染那一页.
// 用总览页做这条判据: 它的渲染真的会拉接口 ---- renderOverview 里就是 await api('/api/overview'),
// 是这条缓存语义在当前装配下唯一的可证伪观测点 ---- 设置页的数据由 need() 钩子提供,
// 钩子在本桩下未装配, 拿它做判据会写成恒真断言(实测: 破坏复用短路后计数仍不变).
const overviewBefore = calls['/api/overview'] || 0
await go('overview')
ok(
  (calls['/api/overview'] || 0) === overviewBefore,
  `切回总览页必须复用已渲染面板, 不得重拉 /api/overview(got ${calls['/api/overview'] || 0})`,
)

// 切走的面板必须留在 DOM 里(只隐藏), 否则表单里改了一半的值会随 DOM 一起没.
const hiddenPanels = app.querySelectorAll('.route-panel').filter((p: any) => p.hidden === true)
ok(hiddenPanels.length === ROUTES.length - 1,
  `切走的面板必须留在 DOM 里, 期望 ${ROUTES.length - 1} 个隐藏面板, got ${hiddenPanels.length}`)
ok(
  app.querySelectorAll('.route-panel').length === ROUTES.length,
  `每个访问过的路由各占一个面板, got ${app.querySelectorAll('.route-panel').length}`,
)
ok(hiddenPanels.every((p: any) => p instanceof StubNode && p.parentNode !== null),
  '隐藏面板必须仍挂在内容区里, 不得被摘掉')

console.log(`控制台切页可见性验证通过(断言 ${n} 条)`)
