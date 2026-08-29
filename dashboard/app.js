/* Freebuff Proxy 控制台 — 零依赖原生 JS SPA
 * 现代 UI：SVG 图标、局部刷新（不整页重建）、骨架屏/进度条加载态、
 * 每账号「检测」按钮（单账号只读探测）、动画与响应式。
 * 功能与后端 API 保持不变。
 */
'use strict'

const state = { me: null, accounts: [], users: [], models: [], flows: [], proxies: [], version: null }

const $ = (sel, root = document) => root.querySelector(sel)
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'html') node.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v)
  }
  for (const c of [].concat(children)) {
    if (c == null) continue
    if (c.nodeType) {
      node.append(c)
    } else if (typeof c === 'string' && c.trimStart().startsWith('<')) {
      // 字符串以 < 开头视为 HTML 片段（图标 SVG 等内部受控内容）直接注入；
      // 其余字符串一律 createTextNode 安全转义（用户输入/API 返回不会以 < 开头）。
      node.insertAdjacentHTML('beforeend', c)
    } else {
      node.append(document.createTextNode(String(c)))
    }
  }
  return node
}

/* ---------------- SVG 图标库（不用文本 emoji） ---------------- */
const ICONS = {
  bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  gauge: '<path d="M12 15l3.5-3.5"/><path d="M20.3 18a10 10 0 1 0-16.6 0"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
}
function icon(name, size = 16) {
  const paths = ICONS[name] || ICONS.bolt
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = paths
  return svg
}

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  let body = null
  try { body = await res.json() } catch { /* noop */ }
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    state.me = null
    render()
    throw new Error(body?.error || '未登录')
  }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
  return body
}

/* ---------------- toast + progress ---------------- */
let toastTimer = null
function toast(msg, isErr = false) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.toggle('err', !!isErr)
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200)
}

let progressTimer = null
function startProgress() {
  const bar = $('#progress')
  bar.classList.remove('done')
  bar.style.width = '0'
  requestAnimationFrame(() => { bar.style.width = '70%' })
  clearTimeout(progressTimer)
  progressTimer = setTimeout(() => {
    bar.style.width = '100%'
    bar.classList.add('done')
  }, 2000)
}
function endProgress() {
  clearTimeout(progressTimer)
  const bar = $('#progress')
  bar.style.width = '100%'
  bar.classList.add('done')
}

/* 按钮加载态：把按钮内容换成 spinner，返回恢复函数 */
function withButtonLoading(btn, busyText = '') {
  if (!btn) return () => {}
  const original = btn.innerHTML
  const wasDisabled = btn.disabled
  btn.disabled = true
  btn.classList.add('btn-loading')
  btn.innerHTML = `<span class="spinner" style="border-color:currentColor;border-top-color:transparent"></span>${busyText ? `<span>${busyText}</span>` : ''}`
  return () => {
    btn.innerHTML = original
    btn.disabled = wasDisabled
    btn.classList.remove('btn-loading')
  }
}

/* ---------------- render ---------------- */
/**
 * 路由渲染（标准 SPA）：
 * - 登录态变化（登录/登出/401）→ 重建整个 #app 骨架
 * - 其他情况（hash 切换 / 局部刷新回退）→ 只更新内容区 view，
 *   header/nav 骨架完全不动，不重置任何 UI 状态
 */
async function render() {
  const app = $('#app')
  if (!state.me) {
    app.innerHTML = ''
    app.append(renderLogin())
    return
  }
  const route = (location.hash || '#overview').slice(1) || 'overview'
  // 骨架已存在且登录态没变 → 只更新内容区（标准 SPA 行为）
  let view = app.querySelector('.view-enter, .view')
  if (!app.querySelector('header') || !view) {
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
  else if (route === 'me') await renderMe(view)
  else await renderOverview(view)
}

function renderLogin() {
  const wrap = el('div', { class: 'login-wrap' }, [
    el('div', { class: 'brand' }, [icon('bolt', 22), 'Freebuff Proxy', versionBadge()]),
    el('div', { class: 'card' }, [
      el('label', {}, '用户名'),
      el('input', { id: 'login-user', autocomplete: 'username', placeholder: 'admin' }),
      el('label', {}, '密码'),
      el('input', { id: 'login-pass', type: 'password', autocomplete: 'current-password' }),
      el('div', { style: 'margin-top:18px' }),
      el('button', { class: 'primary', style: 'width:100%;justify-content:center', onclick: doLogin }, [icon('lock', 15), '登 录']),
    ]),
    el('div', { class: 'hint' }, '首次部署的管理员账号/密码会打印在 docker compose logs 里'),
  ])
  return wrap
}

async function doLogin() {
  const btn = $('.login-wrap button.primary')
  const restore = withButtonLoading(btn, '登录中')
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#login-user').value.trim(),
        password: $('#login-pass').value,
      }),
    })
    state.me = res.user
    toast('登录成功')
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
      title: '比重启更轻量：释放全部 session、清理死任务，下个请求自动重建（不重启进程）',
    }, [icon('refresh', 14), '全部断开重连']))
    buttons.push(el('button', {
      class: 'danger',
      onclick: restartService,
      title: '彻底解决连接卡死等问题：重启整个代理服务（约几秒）',
    }, [icon('cpu', 14), '重启服务']))
  }
  buttons.push(el('button', { onclick: logout }, [icon('logout', 14), '退出']))
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

/** 版本号徽章 + GitHub 仓库链接（版本号由发版流水线硬编码进 version.json） */
function versionBadge() {
  const v = state.version || { version: 'dev' }
  const repoUrl = v.repo || 'https://github.com/HengXin666/freebuff-proxy'
  return el('a', {
    href: repoUrl,
    target: '_blank',
    rel: 'noopener',
    title: `开源仓库（版本 v${v.version}${v.commit ? ' · commit ' + v.commit.slice(0, 7) : ''}）`,
    style: 'display:inline-flex;align-items:center;gap:4px;text-decoration:none;margin-left:4px',
  }, el('span', { class: 'badge', style: 'cursor:pointer' }, [
    icon('github', 12),
    'v' + v.version,
  ]))
}

async function reconnectAll() {
  if (!confirm('确定要全部断开重连吗？\n\n将释放所有账号的 session（正在传输的 SSE 可能被中断），下一个请求会自动重建新 session。')) return
  const restore = withButtonLoading(document.activeElement)
  try {
    const r = await api('/api/system/reconnect', { method: 'POST' })
    const failed = (r.accounts || []).filter((x) => !x.ok)
    toast(failed.length ? `已断开重连，${failed.length} 个账号失败` : '已全部断开重连，下个请求自动重建')
    refreshOverviewAfterAccountChange()
  } catch (err) {
    restore()
    toast(err.message, true)
  }
}

async function restartService() {
  if (!confirm('确定要重启服务吗？\n\n重启会中断当前所有连接约几秒，期间请勿发送新请求。')) return
  try {
    await api('/api/system/restart', { method: 'POST' })
  } catch (err) {
    toast(err.message, true)
    return
  }
  toast('正在重启服务…')
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const res = await fetch('/healthz', { cache: 'no-store' })
      if (res.ok) {
        toast('服务已重启完成')
        render()
        return
      }
    } catch { /* 服务尚未就绪，继续等待 */ }
  }
  toast('等待重启超时，请刷新页面确认服务状态', true)
  render()
}

function renderNav() {
  const items = [['overview', '总览', 'gauge'], ['playground', '测试对话', 'chat']]
  if (state.me.role === 'admin') items.push(['users', '用户管理', 'users'])
  items.push(['me', '我的', 'user'])
  const route = (location.hash || '#overview').slice(1) || 'overview'
  return el('nav', {}, items.map(([key, label, ic]) =>
    el('button', {
      class: key === route ? 'active' : '',
      'data-route': key,
      onclick: () => { location.hash = key },
    }, [icon(ic, 14), label]),
  ))
}

