import { LOCALES, LOCALE_LABELS, getLocale, setLocale, t } from '../../locale/index.ts'
import { api } from '../../lib/api.ts'
import { $, el, icon } from '../../lib/dom.ts'
import { state } from '../../lib/state.ts'
import { toast, withButtonLoading } from '../../lib/ui.ts'
import { renderLogs } from '../logs/index.ts'
import { renderMe } from '../me/index.ts'
import { renderOverview } from '../overview/index.ts'
import { renderSettings } from '../settings/index.ts'
import { renderPlayground } from '../playground/index.ts'
import { renderSystem } from '../system/index.ts'
import { renderUsers } from '../users/index.ts'
import { need } from '../../lib/boot/hooks.ts'
import { promptDirty } from '../proxy/inject/system-prompt.ts'

/* ---------------- render ---------------- */
/**
 - 路由渲染(标准 SPA):
 - - 登录态变化(登录/登出/401)→ 重建整个 #app 骨架
 - - 其他情况(hash 切换 / 局部刷新回退)→ 只更新内容区 view,
 - header/nav 骨架完全不动,不重置任何 UI 状态
 */
export async function render(opts: { force?: boolean } | boolean = {}) {
  // 允许 render(true) 这种简写; 事件监听器会把 Event 传进来, 那种情形按[非 force]处理.
  const force = opts === true || (typeof opts === 'object' && opts?.force === true)
  const app = $('#app')
  if (!state.me) {
    app.innerHTML = ''
    app.append(renderLogin())
    return
  }
  const raw = (location.hash || '#overview').slice(1) || 'overview'
  // 记录上一次的完整 hash: 同一主路由下切子页不重建内容区.
  if (currentRaw === raw) {
    // 同一路由重复渲染(hashchange 可能是子页变化): 只确保目标页可见, 不重建.
    updateNavActive(raw.split('/')[0])
    const cur = app.querySelector('.view')
    if (cur) await showRoute(cur, raw.split('/')[0])
    return
  }
  currentRaw = raw
  // 路由可能带子页(#settings/tools 这类). 主路由取第一段, 子页由各页面自己解析.
  const route = raw.split('/')[0]
  // 骨架已存在且登录态没变 → 只更新内容区(标准 SPA 行为)
  //  force=true(切换语言时用):连 header / nav 一起重建.
  // 否则顶栏与导航会保留切换前的语言(它们不在这次重渲染范围内),
  // 表现就是"内容变了,顶栏没变",用户只能手动刷新页面.
  let view = app.querySelector('.view-enter, .view')
  if (force || !app.querySelector('header') || !view) {
    app.innerHTML = ''
    // 骨架被清空 = 上一批页面节点已随 innerHTML 一起消失, 缓存必须同步作废,
    // 否则下一轮会把一批游离节点当成可用缓存挂回去(界面一片空白).
    invalidateViewCache()
    app.append(renderHeader())
    app.append(renderNav())
    view = document.createElement('div')
    view.className = 'view'
    app.append(view)
  }
  updateNavActive(route)
  // 系统提示词是唯一需要[丢了就白改]的内容(编辑器里可能是很长的正文):
  // 切页前有未保存改动就拦一下, 其余页面的输入框都随 DOM 缓存保留.
  if (!force && hasUnsavedPrompt() && !confirm(t('system.officialSystemLeaveWarn'))) {
    location.hash = currentRaw ? '#' + currentRaw : '#overview'
    return
  }
  await showRoute(view, route)
}

/** 提示词编辑器是否有未保存的改动(页面没进过时恒为假). */
function hasUnsavedPrompt() {
  return promptDirty() === true
}

/**
 * 显示某个路由.
 *
 * 每页一个有自己容器, 全部挂在内容区里; 切页只切 display, 不拆 DOM ----
 * 这样输入框里改了一半的值, 滚动位置, 展开状态, Monaco 编辑器都原样保留,
 * 也省掉每次切页都重拉一轮接口的等待. 标准 SPA 行为.
 *
 * 缓存失效只有两条路(刻意): invalidateViewCache()(账号增删/重连/登录态变化)
 * 与页面自己调 need('render')(). 取舍见
 * .agents/notes/implemented/bug-fix/2026-10-08-console-page-cache-and-manual-prompt-save.md.
 *
 * 可见性判据(hidden)必须按[不是当前路由就隐藏]来写, 写反会让当前页消失而历史页
 * 堆叠; 取舍与判据见
 * .agents/notes/implemented/bug-fix/2026-10-08-route-panel-hidden-inverted.md.
 *
 * @param {any} view 内容容器
 * @param {string} route 主路由
 * @returns {Promise<void>} 无返回值
 */
