import { LOCALES, LOCALE_LABELS, getLocale, setLocale, t } from '../../locale/index.ts'
import { api } from '../../lib/api.ts'
import { $, el, icon } from '../../lib/dom.ts'
import { state } from '../../lib/state.ts'
import { toast, withButtonLoading } from '../../lib/ui.ts'
import { renderLogs } from '../logs/index.ts'
import { renderMe } from '../me/index.ts'
import { renderOverview } from '../overview/index.ts'
import { renderPlayground } from '../playground/index.ts'
import { renderSystem } from '../system/index.ts'
import { renderUsers } from '../users/index.ts'
import { need } from '../../lib/hooks.ts'


/* ---------------- render ---------------- */
/**
 - 路由渲染(标准 SPA):
 - - 登录态变化(登录/登出/401)→ 重建整个 #app 骨架
 - - 其他情况(hash 切换 / 局部刷新回退)→ 只更新内容区 view,
 - header/nav 骨架完全不动,不重置任何 UI 状态
 */
export async function render(opts = {}) {
  const app = $('#app')
  if (!state.me) {
    app.innerHTML = ''
    app.append(renderLogin())
    return
  }
  const route = (location.hash || '#overview').slice(1) || 'overview'
  // 骨架已存在且登录态没变 → 只更新内容区(标准 SPA 行为)
  //
  //  force=true(切换语言时用):连 header / nav 一起重建.
  // 否则顶栏与导航会保留切换前的语言(它们不在这次重渲染范围内),
  // 表现就是"内容变了,顶栏没变",用户只能手动刷新页面.
  let view = app.querySelector('.view-enter, .view')
  if (opts.force || !app.querySelector('header') || !view) {
    app.innerHTML = ''
    app.append(renderHeader())
    app.append(renderNav())
    view = document.createElement('div')
    view.className = 'view'
    app.append(view)
  }
  updateNavActive(route)
  view.classList.remove('view-enter')
  void view.offsetWidth // reflow 以重放动画
  view.classList.add('view-enter')
  if (route === 'users' && state.me.role === 'admin') await renderUsers(view)
  else if (route === 'playground') await renderPlayground(view)
  else if (route === 'system' && state.me.role === 'admin') await renderSystem(view)
  else if (route === 'logs' && state.me.role === 'admin') await renderLogs(view)
  else if (route === 'me') await renderMe(view)
  else await renderOverview(view)
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
 - 顶栏语言切换器:下拉菜单(select),显式限宽以免撑开顶栏.
 *
 - 为什么必须限宽:原生 select 未显式设 width 时会按最长 option 撑开
 - ("简体中文" 远比 "EN" 宽),实测能把顶栏顶出一条 780px 的宽条 ----
 - 与相邻 56px 的按钮完全不协调(用户反馈过"选项栏变得非常宽").
 - 这里用 .locale-select { width: 72px } 钉死.
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
    el('option', { value: loc, selected: loc === cur }, LOCALE_LABELS[loc] || loc),
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
  const items = [['overview', t('nav.overview'), 'gauge'], ['playground', t('nav.playground'), 'chat']]
  if (state.me.role === 'admin') {
    items.push(['users', t('nav.usersManagement'), 'users'])
    // 数据文件自检是排障工具,不是日常操作----从总览页搬出来,admin 专属独立页.
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
  state.me = null
  location.hash = ''
  render()
}