/** 路由切换时只更新 nav 的高亮，不重建整个 nav（SPA 骨架保持） */
function updateNavActive(route) {
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

/* ================================================================
   OVERVIEW — 局部刷新架构
   总览页拆成独立区块：统计卡片 / 账号表 / 代理设置 / 模型管理 /
   登录流程。每个区块独立渲染与刷新（局部更新，不整页重建）。
   ================================================================ */
async function renderOverview(view) {
  view.innerHTML = ''
  // 骨架屏（首帧）
  view.append(skeletonOverview())
  startProgress()
  try {
    const data = await api('/api/overview')
    state.accounts = data.accounts
    endProgress()
    view.innerHTML = ''
    view.append(renderOverviewHeader(data))
    view.append(renderStatCards(data))
    view.append(await renderAccountsCard(data))
    await renderProxySettings(view)
    await renderModelSettings(view)
    if (state.me.role === 'admin') await renderFlowsCard(view)
  } catch (err) {
    endProgress()
    view.innerHTML = ''
    view.append(el('div', { class: 'card' }, err.message))
  }
}

function skeletonOverview() {
  return el('div', {}, [
    el('div', { class: 'stat-grid', style: 'margin-bottom:12px' }, [1, 2, 3, 4].map(() =>
      el('div', { class: 'card', style: 'height:74px' }, el('div', { class: 'skeleton', style: 'height:16px;width:60%' })),
    )),
    el('div', { class: 'card', style: 'margin-top:12px' }, [1, 2, 3, 4, 5].map(() =>
      el('div', { class: 'skeleton', style: 'height:34px;margin:8px 0' }),
    )),
  ])
}

function renderOverviewHeader(data) {
  return el('div', { class: 'row spread', style: 'margin-bottom:16px' }, [
    el('div', {}, [
      el('h2', { style: 'margin:0 0 4px' }, `账号池（${data.accountCount}）`),
      el('span', { class: 'muted' }, `上游 ${data.upstream.apiBase} · 模型 ${data.models} · 数据目录 ${data.dataDir}`),
    ]),
    el('div', { class: 'row' }, [
      el('button', { onclick: probeAllAccounts }, [icon('refresh', 14), '探测刷新']),
      state.me.role === 'admin'
        ? el('div', { class: 'row' }, [
            el('button', { onclick: () => openImportModal() }, [icon('box', 14), '导入账号']),
            el('button', { class: 'primary', onclick: () => openAddAccount() }, [icon('plus', 14), '添加账号']),
          ])
        : null,
    ]),
  ])
}

/** 统计卡片 */
function renderStatCards(data) {
  const total = data.accounts.length
  const available = data.accounts.filter((a) => a.available).length
  const cooldown = data.accounts.filter((a) => a.cooldownUntil).length
  const inFlight = data.accounts.reduce((n, a) => n + (a.inFlight || 0), 0)
  const cards = [
    { label: '账号总数', value: total, cls: '' },
    { label: '可用账号', value: available, cls: 'green' },
    { label: '冷却中', value: cooldown, cls: cooldown ? 'yellow' : 'green' },
    { label: '在途请求', value: inFlight, cls: '' },
  ]
  return el('div', { class: 'stat-grid' }, cards.map((c, i) =>
    el('div', { class: 'stat', style: `animation-delay:${i * 60}ms` }, [
      el('div', { class: 'label' }, c.label),
      el('div', { class: `value ${c.cls}` }, c.value),
    ]),
  ))
}

/** 账号表卡片（含每账号「检测」按钮） */
async function renderAccountsCard(data) {
  const card = el('div', { class: 'card', style: 'margin-top:12px' })
  if (!data.accounts.length) {
    card.append(
      el('p', { style: 'margin:0 0 10px' }, '还没有 Freebuff 账号。'),
      state.me.role === 'admin'
        ? el('button', { class: 'primary', onclick: () => openAddAccount() }, [icon('plus', 14), '立即添加第一个账号'])
        : el('p', { class: 'muted' }, '请联系管理员添加账号。'),
    )
    return card
  }

  // 负载均衡概览
  const totalReq = data.accounts.reduce((n, a) => n + (a.requests || 0), 0)
  const head = el('div', { class: 'row spread' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, '账号池'),
      el('span', { class: 'muted' }, totalReq > 0 ? `负载均衡 · 共 ${totalReq} 次选号 · 热 session 优先复用` : '尚无请求记录'),
    ]),
    el('button', { class: 'muted', onclick: refreshAccountsCard }, [icon('refresh', 13), '局部刷新']),
  ])
  card.append(head)

  if (totalReq > 0) {
    const bar = el('div', { class: 'balance-bar' })
    for (const a of data.accounts) {
      if (!a.requests) continue
      const pct = Math.round((a.requests / totalReq) * 100)
      bar.append(el('div', {
        style: `flex:${pct};background:${colorFor(a.email)}`,
        title: `${a.email} ${pct}%（${a.requests}/${totalReq}）`,
      }))
    }
    card.append(bar)
  }

  card.append(buildAccountsTable(data.accounts))
  return card
}

function buildAccountsTable(accounts) {
  const tbody = el('tbody', {}, accounts.map((a, i) => buildAccountRow(a, i)))
  return el('div', { class: 'table-wrap', style: 'margin-top:12px' }, [
    el('table', {}, [
      el('thead', {}, el('tr', {}, ['账号', '状态', 'Session', '并发', '额度（今日）', '请求', '冷却', '操作'].map((t) => el('th', {}, t)))),
      tbody,
    ]),
  ])
}

function buildAccountRow(a, i) {
  const cd = a.cooldownUntil ? new Date(a.cooldownUntil).toLocaleString() : null
  const sess = a.session?.live
    ? `${a.session.model} · ${fmtMs(a.session.remainingMs)}`
    : (a.session?.status === 'none' ? '无活跃' : (a.session?.status || '—'))
  // 探测失败原因（country_blocked 强风控 / rate_limited / banned / 凭证无效…）
  const probeFail = a.lastProbe && a.lastProbe.ok === false ? a.lastProbe : null
  const probe = probeFail ? probeReason(probeFail.code, probeFail.message) : null
  const statusDot = a.available
    ? el('span', { class: 'status-dot ok' })
    : el('span', { class: 'status-dot err' })
  const statusText = a.available
    ? '可用'
    : (cd ? `冷却至 ${cd}` : '冷却中')
  const statusBadge = probe
    ? el('span', { class: 'badge err', style: 'display:inline-flex', title: probe.tip },
        [statusDot, probe.label])
    : el('span', { class: a.available ? 'badge ok' : 'badge err', style: 'display:inline-flex' },
        [statusDot, statusText])
  const ops = el('div', { class: 'row', style: 'gap:6px' }, [
    el('button', { class: 'icon muted', title: '检测该账号（只读拉取状态/模型列表，不占额度）', onclick: (e) => probeAccount(a, e.currentTarget) }, icon('activity', 14)),
    state.me.role === 'admin'
      ? el('button', { class: 'icon muted', title: '解除冷却', onclick: () => clearCooldown(a.key) }, icon('zap', 14))
      : null,
    el('button', { class: 'icon muted', title: '查看/复制凭证', onclick: () => openCredentialModal(a) }, icon('key', 14)),
    state.me.role === 'admin'
      ? el('button', { class: 'icon danger', title: '删除账号', onclick: () => removeAccount(a.key, a.email) }, icon('trash', 14))
      : null,
  ])
  return el('tr', { class: 'row-in', style: `animation-delay:${Math.min(i * 40, 400)}ms` }, [
    el('td', {}, [
      a.email,
      a.id && a.id !== a.email ? el('div', { class: 'muted', style: 'font-size:11px' }, `ID ${a.id}`) : '',
      a.lastUsed ? el('span', { class: 'badge ok', style: 'margin-left:6px' }, '最近使用') : '',
    ]),
    el('td', {}, statusBadge),
    el('td', { class: 'mono', style: 'font-size:12px' }, sess),
    el('td', { class: 'mono' }, `${a.inFlight || 0}/${a.concurrency || 1}`),
    el('td', {}, fmtQuota(a.quota)),
    el('td', { class: 'mono' }, `${a.requests || 0} 次`),
    el('td', {}, cd ? el('span', { class: 'badge warn' }, a.cooldownCode || 'cooldown') : el('span', { class: 'muted' }, '—')),
    el('td', {}, ops),
  ])
}

/**
 * 探测失败原因 → 可读文案（强风控国家封锁 / 限流 / 封禁 / 凭证无效等）。
 * label 用于徽章短标签，tip 是 tooltip 完整原因。
 */
function probeReason(code, message) {
  const c = String(code || '').toLowerCase()
  const msg = message || c || '未知原因'
  if (c.includes('country_blocked') || c.includes('countryblocked')) {
    return { label: '出口风控', tip: `国家/出口 IP 风控：${msg}` }
  }
  if (c.includes('banned')) {
    return { label: '已封禁', tip: `账号被封禁：${msg}` }
  }
  if (c.includes('ip_capped')) {
    return { label: 'IP 上限', tip: `IP 达上限：${msg}` }
  }
  if (/rate_limited|spend_limited|free_mode_rate_limited/.test(c)) {
    return { label: '限流', tip: `账号限流/额度：${msg}` }
  }
  if (c.includes('unauthorized') || c.includes('invalid') || c.includes('401')) {
    return { label: '凭证无效', tip: `凭据失效（需重新登录）：${msg}` }
  }
  return { label: '探测失败', tip: msg }
}

/** 账号表局部刷新（不重建整个页面） */
async function refreshAccountsCard() {
  const wrap = $('.table-wrap', $('#app'))
  if (!wrap) return render()
  wrap.classList.add('refreshing')
  try {
    const data = await api('/api/overview')
    state.accounts = data.accounts
    const table = buildAccountsTable(data.accounts)
    wrap.replaceWith(table)
    // 更新统计卡片
    const statGrid = $('.stat-grid', $('#app'))
    if (statGrid) statGrid.replaceWith(renderStatCards(data))
    toast('账号状态已刷新')
  } catch (err) {
    toast(err.message, true)
  }
}

/**
 * overview 局部刷新：只更新「账号池标题计数 + 统计卡 + 账号表」，不重建页面布局。
 * 用于删除/导入账号、全部重连等会改变账号池结构、但页面骨架不变的操作。
 */
async function refreshOverviewAfterAccountChange() {
  try {
    const data = await api('/api/overview')
    state.accounts = data.accounts
    const wrap = $('.table-wrap', $('#app'))
    if (wrap) wrap.replaceWith(buildAccountsTable(data.accounts))
    const statGrid = $('.stat-grid', $('#app'))
    if (statGrid) statGrid.replaceWith(renderStatCards(data))
    // 更新 header「账号池（N）」计数
    const h2 = $('#app h2')
    if (h2 && h2.textContent.startsWith('账号池')) {
      h2.textContent = `账号池（${data.accountCount}）`
    }
  } catch (err) {
    toast(err.message, true)
  }
}