async function showRoute(view: any, route: string) {
  let panel = viewCache.get(route)
  if (!panel) {
    panel = document.createElement('div')
    panel.className = 'route-panel'
    panel.hidden = false
    view.append(panel)
    viewCache.set(route, panel)
  }
  // 切页只切可见性: 每页的 DOM 原样留在树里.
  // 判据是[不是当前路由就隐藏], 即 hidden = key !== route ----
  // 写成 key === route 会把当前页藏起来, 只留下所有旧页堆叠显示.
  for (const [key, node] of viewCache) {
    node.hidden = key !== route
  }
  if (panel.rendered === true) return
  panel.rendered = true
  panel.classList.remove('view-enter')
  void panel.offsetWidth
  panel.classList.add('view-enter')
  await renderRouteInto(panel, route)
}

/**
 * 按路由渲染到指定容器.
 *
 * @param {any} target 渲染目标容器
 * @param {string} route 主路由
 * @returns {Promise<void>} 无返回值
 */
async function renderRouteInto(target: any, route: string) {
  if (route === 'users' && state.me.role === 'admin') await renderUsers(target)
  else if (route === 'settings') await renderSettings(target)
  else if (route === 'playground') await renderPlayground(target)
  else if (route === 'system' && state.me.role === 'admin') await renderSystem(target)
  else if (route === 'logs' && state.me.role === 'admin') await renderLogs(target)
  else if (route === 'me') await renderMe(target)
  else await renderOverview(target)
}

/** 上一次渲染用的完整 hash(含子页), 用于判断是否真的需要重建内容区. */
let currentRaw = ''

/**
 * 已渲染页面的 DOM 缓存(路由 -> 内容容器).
 *
 * 为什么需要: 每次切页都 view.innerHTML = '' 再重新拉接口重建整个表单,
 * 用户的后果是三件具体的事 ----
 *   1. 表单里改了一半的值被清掉(输入框, 下拉, 勾选全部回默认值);
 *   2. 页面白等一轮接口(每页 2-4 个请求), 表现是切回来先空一下;
 *   3. 提示词编辑器(Monaco)每次重新挂载, 又慢又会丢光标位置.
 * 标准 SPA 的做法是把页面留在 DOM 里, 切走只是隐藏, 切回来直接显示.
 *
 * 失效只有两个来源(刻意的): 显式 refresh(用户按了刷新按钮)与账号结构变化
 * (增删账号 / 重连). 其余一律复用缓存 ---- 各页内部的[局部刷新]本来就负责
 * 把自己的数据更新到最新, 不需要靠整页重建来兜底.
 */
const viewCache = new Map<string, any>()

/**
 * 清掉页面缓存(登录态变化 / 账号增删 / 重连后必须调, 否则会显示旧数据).
 *
 * 只有"页面上那批数据整体失效"时才需要它; 各页自己的局部刷新足够更新单个卡片.
 *
 * @returns {void} 无返回值
 */
export function invalidateViewCache() {
  for (const node of viewCache.values()) {
    try { node.remove?.() } catch { /* 已随骨架回收 */ }
  }
  viewCache.clear()
}

function renderLogin() {
  const wrap = el('div', { class: 'login-wrap' }, [
    el('div', { class: 'brand' }, [icon('bolt', 22), 'Freebuff Proxy', versionBadge()]),
    el('div', { class: 'card' }, [
      el('label', {}, t('login.username')),
      el('input', { id: 'login-user', autocomplete: 'username', placeholder: 'admin' }),
      el('label', {}, t('login.password')),
      el('input', { id: 'login-pass', type: 'password', autocomplete: 'current-password' }),
      el('div', { style: 'margin-top:18px' }),
      el('button', { class: 'primary', style: 'width:100%;justify-content:center', onclick: doLogin }, [icon('lock', 15), t('login.submit')]),
    ]),
    el('div', { class: 'hint' }, t('login.firstDeployHint')),
  ])
  return wrap
}

async function doLogin() {
  const btn = $('.login-wrap button.primary')
  const restore = withButtonLoading(btn, t('login.submitting'))
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#login-user').value.trim(),
        password: $('#login-pass').value,
      }),
    })
    state.me = res.user
    toast(t('login.success'))
    render()
  } catch (err) {
    restore()
    toast(err.message, true)
  }
}

function renderHeader() {
  const buttons = []
  if (state.me.role === 'admin') {
    buttons.push(el('button', {
      onclick: reconnectAll,
      title: t('nav.reconnectTip'),
    }, [icon('refresh', 14), t('nav.reconnect')]))
    buttons.push(el('button', {
      class: 'danger',
      onclick: restartService,
      title: t('nav.restartTip'),
    }, [icon('cpu', 14), t('nav.restart')]))
  }
  buttons.push(el('button', { onclick: logout }, [icon('logout', 14), t('nav.logout')]))
  // 语言切换:改语种后整页重渲染(文案散布在各处,逐个区块刷新容易漏).
  // 只重画 DOM,不重新拉数据 ---- 不打断在途请求,不释放已购会话.
  buttons.push(buildLocaleSwitcher())
  return el('header', {}, [
    el('h1', {}, [icon('bolt', 18), 'Freebuff Proxy', versionBadge()]),
    el('div', { class: 'spacer' }),
    el('span', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:6px' }, [
      icon('user', 14),
      state.me.username,
      state.me.role === 'admin' ? el('span', { class: 'badge admin' }, 'admin') : '',
    ]),
    ...buttons,
  ])
}