/** 单账号检测：只读拉取该账号状态/额度，判断可用/封禁/凭证失效 */
async function probeAccount(a, btn) {
  const restore = withButtonLoading(btn)
  try {
    const r = await api(`/api/accounts/${encodeURIComponent(a.key)}/probe`, { method: 'POST' })
    const sess = r.session || {}
    const limits = sess.rateLimitsByModel || {}
    const modelCount = Object.keys(limits).length
    if (r.ok) {
      const models = Object.entries(limits)
        .map(([id, info]) => `${shortModel(id)} ${Math.ceil(Number(info?.recentCount) || 0)}/${info?.limit ?? '?'}`)
        .join(' · ')
      toast(`✅ ${a.email} 可用 · ${modelCount} 个模型${models ? '：' + models : ''}`)
      refreshAccountsCard()
    } else {
      const code = r.code || sess?.status || sess?.error || r.error || '未知'
      const reason = probeReason(code, r.error || r.message)
      toast(`⚠️ ${a.email} 检测异常：${reason.label} — ${String(reason.tip).slice(0, 140)}`, true)
    }
  } catch (err) {
    restore()
    toast(`检测失败: ${err.message}`, true)
  }
}

/** 全部账号探测（沿用原有逻辑 + 局部刷新） */
async function probeAllAccounts() {
  const btn = document.activeElement
  const restore = withButtonLoading(btn, '探测中')
  try {
    const r = await api('/api/accounts/probe', { method: 'POST' })
    state.accounts = r.accounts
    const failed = (r.results || []).filter((x) => !x.ok)
    toast(failed.length ? `探测完成，${failed.length} 个失败（点击行内检测图标看详情）` : '探测完成（只读，不占额度）', !!failed.length)
    const wrap = $('.table-wrap', $('#app'))
    if (wrap) {
      wrap.replaceWith(buildAccountsTable(r.accounts))
      const statGrid = $('.stat-grid', $('#app'))
      if (statGrid) statGrid.replaceWith(renderStatCards({ accounts: r.accounts }))
    } else render()
  } catch (err) {
    restore()
    toast(err.message, true)
  }
}

/** 等待中的登录流程卡片 */
async function renderFlowsCard(view) {
  try {
    state.flows = (await api('/api/accounts/login')).data
  } catch { return }
  const activeFlows = state.flows.filter((f) => f.status === 'pending')
  if (!activeFlows.length) return
  view.append(el('div', { class: 'card', style: 'margin-top:12px' }, [
    el('h3', { style: 'margin:0 0 8px' }, '等待中的登录'),
    ...activeFlows.map((f) => el('div', { class: 'row spread', style: 'padding:8px 0;border-bottom:1px solid var(--border)' }, [
      el('span', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:6px' }, [icon('globe', 14), `发起于 ${new Date(f.createdAt).toLocaleString()}`]),
      el('button', { onclick: () => openLoginFlow(f) }, [icon('globe', 14), '打开登录链接']),
    ])),
  ]))
}

/* ---------------- proxy settings ---------------- */
async function renderProxySettings(view) {
  let data = null
  let settings = null
  try {
    ;[data, settings] = await Promise.all([
      api('/api/proxy'),
      api('/api/settings'),
    ])
  } catch {
    data = { proxies: [], effective: [], accounts: [] }
    settings = { freeToolSignatureEnabled: true }
  }
  state.proxies = data.proxies || []

  const signatureEnabled = settings.freeToolSignatureEnabled !== false
  const toggleAttrs = {
    id: 'free-tool-signature',
    type: 'checkbox',
    class: 'switch-input',
    onchange: saveFreeToolSignatureSetting,
  }
  if (signatureEnabled) toggleAttrs.checked = ''
  if (state.me.role !== 'admin') toggleAttrs.disabled = ''
  view.append(el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, '免费额度策略'),
      el('span', { class: 'muted' }, '工具签名兼容'),
    ]),
    el('label', { class: 'switch', for: 'free-tool-signature' }, [
      el('input', toggleAttrs),
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      el('span', { class: 'switch-status' }, signatureEnabled ? '已开启' : '已关闭'),
    ]),
  ]))

  const routingEnabled = settings.minimalRoutingEnabled === true
  const routingToggleAttrs = {
    id: 'minimal-routing',
    type: 'checkbox',
    class: 'switch-input',
    onchange: saveMinimalRoutingSetting,
  }
  if (routingEnabled) routingToggleAttrs.checked = ''
  if (state.me.role !== 'admin') routingToggleAttrs.disabled = ''
  view.append(el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, '思维路由（路由模式）'),
      el('span', { class: 'muted' }, '代理侧注入 persona / 首轮核心工具面 / 近距离引导，保证客户端侧路由注入经反向代理链不被丢弃；一键开关，性能不佳可随时回退'),
    ]),
    el('label', { class: 'switch', for: 'minimal-routing' }, [
      el('input', routingToggleAttrs),
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      el('span', { class: 'switch-status' }, routingEnabled ? '已开启' : '已关闭'),
    ]),
  ]))

  const routingStyle = settings.minimalRoutingStyle ?? 'standard'
  const styleOptions = [
    ['standard', 'standard · 标准模式（flash 恒 weak + 深度引导静态并入，推荐）'],
    ['minimal', 'minimal · 极简模式（按任务分类 spec/react/weak）'],
  ]
  view.append(el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, '路由实现风格'),
      el('span', { class: 'muted' }, 'standard：flash 恒走 weak 内路由 + 深度思考引导静态并入 persona；minimal：旧的按任务分类行为。保存立即生效'),
    ]),
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('select', {
        id: 'minimal-routing-style',
        style: 'min-width:260px',
        ...(state.me.role === 'admin' ? {} : { disabled: '' }),
      }, styleOptions.map(([v, label]) => {
        const attrs = { value: v }
        if (v === routingStyle) attrs.selected = ''
        return el('option', attrs, label)
      })),
      state.me.role === 'admin'
        ? el('button', { class: 'primary', onclick: saveMinimalRoutingStyle }, '保存并生效')
        : null,
    ]),
    el('div', { class: 'muted', style: 'margin-top:8px' }, [
      `当前生效：${(styleOptions.find(([v]) => v === routingStyle) || [routingStyle, routingStyle])[1]}`,
      state.me.role !== 'admin' ? '（管理员可调）' : '',
    ]),
  ]))

  const routingMode = settings.minimalRoutingMode ?? 'auto'
  const modeOptions = [
    ['auto', 'auto · 按任务自动分类'],
    ['spec', 'spec · 计划-集体（we/let\'s 链）'],
    ['react', 'react · 执行者（let me 链）'],
    ['weak', 'weak · 内部路由（模型自分类）'],
  ]
  const modeLabel = (mode) => (modeOptions.find(([v]) => v === mode) || [mode, mode])[1]
  view.append(el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, '路由风格（思维链）'),
      el('span', { class: 'muted' }, '钉死路由要产出的思维链风格；spec 模式会附加 we/let\'s 集体语域锚定，立即生效'),
    ]),
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('select', {
        id: 'minimal-routing-mode',
        style: 'min-width:260px',
        ...(state.me.role === 'admin' ? {} : { disabled: '' }),
      }, modeOptions.map(([v, label]) => {
        const attrs = { value: v }
        if (v === routingMode) attrs.selected = ''
        return el('option', attrs, label)
      })),
      state.me.role === 'admin'
        ? el('button', { class: 'primary', onclick: saveMinimalRoutingMode }, '保存并生效')
        : null,
    ]),
    el('div', { class: 'muted', style: 'margin-top:8px' }, [
      `当前生效：${modeLabel(routingMode)}`,
      state.me.role !== 'admin' ? '（管理员可调）' : '',
    ]),
  ]))

  const concurrency = settings.accountMaxConcurrency ?? 1
  const spreadAccounts = settings.spreadAccounts ?? 3
  view.append(el('div', { class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, '负载均衡设置'),
        el('span', { class: 'muted' }, '先账号间负载均衡，再账号内负载均衡：并发请求平摊到最多「平摊账号数」个账号，每个账号内最多「每账号并发」个会话。账号并发没满时新请求可直接开新账号消费会话，满员时必须换新账号'),
      ]),
    ]),
    el('div', { class: 'row', style: 'margin-top:12px;gap:24px;flex-wrap:wrap' }, [
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, '平摊账号数（并发最多用几个账号）'),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'spread-accounts',
            type: 'number',
            min: 1,
            max: 16,
            style: 'width:70px',
            value: spreadAccounts,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
          state.me.role === 'admin'
            ? el('button', { class: 'primary', onclick: saveLoadBalanceSettings }, '保存并生效')
            : null,
        ]),
      ]),
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, '每账号并发（单账号同时几路流）'),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'account-concurrency',
            type: 'number',
            min: 1,
            max: 16,
            style: 'width:70px',
            value: concurrency,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
        ]),
      ]),
    ]),
    state.me.role !== 'admin'
      ? el('div', { class: 'muted', style: 'margin-top:8px' }, `当前：平摊 ${spreadAccounts} 个账号 · 每账号 ${concurrency} 路并发（管理员可调）`)
      : null,
  ]))

  const card = el('div', { id: 'proxy-card', class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, '代理设置（全局代理池）'),
        el('span', { class: 'muted' }, '填一个或多个代理，保存立即生效；账号出口由系统内部分配（同一账号固定同一出口），无需逐个配置'),
      ]),
      el('button', { class: 'primary', onclick: saveProxyPool }, [icon('globe', 14), '保存并生效']),
    ]),
    el('textarea', {
      id: 'proxy-pool',
      rows: 3,
      class: 'mono',
      style: 'margin-top:8px',
      placeholder: '一行一个代理，例如：\nhttp://user:pass@172.17.0.1:7890\nsocks5://127.0.0.1:1080\n（留空保存 = 清除全局池，走环境变量/直连）',
    }, (data.proxies || []).join('\n')),
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('input', {
        id: 'proxy-test-url',
        placeholder: '测试单个代理，如 http://172.17.0.1:2334',
        class: 'mono',
        style: 'flex:1',
      }),
      el('button', { onclick: () => runProxyTest($('#proxy-test-url').value.trim() || null) }, [icon('zap', 14), '测试']),
      el('button', { class: 'muted', onclick: () => runProxyTest(null) }, '测试已配置'),
    ]),
    el('div', { id: 'proxy-test-result', style: 'margin-top:8px' }),
    data.effective && data.effective.length
      ? el('div', { class: 'muted', style: 'margin-top:8px' }, `当前生效代理：${data.effective.map(shortProxy).join('、')}`)
      : null,
  ])
  view.append(card)
}

async function saveFreeToolSignatureSetting(event) {
  const input = event.currentTarget
  const enabled = input.checked
  input.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ freeToolSignatureEnabled: enabled }),
    })
    toast(enabled ? '工具签名兼容已开启' : '工具签名兼容已关闭')
    // 从服务端回读一次，把开关还原为可交互状态并同步到真实值，避免按钮被永久禁用
    try {
      const s = await api('/api/settings')
      const actual = s.freeToolSignatureEnabled !== false
      input.checked = actual
      updateSwitchLabel(input)
    } catch { /* 忽略回读失败，仍保持可交互 */ }
  } catch (err) {
    input.checked = !enabled
    toast(err.message, true)
  }
  input.disabled = false // 成功/失败后都恢复可交互
}

/** 一键屏蔽收费模型开关：pool=premium（gpt-5.6-luna / kimi / -max 等）从列表与调度排除 */
async function saveBlockPremiumSetting(event) {
  const input = event.currentTarget
  const enabled = input.checked
  input.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ blockPremiumModels: enabled }),
    })
    toast(enabled ? '已屏蔽收费模型（列表与调度已排除）' : '已显示收费模型')
    try {
      const s = await api('/api/settings')
      const actual = s.blockPremiumModels !== false
      input.checked = actual
      updateSwitchLabel(input)
    } catch { /* 忽略回读失败 */ }
    // 切换后即时刷新模型表（收费模型隐藏/恢复）
    refreshModelSettingsCard()
  } catch (err) {
    input.checked = !enabled
    toast(err.message, true)
    input.disabled = false
  }
}

async function saveMinimalRoutingSetting(event) {
  const input = event.currentTarget
  const enabled = input.checked
  input.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ minimalRoutingEnabled: enabled }),
    })
    toast(enabled ? '极简路由已开启（下个请求生效）' : '极简路由已关闭')
    try {
      const s = await api('/api/settings')
      const actual = s.minimalRoutingEnabled === true
      input.checked = actual
      updateSwitchLabel(input)
    } catch { /* 忽略回读失败 */ }
  } catch (err) {
    input.checked = !enabled
    toast(err.message, true)
  }
  input.disabled = false
}

/** 同步 switch 旁边的「已开启/已关闭」文字标签，保持 DOM 与状态一致 */
function updateSwitchLabel(input) {
  const track = input.closest('.switch')
  if (!track) return
  const statusEl = track.querySelector('.switch-status')
  if (statusEl) statusEl.textContent = input.checked ? '已开启' : '已关闭'
}

async function saveMinimalRoutingMode() {
  const select = $('#minimal-routing-mode')
  if (!select) return
  try {
    const r = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ minimalRoutingMode: select.value }),
    })
    toast(`路由风格已设为 ${r.minimalRoutingMode}，下个请求生效`)
    updateSettingsStatusTexts()
  } catch (err) {
    toast(err.message, true)
  }
}

async function saveMinimalRoutingStyle() {
  const select = $('#minimal-routing-style')
  if (!select) return
  try {
    const r = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ minimalRoutingStyle: select.value }),
    })
    toast(`路由实现风格已设为 ${r.minimalRoutingStyle}，下个请求生效`)
    updateSettingsStatusTexts()
  } catch (err) {
    toast(err.message, true)
  }
}

/** 更新设置卡片里的「当前生效」状态文字（保存后局部刷新，不重建页面） */
function updateSettingsStatusTexts() {
  const mode = $('#minimal-routing-mode')
  const style = $('#minimal-routing-style')
  if (mode) {
    const label = (mode.options[mode.selectedIndex] || {}).text || mode.value
    const node = [...document.querySelectorAll('.card .muted')].find((n) => n.textContent.includes('当前生效'))
    if (node) node.textContent = `当前生效：${label}`
  }
  if (style) {
    const label = (style.options[style.selectedIndex] || {}).text || style.value
    const nodes = [...document.querySelectorAll('.card .muted')].filter((n) => n.textContent.includes('当前生效'))
    const last = nodes[nodes.length - 1]
    if (last) last.textContent = `当前生效：${label}`
  }
}

async function saveLoadBalanceSettings() {
  const acc = $('#account-concurrency')
  const spread = $('#spread-accounts')
  if (!acc || !spread) return
  try {
    const v = Math.max(1, Math.min(16, parseInt(acc.value, 10) || 1))
    const s = Math.max(1, Math.min(16, parseInt(spread.value, 10) || 1))
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ accountMaxConcurrency: v, spreadAccounts: s }),
    })
    toast(`负载均衡已更新：平摊 ${s} 个账号 · 每账号 ${v} 路并发`)
    // 非 admin 提示文字局部更新（admin 输入框本身已是最新值）
    const hint = [...document.querySelectorAll('.card .muted')].find((n) => n.textContent.includes('当前：平摊'))
    if (hint) hint.textContent = `当前：平摊 ${s} 个账号 · 每账号 ${v} 路并发（管理员可调）`
  } catch (err) {
    toast(err.message, true)
  }
}

async function saveProxyPool() {
  const textarea = $('#proxy-pool')
  if (!textarea) return
  const proxies = textarea.value.split('\n').map((x) => x.trim()).filter(Boolean)
  try {
    const r = await api('/api/proxy', { method: 'POST', body: JSON.stringify({ proxies }) })
    toast(r.note || '已保存')
    // 局部刷新「当前生效代理」文字，不重建页面
    try {
      const pdata = await api('/api/proxy')
      const eff = pdata.effective || []
      const effNode = [...document.querySelectorAll('#proxy-card .muted')].find((n) => n.textContent.includes('当前生效代理'))
      if (effNode) {
        effNode.textContent = eff.length
          ? `当前生效代理：${eff.map(shortProxy).join('、')}`
          : '当前未配置代理（直连）'
      }
    } catch { /* ignore */ }
  } catch (err) {
    toast(err.message, true)
  }
}