/** 版本号徽章 + GitHub 仓库链接(版本号由发版流水线硬编码进 version.json) */
/**
 *
 *
 - 切换后 render({ force: true }) 连 header/nav 一起重建:只更新内容区的话
 - 顶栏与导航会留着切换前的语言(表现为"内容变了,顶栏没变",只能手动刷新).
 - 重渲染只重画 DOM,不重新拉数据 ---- 不打断在途请求,不释放已买断的会话.
 - @returns {HTMLElement}
 */
function buildLocaleSwitcher() {
  const cur = getLocale()
  return el('select', {
    class: 'locale-select',
    title: t('nav.language'),
    'aria-label': t('nav.language'),
    onchange: (e: any) => {
      setLocale(e.target.value)
      // 同步 <html lang>:屏幕阅读器与浏览器拼写检查据此选语言
      const html = document.documentElement
      if (html) html.lang = getLocale()
      render({ force: true })
    },
  }, LOCALES.map((loc) =>
    el('option', { value: loc, selected: loc === cur }, (LOCALE_LABELS as any)[loc] || loc),
  ))
}

function versionBadge() {
  const v = state.version || { version: 'dev' }
  const repoUrl = v.repo || 'https://github.com/HengXin666/freebuff-proxy'
  return el('a', {
    href: repoUrl,
    target: '_blank',
    rel: 'noopener',
    title: t('nav.repoTip', { version: v.version, commit: v.commit ? ' · commit ' + v.commit.slice(0, 7) : '' }),
    style: 'display:inline-flex;align-items:center;gap:4px;text-decoration:none;margin-left:4px',
  }, el('span', { class: 'badge', style: 'cursor:pointer' }, [
    icon('github', 12),
    'v' + v.version,
  ]))
}

async function reconnectAll() {
  if (!confirm(t('system.reconnectConfirm'))) return
  const restore = withButtonLoading(document.activeElement)
  try {
    const r = await api('/api/system/reconnect', { method: 'POST' })
    const failed = (r.accounts || []).filter((x: any) => !x.ok)
    toast(failed.length ? t('system.reconnectPartial', { n: failed.length }) : t('system.reconnectDone'))
    need('refreshOverviewAfterAccountChange')( )
  } catch (err) {
    restore()
    toast(err.message, true)
  }
}

async function restartService() {
  if (!confirm(t('system.restartConfirm'))) return
  try {
    await api('/api/system/restart', { method: 'POST' })
  } catch (err) {
    toast(err.message, true)
    return
  }
  toast(t('system.restarting'))
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const res = await fetch('/healthz', { cache: 'no-store' })
      if (res.ok) {
        toast(t('system.restartDone'))
        render()
        return
      }
    } catch { /* 服务尚未就绪，继续等待 */ }
  }
  toast(t('system.restartTimeout'), true)
  render()
}

function renderNav() {
  // 设置排在总览之后: 全局配置已从总览页剥离到独立页(用户要求分区排版).
  const items = [
    ['overview', t('nav.overview'), 'gauge'],
    ['settings', t('nav.settings'), 'cpu'],
    ['playground', t('nav.playground'), 'chat'],
  ]
  if (state.me.role === 'admin') {
    items.push(['users', t('nav.usersManagement'), 'users'])
    // 数据文件自检是排障工具,不是日常操作----从总览页搬出来,admin 专属独立页.
    // 见 .agents/notes/implemented/feature/2026-09-13-console-system-tab.md
    items.push(['system', t('nav.system'), 'cpu'])
    // 日志页:上游故障判据(如 countryBlockReason)只写进 stdout,用户以往
    // 只能看到一串 503 却不知为何.这里让完整字段在页面上可读,可筛选,可展开.
    items.push(['logs', t('nav.logs'), 'terminal'])
  }
  items.push(['me', t('nav.me'), 'user'])
  const route = (location.hash || '#overview').slice(1) || 'overview'
  return el('nav', {}, items.map(([key, label, ic]) =>
    el('button', {
      class: key === route ? 'active' : '',
      'data-route': key,
      onclick: () => { location.hash = key },
    }, [icon(ic, 14), label]),
  ))
}

/** 路由切换时只更新 nav 的高亮,不重建整个 nav(SPA 骨架保持) */
function updateNavActive(route: any) {
  const nav = document.querySelector('#app nav')
  if (!nav) return
  for (const btn of nav.querySelectorAll('button')) {
    const key = btn.dataset.route
    if (!key) continue
    btn.classList.toggle('active', key === route)
  }
}

function logout() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {})
  invalidateViewCache()
  state.me = null
  location.hash = ''
  render()
}