async function runProxyTest(proxy) {
  const box = $('#proxy-test-result')
  if (!box) return
  box.innerHTML = ''
  box.append(el('span', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:6px' }, [el('span', { class: 'spinner' }), '测试中…（最多 ~12s/个）']))
  try {
    const r = await api('/api/proxy/test', {
      method: 'POST',
      body: JSON.stringify(proxy ? { proxy } : {}),
    })
    box.innerHTML = ''
    if (!r.results.length) {
      box.append(el('div', { class: 'muted' }, r.note || '当前未配置代理（直连）'))
      return
    }
    for (const res of r.results) {
      const head = res.ok
        ? el('span', { class: 'badge ok' }, [icon('check', 11), '可用'])
        : el('span', { class: 'badge err' }, [icon('x', 11), '不可用'])
      const lines = [
        el('div', {}, [
          head,
          el('code', { class: 'mono muted', style: 'margin-left:8px;font-size:12px' }, res.proxy),
        ]),
      ]
      if (res.ok) {
        lines.push(el('div', { class: 'muted' }, [
          `出口 IP: ${res.ip || '?'}`,
          res.country ? `（${res.country}）` : '',
          ` · 延迟 ${res.latencyMs}ms`,
          ` · codebuff 状态 ${res.codebuffStatus ?? '?'}`,
        ].join('')))
      } else {
        lines.push(el('div', { class: 'muted', style: 'color:var(--red)' }, `失败: ${res.error || '连接失败'}（${res.latencyMs}ms）`))
        if (res.hint) lines.push(el('div', { class: 'muted', style: 'margin-top:4px' }, res.hint))
      }
      box.append(el('div', { style: 'padding:8px 0;border-bottom:1px solid var(--border)' }, lines))
    }
  } catch (err) {
    box.innerHTML = ''
    box.append(el('div', { class: 'muted', style: 'color:var(--red)' }, `测试失败: ${err.message}`))
  }
}

function fmtMs(ms) {
  if (ms == null) return '—'
  const m = Math.floor(ms / 60000)
  return `${m} 分钟`
}

/* ---------------- model settings ---------------- */
async function renderModelSettings(view) {
  let data = { models: [], catalog: [] }
  let upstream = { models: [], accessTier: null }
  try {
    data = await api('/api/models/custom')
  } catch { /* ignore */ }
  try {
    upstream = await api('/api/models/upstream')
  } catch { /* ignore */ }

  const known = new Map()
  // catalog 先行：agent/兜底 agent 以 catalog 为准（内置目录是 agent 映射的权威源）
  for (const m of data.catalog || []) known.set(m.id, { ...m, source: 'catalog' })
  // 上游只补充额度/实时信息，不覆盖 agent（否则表格显示的 agent 与调度实际用
  // 的不一致——调度是「自定义 > catalog」，上游探测的 agentId 只是参考值）
  for (const m of upstream.models || []) {
    const prev = known.get(m.id)
    if (prev) {
      known.set(m.id, {
        ...prev,
        ...m,
        // 保留 catalog 的 agent/fallback（上游探测值不作为调度依据）
        agentId: prev.agentId || m.agentId,
        fallbackAgentId: prev.fallbackAgentId || m.fallbackAgentId,
        source: 'upstream',
      })
    } else {
      known.set(m.id, { ...m, source: 'upstream' })
    }
  }
  const rows = [...known.values()]
  const isAdmin = state.me.role === 'admin'
  // 屏蔽收费模型开关（读全局设置，默认开）
  let settings = { blockPremiumModels: true }
  try { settings = await api('/api/settings') } catch { /* 忽略 */ }
  const blockPremium = settings.blockPremiumModels !== false
  const blockToggleAttrs = {
    id: 'block-premium',
    type: 'checkbox',
    class: 'switch-input',
    onchange: saveBlockPremiumSetting,
  }
  if (blockPremium) blockToggleAttrs.checked = ''
  if (state.me.role !== 'admin') blockToggleAttrs.disabled = ''

  const card = el('div', { id: 'models-card', class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, '模型管理'),
        el('span', { class: 'muted' }, '内置目录 + 上游实时 + 自定义覆盖。上游新模型不用等发版——点「同步上游模型」自动拉取并更新 agent，或手动添加。'),
      ]),
      isAdmin
        ? el('div', { class: 'row' }, [
            el('button', { class: 'primary', onclick: syncUpstreamModels }, [icon('refresh', 14), '同步上游模型']),
          ])
        : null,
    ]),
    el('div', { class: 'row', style: 'margin-top:8px;align-items:center;gap:8px' }, [
      el('label', { class: 'switch', for: 'block-premium' }, [
        el('input', blockToggleAttrs),
        el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
        el('span', { class: 'switch-status' }, blockPremium ? '已开启' : '已关闭'),
      ]),
      el('span', { class: 'muted', style: 'font-size:12px' },
        `屏蔽收费模型（pool=premium 如 gpt-5.6-luna / kimi / -max：免费账号用不了，从列表与调度彻底排除，避免占额度/触风控）`),
    ]),
    upstream.accessTier
      ? el('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' },
          `上游实时目录（${upstream.models.length} 个）· 当前 accessTier: ${upstream.accessTier}`)
      : null,
    el('div', { class: 'table-wrap', style: 'margin-top:10px;max-height:280px;overflow:auto' }, [
      el('table', { style: 'font-size:12px' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, '模型 id'),
          el('th', {}, '显示名'),
          el('th', {}, '池'),
          el('th', {}, '额度（今日）'),
          el('th', {}, 'agent (base2)'),
          el('th', {}, '兜底 agent (base3)'),
          el('th', {}, '来源'),
          isAdmin ? el('th', {}, '操作') : null,
        ])),
        el('tbody', {}, rows.map((m) => el('tr', {}, [
          el('td', { style: 'font-family:var(--mono);font-size:11px' }, m.id),
          el('td', {}, m.display_name || m.displayName || '—'),
          el('td', {}, el('span', { class: 'badge', class: poolBadgeClass(m.pool) }, poolLabel(m.pool))),
          el('td', {}, m.limit != null
            ? el('span', {
                title: `重置 ${fmtReset(m.resetAt, m.resetTimeZone)}\n${fmtCountdown(m.resetAt)}`,
                class: 'badge ' + quotaBadgeClass(m),
              }, `${Math.ceil(Number(m.recentCount) || 0)}/${m.limit}`)
            : el('span', { class: 'muted' }, '—')),
          el('td', { style: 'font-family:var(--mono);font-size:11px' }, m.agentId || m.agent_id || '—'),
          el('td', { style: 'font-family:var(--mono);font-size:11px' }, m.fallbackAgentId || m.fallback_agent_id || '—'),
          el('td', {}, m.source === 'upstream'
            ? el('span', { class: 'badge ok' }, '上游')
            : el('span', { class: 'badge' }, '内置')),
          isAdmin
            ? el('td', {}, el('button', {
                class: 'icon danger',
                title: '删除该模型（从列表与调度中移除）',
                onclick: () => removeCustomModel(m.id),
              }, icon('trash', 13)))
            : null,
        ]))),
      ]),
    ]),
    el('div', { style: 'margin-top:14px' }, [
      el('label', { class: 'muted' }, '自定义模型（添加/编辑即自动保存，留空字段自动推导）'),
      el('div', { id: 'custom-models-editor', style: 'margin-top:6px' }, buildCustomModelRows(data.models || [])),
      el('div', { class: 'row', style: 'margin-top:8px' }, [
        isAdmin
          ? el('button', { onclick: () => addCustomModelRow() }, [icon('plus', 13), '添加模型'])
          : null,
        el('span', { class: 'muted', style: 'font-size:12px' },
          '同 id 会覆盖内置目录的显示名 / 池 / agent；agent 留空时按命名规则自动推导（base2-free-<模型名>）'),
      ]),
    ]),
    ...(isAdmin && (data.hidden || []).length
      ? [el('div', { id: 'hidden-models-area', style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--border)' }, [
          el('label', { class: 'muted' }, `已删除的模型（${data.hidden.length}）— 点击可恢复，恢复后重新出现在列表并可调度`),
          el('div', { class: 'hidden-badges row', style: 'margin-top:6px;gap:6px;flex-wrap:wrap' }, (data.hidden || []).map((id) =>
            el('span', { class: 'badge', style: 'display:inline-flex;align-items:center;gap:6px' }, [
              el('code', { style: 'font-family:var(--mono);font-size:11px' }, id),
              el('button', {
                class: 'icon', title: '恢复该模型',
                onclick: () => restoreCustomModel(id),
              }, icon('refresh', 12)),
            ]),
          )),
        ])]
      : []),
  ])
  view.append(card)
}

/** 模型管理卡片局部刷新：只重建 models-card，不重渲染整页 */
async function refreshModelSettingsCard() {
  const wrap = document.createElement('div')
  await renderModelSettings(wrap)
  const card = wrap.querySelector('#models-card')
  const old = $('#models-card')
  if (card && old) old.replaceWith(card)
}

/** 同步上游模型：只补「上游有、catalog 没有」的新模型，catalog 已有的不写入自定义。
 * 删除语义：内置模型删除=隐藏（同步会按最新上游完整拉回，不永久卡在 hidden）；
 * 手动添加的自定义模型删除=彻底移除（上游没有它，同步自然不会回来）。 */
async function syncUpstreamModels() {
  const btn = document.querySelector('#models-card .primary, .card .primary')
  let upstream
  try {
    upstream = await api('/api/models/upstream')
  } catch (err) {
    toast('拉取上游失败: ' + err.message, true)
    return
  }
  if (!upstream.models?.length) {
    toast('上游暂无可用模型', true)
    return
  }
  try {
    // 现有自定义模型（id → 定义），保留用户手动配置与彻底移除语义
    const cur = await api('/api/models/custom')
    const curById = new Map((cur.models || []).map((m) => [m.id, m]))
    // catalog 已有 id：同步绝不固化这些（catalog 就是权威，写进自定义只会冗余/错覆盖）
    const catalogSet = new Set((cur.catalog || []).map((m) => m.id))
    // merged = 保留现有自定义 +（上游有 & catalog 没有的）新模型
    // 内置被隐藏（hidden）的模型：同步按最新上游完整拉回（用户选「删除只影响当前列表」）
    const merged = []
    for (const [id, m] of curById) merged.push(m) // 保留已存在的自定义/覆盖
    for (const um of upstream.models) {
      const id = um.id
      if (!id) continue
      if (catalogSet.has(id)) continue // catalog 已有，不用写自定义
      const existing = curById.get(id) || {}
      merged.push({
        id,
        displayName: existing.displayName || um.displayName || um.poolLabel || '',
        pool: existing.pool || um.pool || '',
        agentId: existing.agentId || um.agentId || '',
        fallbackAgentId: existing.fallbackAgentId || um.fallbackAgentId || '',
      })
    }
    const r = await api('/api/models/custom', {
      method: 'POST',
      body: JSON.stringify({ models: merged }),
    })
    // save() 会把写回的自定义条目自动解除 hidden——被隐藏的内置模型同步后自然拉回
    toast(`已同步上游（自定义 ${r.models.length} 条，内置按 catalog 为准）`)
    refreshModelSettingsCard()
  } catch (err) {
    toast('同步失败: ' + err.message, true)
  }
}

/** 删除表格里的模型（内置/catalog/上游模型）：加入 hidden 隐藏，可恢复；
 * 重新「同步上游」会按最新上游拉回，不会永久丢失。
 * （用户手动添加的自定义模型在下方编辑器里删，那个是彻底移除。） */
async function removeCustomModel(id, source) {
  if (!confirm(`确定隐藏模型 ${id}？\n（内置模型隐藏后可恢复；重新同步上游会按最新列表拉回）`)) return
  // 乐观 UI：点击瞬间先从表格移除该行、插入恢复区（不等待任何网络请求）
  const row = [...document.querySelectorAll('#models-card tbody tr')].find(
    (r) => (r.querySelector('td') || {}).textContent === id,
  )
  if (row) row.remove()
  const card = $('#models-card')
  if (card) addRestoreBadge(card, id)
  try {
    await api('/api/models/custom/hide', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
    toast(`已隐藏模型 ${id}`)
  } catch (err) {
    // 失败：把行加回表格（用本地重建），并撤销恢复区，反馈错误
    toast(err.message, true)
    refreshModelSettingsCard()
  }
}

/** 彻底移除一个用户手动添加的自定义模型（回退内置目录，不会在同步时回来）。 */
async function removeCustomOnlyModel(id) {
  if (!confirm(`确定移除自定义模型 ${id}？\n（这是彻底删除，将回退到内置目录）`)) return
  try {
    const r = await api('/api/models/custom/remove', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
    toast(`已移除自定义模型 ${id}`)
    refreshModelSettingsCard()
  } catch (err) {
    toast(err.message, true)
  }
}

/** 恢复被删除（隐藏）的模型 */
async function restoreCustomModel(id) {
  // 乐观：先从恢复区移除徽章，再后台请求
  const badge = [...document.querySelectorAll('#models-card .badge')].find(
    (b) => b.querySelector('.icon[title="恢复该模型"]') && b.textContent.includes(id),
  )
  if (badge) badge.remove()
  try {
    await api('/api/models/custom/unhide', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
    toast(`已恢复模型 ${id}`)
    // 立即重建模型表卡（无需等重拉上游——本地已知恢复）
    refreshModelSettingsCard()
  } catch (err) {
    toast(err.message, true)
    refreshModelSettingsCard()
  }
}

/** 在模型卡里追加一个"已删除模型"恢复徽章（没有恢复区则先创建） */
function addRestoreBadge(card, id) {
  let area = card.querySelector('#hidden-models-area')
  if (!area) {
    area = el('div', { id: 'hidden-models-area', style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--border)' }, [
      el('label', { class: 'muted' }, '已删除的模型 — 点击可恢复'),
      el('div', { class: 'hidden-badges row', style: 'margin-top:6px;gap:6px;flex-wrap:wrap' }, []),
    ])
    card.append(area)
  }
  const label = area.querySelector('.muted')
  if (label) {
    const n = area.querySelectorAll('.badge').length
    label.textContent = `已删除的模型（${n}）— 点击可恢复，恢复后重新出现在列表并可调度`
  }
  area.querySelector('.hidden-badges').append(el('span', { class: 'badge', style: 'display:inline-flex;align-items:center;gap:6px' }, [
    el('code', { style: 'font-family:var(--mono);font-size:11px' }, id),
    el('button', { class: 'icon', title: '恢复该模型', onclick: () => restoreCustomModel(id) }, icon('refresh', 12)),
  ]))
}

/** 渲染自定义模型编辑行（可视化表单，不填 JSON） */
function buildCustomModelRows(models) {
  const wrap = el('div', { class: 'cm-rows' })
  if (!models.length) {
    wrap.append(el('div', { class: 'muted', style: 'padding:8px 0;font-size:12px' }, '还没有自定义模型——点「添加模型」开始'))
    return wrap
  }
  for (const m of models) wrap.append(customModelRow(m))
  return wrap
}

function customModelRow(m = {}) {
  const id = el('input', {
    class: 'mono',
    placeholder: 'z-ai/glm-5.3-flash',
    value: m.id || '',
    'data-f': 'id',
    style: 'flex:2;min-width:120px',
  })
  const name = el('input', {
    placeholder: '显示名（可选）',
    value: m.displayName || m.display_name || '',
    'data-f': 'displayName',
    style: 'flex:1.2;min-width:90px',
  })
  const pool = el('select', {
    'data-f': 'pool',
    style: 'flex:1;min-width:90px',
  }, ['', 'daily', 'premium', 'referral', 'limited_offer'].map((p) =>
    el('option', { value: p, selected: (m.pool || '') === p }, p ? poolLabel(p) : '池（默认）')))
  const agent = el('input', {
    class: 'mono',
    placeholder: 'base2-free-…（留空自动推导）',
    value: m.agentId || m.agent_id || '',
    'data-f': 'agentId',
    style: 'flex:2;min-width:140px',
  })
  const fbAgent = el('input', {
    class: 'mono',
    placeholder: 'base3-free-…（兜底，可选）',
    value: m.fallbackAgentId || m.fallback_agent_id || '',
    'data-f': 'fallbackAgentId',
    style: 'flex:2;min-width:140px',
  })
  const del = el('button', {
    class: 'icon danger',
    title: '删除该模型（从列表与调度中移除）',
    onclick: () => {
      const id = row.querySelector('[data-f="id"]')?.value?.trim()
      row.remove()
      const editor = $('#custom-models-editor')
      if (editor && !editor.querySelector('.cm-row')) {
        editor.append(el('div', { class: 'muted', style: 'padding:8px 0;font-size:12px' }, '还没有自定义模型——点「添加模型」开始'))
      }
      // 移除这条自定义模型（彻底删除，回退内置目录；同步不会把它加回来）
      autoSaveCustomModels()
      if (id) removeCustomOnlyModel(id)
    },
  }, icon('trash', 13))
  const row = el('div', { class: 'cm-row' }, [id, name, pool, agent, fbAgent, del])
  // 行内编辑自动保存（防抖 600ms）
  for (const input of [id, name, pool, agent, fbAgent]) {
    input.addEventListener('input', scheduleAutoSave)
    input.addEventListener('change', scheduleAutoSave)
  }
  return row
}

function addCustomModelRow() {
  const editor = $('#custom-models-editor')
  const empty = editor.querySelector('.muted')
  if (empty) empty.remove()
  editor.append(customModelRow())
  autoSaveCustomModels()
}

/** 行内编辑自动保存（防抖） */
let _cmSaveTimer = null
function scheduleAutoSave() {
  clearTimeout(_cmSaveTimer)
  _cmSaveTimer = setTimeout(() => autoSaveCustomModels(), 600)
}

/** 从可视化行收集模型数组并自动保存（前端自动组装，不填 JSON） */
async function autoSaveCustomModels() {
  const models = collectCustomModels()
  if (!models.length) return
  try {
    await api('/api/models/custom', {
      method: 'POST',
      body: JSON.stringify({ models }),
    })
  } catch (err) {
    toast('保存模型失败: ' + err.message, true)
  }
}

/** 从可视化行收集模型数组（校验必填，前端自动组装） */
function collectCustomModels() {
  const models = []
  for (const row of document.querySelectorAll('#custom-models-editor .cm-row')) {
    const get = (f) => row.querySelector(`[data-f="${f}"]`)?.value?.trim() || ''
    const id = get('id')
    if (!id) continue // 空行跳过
    const m = { id }
    const name = get('displayName')
    if (name) m.displayName = name
    const pool = get('pool')
    if (pool) m.pool = pool
    const agent = get('agentId')
    if (agent) m.agentId = agent
    const fbAgent = get('fallbackAgentId')
    if (fbAgent) m.fallbackAgentId = fbAgent
    models.push(m)
  }
  return models
}

function poolBadgeClass(pool) {
  if (pool === 'premium') return 'badge warn'
  if (pool === 'referral') return 'badge admin'
  return 'badge'
}

/** 池类型中文显示 */
const POOL_LABELS = {
  premium: '高级',
  daily: '每日',
  referral: '邀请',
  limited_offer: '限时',
  glm_v53_flash: 'GLM 5.3',
}
function poolLabel(pool) {
  if (!pool) return '—'
  return POOL_LABELS[pool] || pool
}

/** 额度徽章颜色：用尽=红，余量≤2=黄，其余=绿 */
function quotaBadgeClass(m) {
  const used = Math.ceil(Number(m.recentCount) || 0)
  const limit = Number(m.limit)
  if (!Number.isFinite(limit) || limit <= 0) return ''
  const left = limit - used
  return left <= 0 ? 'err' : left <= 2 ? 'warn' : 'ok'
}

/** 每个模型的每日免费 session 额度：已用/上限，以及重置时间 */
function fmtQuota(quota) {
  if (!quota || !quota.byModel || !Object.keys(quota.byModel).length) {
    return el('span', { class: 'muted', title: '尚无额度数据：账号首次 admit（发起对话/创建 session）后上游才会返回限额；可点行内「检测」查看' }, '—')
  }
  const chips = []
  for (const [model, q] of Object.entries(quota.byModel)) {
    if (!q) continue
    if (!Number.isFinite(q.limit)) continue
    const used = Math.ceil(Number(q.recentCount) || 0)
    const left = Math.max(0, q.limit - used)
    const cls = left <= 0 ? 'err' : left <= 2 ? 'warn' : 'ok'
    chips.push(el('span', {
      class: `badge ${cls}`,
      style: 'margin:2px 4px 2px 0',
      title: `${model}\n已用 ${used}/${q.limit} 次/日 · 重置 ${fmtReset(q.resetAt, q.resetTimeZone)}\n${fmtCountdown(q.resetAt)}`,
    }, `${shortModel(model)} ${used}/${q.limit}`))
  }
  const reset = quota.rateLimit?.resetAt || firstReset(quota.byModel)
  const resetTz = quota.rateLimit?.resetTimeZone || firstResetTz(quota.byModel)
  return el('div', {}, [
    el('div', {}, chips),
    reset ? el('div', { class: 'muted', style: 'margin-top:2px' }, [
      `重置 ${fmtReset(reset, resetTz)} · ${fmtCountdown(reset)}`,
    ]) : null,
  ])
}

function firstReset(byModel) {
  const q = Object.values(byModel || {})[0]
  return q?.resetAt || null
}

function firstResetTz(byModel) {
  const q = Object.values(byModel || {})[0]
  return q?.resetTimeZone || null
}

/**
 * 重置时刻展示：
 * - 主显示：浏览器本地时区的具体时刻（用户最直观）
 * - 附注：上游 resetTimeZone 的对应时刻 + 倒计时（明确"还有多久"）
 * resetAt 是绝对 UTC 时刻，本地/LA 只是不同视角，绝无"不准"——差异来自时区换算。
 */
function fmtReset(iso, timeZone) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  const local = `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (timeZone && canUseTz(timeZone)) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(d)
      const get = (type) => (parts.find((p) => p.type === type) || {}).value || '00'
      return `${local}（上游 ${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${tzShort(timeZone)}）`
    } catch {
      // fall through to local only
    }
  }
  return local
}

/** 距离重置还有多久（倒计时）。 */
function fmtCountdown(iso) {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return '即将重置'
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d} 天 ${h % 24} 小时后`
  }
  return `${h} 小时 ${m} 分后`
}

/** IANA 时区名 → 简短标识（America/Los_Angeles → LA）。 */
function tzShort(timeZone) {
  const m = String(timeZone).split('/')
  return m[m.length - 1] || timeZone
}

/** 浏览器是否支持该 IANA 时区（RangeError 时回退本地时区）。 */
function canUseTz(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

function shortModel(model) {
  const m = String(model || '').split('/')
  return m[m.length - 1] || model
}

function colorFor(email) {
  let h = 0
  for (const ch of String(email)) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h}, 60%, 50%)`
}

async function clearCooldown(email) {
  await api(`/api/accounts/${encodeURIComponent(email)}/cooldown/clear`, { method: 'POST' })
  toast('已解除冷却')
  refreshAccountsCard()
}

async function removeAccount(email) {
  if (!confirm(`确认删除账号 ${email}？`)) return
  await api(`/api/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' })
  toast('已删除')
  refreshOverviewAfterAccountChange()
}

/* ---------------- account credential ---------------- */
function downloadTextFile(name, content, mime = 'application/json') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function openCredentialModal(account) {
  const backdrop = el('div', { class: 'modal-backdrop' })
  const body = el('div', { class: 'card modal' }, [
    el('h3', {}, `账号凭证 · ${account.email}`),
    el('p', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:6px' }, [el('span', { class: 'spinner' }), '正在读取…']),
  ])
  backdrop.append(body)
  document.body.append(backdrop)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove() })

  let res
  try {
    res = await api(`/api/accounts/${encodeURIComponent(account.key)}/credential`)
  } catch (err) {
    body.innerHTML = ''
    body.append(el('h3', {}, '读取失败'), el('p', { class: 'muted' }, err.message))
    return
  }
  const cred = res.credential
  const json = JSON.stringify(cred, null, 2)
  const filename = `${cred.email || 'account'}-credential.json`

  body.innerHTML = ''
  body.append(
    el('h3', {}, `账号凭证 · ${cred.email}`),
    el('p', { class: 'muted' }, '凭据 JSON 可直接用于导入到其他 Freebuff Proxy 实例，或重新粘贴到「导入账号」。明文显示，仅供迁移/备份。'),
    el('textarea', {
      id: 'cred-view',
      rows: 12,
      readonly: '',
      style: 'margin-top:8px',
    }),
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'primary', onclick: async () => {
        await navigator.clipboard.writeText(json).catch(() => {})
        toast('已复制完整凭据 JSON')
      } }, [icon('copy', 14), '复制 JSON']),
      el('button', { onclick: () => downloadTextFile(filename, json) }, [icon('download', 14), '下载 JSON']),
      el('button', { onclick: () => backdrop.remove() }, '关闭'),
    ]),
  )
  $('#cred-view').value = json
}

function shortProxy(proxy) {
  const m = String(proxy || '').replace(/^https?:\/\//, '').replace(/^\/\//, '')
  return m.split('@').pop() || proxy
}

/* ---------------- add account (login flow) ---------------- */
function openAddAccount() {
  const backdrop = el('div', { class: 'modal-backdrop' })
  const body = el('div', { class: 'card modal' }, [
    el('h3', {}, '添加 Freebuff 账号（浏览器登录）'),
    el('p', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:6px' }, [el('span', { class: 'spinner' }), '服务端正在向 Freebuff 申请登录链接…']),
  ])
  backdrop.append(body)
  document.body.append(backdrop)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove() })

  api('/api/accounts/login', { method: 'POST' }).then(({ flow }) => {
    body.innerHTML = ''
    body.append(
      el('h3', {}, '添加 Freebuff 账号（浏览器登录）'),
      el('p', { class: 'muted' }, '在你自己电脑的浏览器打开下面的链接并完成登录（容器内不会打开浏览器）：'),
      el('div', { class: 'flow-url' }, flow.loginUrl),
      el('div', { class: 'row' }, [
        el('a', { style: 'display:inline-block', href: flow.loginUrl, target: '_blank', rel: 'noopener' }, el('button', { class: 'primary' }, [icon('globe', 14), '打开链接并登录'])),
        el('span', { class: 'muted' }, '完成登录后本窗口会自动刷新'),
      ]),
      el('p', { id: 'flow-status', style: 'margin-top:12px', class: 'muted' }, '等待登录回调…'),
      el('button', { style: 'margin-top:8px', onclick: () => { api(`/api/accounts/login/${flow.id}/cancel`, { method: 'POST' }).catch(() => {}); backdrop.remove() } }, '取消'),
    )
    pollFlow(flow.id, body, backdrop)
  }).catch((err) => {
    body.innerHTML = ''
    body.append(el('h3', {}, '发起登录失败'), el('p', { class: 'muted' }, err.message))
  })
}

async function pollFlow(id, body, backdrop) {
  try {
    const { flow } = await api(`/api/accounts/login/${id}`)
    const statusEl = body.querySelector('#flow-status')
    if (flow.status === 'done') {
      if (statusEl) {
        statusEl.textContent = ''
        statusEl.append(el('span', { class: 'badge ok' }, `登录成功：${flow.user?.email || ''}${flow.user?.id ? `（ID ${flow.user.id}）` : ''}`))
      }
      toast(`账号 ${flow.user?.email} 已添加，正在探测上游…`)
      setTimeout(() => { backdrop.remove(); api('/api/accounts/probe', { method: 'POST' }).catch(() => {}).then(refreshOverviewAfterAccountChange) }, 1200)
      return
    }
    if (flow.status === 'expired' || flow.status === 'cancelled') {
      if (statusEl) statusEl.textContent = flow.error || '已取消，请重新发起'
      return
    }
    if (statusEl) statusEl.textContent = '等待登录回调…（服务端正在轮询）'
  } catch {
    // transient; keep polling
  }
  setTimeout(() => pollFlow(id, body, backdrop), 2500)
}

function openLoginFlow(f) {
  window.open(f.loginUrl, '_blank', 'noopener')
}

/* ---------------- import account ---------------- */
function openImportModal() {
  const backdrop = el('div', { class: 'modal-backdrop' })
  const body = el('div', { class: 'card modal' }, [
    el('h3', {}, '导入账号'),
    el('p', { class: 'muted' }, '粘贴 credentials JSON（从旧环境导出；proxy 为可选专属出口代理）：'),
    el('textarea', { id: 'import-json', rows: 8, placeholder: '{\n  "email": "you@example.com",\n  "authToken": "...",\n  "proxy": "http://127.0.0.1:7890"\n}' }),
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'primary', onclick: async () => {
        try {
          const json = $('#import-json').value
          await api('/api/accounts/import', { method: 'POST', body: JSON.stringify({ json }) })
          toast('导入成功，正在探测上游…')
          backdrop.remove()
          try { await api('/api/accounts/probe', { method: 'POST' }) } catch { /* ignore */ }
          refreshOverviewAfterAccountChange()
        } catch (err) { toast(err.message, true) }
      } }, [icon('box', 14), '导入']),
      el('button', { onclick: () => backdrop.remove() }, '取消'),
    ]),
  ])
  backdrop.append(body)
  document.body.append(backdrop)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove() })
}

/* ---------------- users ---------------- */
async function renderUsers(view) {
  view.innerHTML = ''
  view.append(el('div', { class: 'row spread', style: 'margin-bottom:16px' }, [
    el('h2', { style: 'margin:0' }, '用户管理'),
    el('button', { class: 'muted', onclick: () => renderUsers(view) }, [icon('refresh', 13), '局部刷新']),
  ]))
  state.users = (await api('/api/users')).data

  const table = el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, el('tr', {}, ['用户名', '角色', 'API Key', '操作'].map((t) => el('th', {}, t)))),
      el('tbody', {}, state.users.map((u, i) => {
        return el('tr', { class: 'row-in', style: `animation-delay:${i * 40}ms` }, [
          el('td', {}, `${u.username} ${u.username === state.me.username ? el('span', { class: 'muted' }, '(我)') : ''}`),
          el('td', {}, u.role === 'admin' ? el('span', { class: 'badge admin' }, 'admin') : el('span', { class: 'badge' }, 'user')),
          el('td', {}, el('div', { class: 'row' }, [
            el('code', { class: 'mono muted', style: 'font-size:12px' }, maskKey(u.apiKey)),
            el('button', { class: 'icon', title: '复制完整 Key', onclick: async () => { await navigator.clipboard.writeText(u.apiKey).catch(() => {}); toast('已复制完整 Key') } }, icon('copy', 13)),
            el('button', { onclick: async () => {
              if (!confirm(`重置 ${u.username} 的 API Key？旧 Key 立即失效`)) return
              const r = await api(`/api/users/${encodeURIComponent(u.username)}/reset-key`, { method: 'POST' })
              toast(`新 Key: ${r.apiKey}`)
              renderUsers(view)
            } }, '重置'),
          ])),
          el('td', {}, el('div', { class: 'row' }, [
            el('button', { class: 'muted', onclick: () => openUserModal(u, view) }, '改密'),
            u.username !== state.me.username
              ? el('button', { class: 'danger', onclick: async () => {
                  if (!confirm(`删除用户 ${u.username}？`)) return
                  await api(`/api/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' })
                  renderUsers(view)
                } }, '删除')
              : null,
          ])),
        ])
      })),
    ]),
  ])
  view.append(el('div', { class: 'card', style: 'padding:0;overflow:hidden;margin-bottom:16px' }, table))

  const form = el('div', { class: 'card' }, [
    el('h3', { style: 'margin:0 0 8px' }, '新建用户'),
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(180px,1fr))' }, [
      el('div', {}, [el('label', {}, '用户名'), el('input', { id: 'nu-user', placeholder: 'alice' })]),
      el('div', {}, [el('label', {}, '初始密码'), el('input', { id: 'nu-pass', placeholder: '≥6 位' })]),
      el('div', {}, [el('label', {}, '角色'), el('select', { id: 'nu-role' }, [el('option', { value: 'user' }, 'user'), el('option', { value: 'admin' }, 'admin')])]),
    ]),
    el('div', { style: 'margin-top:14px' }),
    el('button', { class: 'primary', onclick: async () => {
      try {
        const r = await api('/api/users', {
          method: 'POST',
          body: JSON.stringify({
            username: $('#nu-user').value,
            password: $('#nu-pass').value,
            role: $('#nu-role').value,
          }),
        })
        toast(`已创建 ${r.user.username}，API Key: ${r.user.apiKey}`)
        renderUsers(view)
      } catch (err) { toast(err.message, true) }
    } }, [icon('plus', 14), '创建用户']),
  ])
  view.append(form)
}

function maskKey(key) {
  if (!key) return '—'
  return key.slice(0, 12) + '…' + key.slice(-4)
}

function openUserModal(u, view) {
  const backdrop = el('div', { class: 'modal-backdrop' })
  const body = el('div', { class: 'card modal' }, [
    el('h3', {}, `修改 ${u.username} 的密码`),
    el('label', {}, '新密码'),
    el('input', { id: 'pw-new', type: 'password' }),
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'primary', onclick: async () => {
        try {
          await api(`/api/users/${encodeURIComponent(u.username)}/password`, {
            method: 'POST',
            body: JSON.stringify({ password: $('#pw-new').value }),
          })
          toast('密码已更新')
          backdrop.remove()
        } catch (err) { toast(err.message, true) }
      } }, [icon('check', 14), '保存']),
      el('button', { onclick: () => backdrop.remove() }, '取消'),
    ]),
  ])
  backdrop.append(body)
  document.body.append(backdrop)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove() })
}

/* ---------------- playground ---------------- */
async function renderPlayground(view) {
  view.innerHTML = ''
  let models = []
  try {
    const list = await api('/api/models')
    models = list.data.filter((m) => m.available !== false)
  } catch { /* ignore */ }

  view.append(el('div', { class: 'row spread', style: 'margin-bottom:16px' }, [
    el('h2', { style: 'margin:0' }, '测试对话'),
    el('span', { class: 'muted' }, '经 /v1/chat/completions 真实转发（流式）'),
  ]))
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr))' }, [
      el('div', {}, [
        el('label', {}, '模型'),
        el('select', { id: 'pg-model' }, models.map((m) => el('option', { value: m.id, selected: m.id === 'deepseek/deepseek-v4-flash' }, m.id))),
      ]),
      el('div', {}, [
        el('label', {}, 'API Key（默认用你的）'),
        el('input', { id: 'pg-key', value: state.me.apiKey, class: 'mono' }),
      ]),
    ]),
    el('label', {}, '消息（一行一条，user/assistant 前缀可选）'),
    el('textarea', { id: 'pg-msg', rows: 4, placeholder: '你好，介绍一下你自己' }),
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'primary', onclick: sendChat }, [icon('chat', 14), '发送']),
    ]),
    el('div', { class: 'chat-log', id: 'pg-log', style: 'margin-top:12px' }, ''),
  ])
  view.append(card)
}

async function sendChat() {
  const log = $('#pg-log')
  const model = $('#pg-model').value
  const key = $('#pg-key').value.trim()
  const raw = $('#pg-msg').value.trim()
  if (!model || !raw) return
  const messages = raw.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^(user|assistant|system):\s*(.*)$/i)
    return m ? { role: m[1].toLowerCase(), content: m[2] } : { role: 'user', content: line }
  })
  log.textContent = ''
  log.append(el('div', { class: 'user' }, [icon('user', 12), ' ' + raw.split('\n')[0] + (raw.split('\n').length > 1 ? ' …' : '')]))
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, stream: true }),
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try { const j = await res.json(); msg = j.error?.message || j.error || msg } catch { /* noop */ }
      log.append(el('div', { class: 'assistant', style: 'color:var(--red)' }, '错误: ' + msg))
      return
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let out = el('div', { class: 'assistant assistant-typing' }, '')
    log.append(out)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
          const delta = j.choices?.[0]?.delta?.content || ''
          if (delta) out.textContent += delta
        } catch { /* partial line */ }
      }
      log.scrollTop = log.scrollHeight
    }
    out.classList.remove('assistant-typing')
  } catch (err) {
    log.append(el('div', { style: 'color:var(--red)' }, '错误: ' + err.message))
  }
}

/* ---------------- me ---------------- */
async function renderMe(view) {
  view.innerHTML = ''
  const me = state.me
  const card = el('div', { class: 'card', style: 'max-width:720px' }, [
    el('div', { class: 'row spread', style: 'margin-bottom:16px' }, [
      el('h2', { style: 'margin:0' }, '我的信息'),
      el('span', { class: 'muted' }, me.role === 'admin' ? el('span', { class: 'badge admin' }, 'admin') : me.role),
    ]),
    // 定义列表
    el('div', { class: 'kv-list' }, [
      el('div', { class: 'kv' }, [el('span', { class: 'k muted' }, '用户名'), el('span', { class: 'v' }, me.username)]),
      el('div', { class: 'kv' }, [el('span', { class: 'k muted' }, '角色'), el('span', { class: 'v' }, me.role === 'admin' ? '管理员' : '普通用户')]),
      el('div', { class: 'kv' }, [el('span', { class: 'k muted' }, '会话调度'), el('span', { class: 'v' }, '热会话优先：同模型请求复用现有会话，故障时自动切换账号')]),
    ]),
    // API Key 独立代码块
    el('label', { style: 'margin-top:20px' }, 'API Key（下游 Bearer token）'),
    el('div', { class: 'key-block' }, [
      el('code', { class: 'mono', id: 'me-key', style: 'font-size:12px;word-break:break-all;flex:1;min-width:0' }, me.apiKey),
      el('button', { class: 'icon', title: '复制', onclick: async () => { await navigator.clipboard.writeText(me.apiKey).catch(() => {}); toast('已复制') } }, icon('copy', 14)),
    ]),
    el('p', { class: 'muted', style: 'margin-top:16px' }, '下游 Agent 接入：把上面 API Key 作为 Bearer token，base_url 指向本服务，例如'),
    // curl 示例：深色代码块，横向滚动不溢出卡片
    el('pre', { class: 'code-block mono' },
      `curl http://127.0.0.1:8787/v1/chat/completions \\\n  -H "Authorization: Bearer ${me.apiKey || 'sk-fb-…'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'`),
  ])
  view.append(card)
}

/* ---------------- boot ---------------- */
window.addEventListener('hashchange', render)
window.addEventListener('DOMContentLoaded', async () => {
  // 版本号/仓库地址：由发版流水线硬编码进 dashboard/version.json；本地没有则 fallback dev
  try {
    const res = await fetch('/version.json', { cache: 'no-store' })
    if (res.ok) state.version = await res.json()
  } catch { /* 本地开发没有 version.json，保持 dev */ }
  try {
    const { user } = await api('/api/me')
    state.me = user
  } catch {
    state.me = null
  }
  render()
})
