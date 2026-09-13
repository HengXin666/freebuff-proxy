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
      //
      // 警告：**现成节点请直接塞进 children，不要这里拼 HTML 字符串**。
      // 该分支走的是 HTML 片段解析（insertAdjacentHTML），会把手写的 SVG 片段
      // 当成 HTML 解析：没写自闭合斜杠的形状标签（<circle ...>）会吞掉后面的
      // 兄弟节点，多个图标因此并成一个、后续内容整段不渲染（历史故障）。
      // 图标请一律用 icon()，它已经统一补好自闭合斜杠。
      // 新增图标若忘了写斜杠，这里给开发者留一条可见的线索。
      if (/<(rect|circle|ellipse|line|polyline|polygon)[^<>]*[^/]>/i.test(c)) {
        console.warn('[dashboard] HTML 片段里有未自闭合的 SVG 形状标签，'
          + '可能吞掉相邻节点；请改用 icon() 或补上" /"', c)
      }
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
  /**
   * 图标路径是**手写的 SVG 片段**，很多自闭合形状（<rect ... /> / <circle ... />）
   * 漏了斜杠，HTML 解析器会把它当成开标签把后面的兄弟节点吞进去 ——
   * 这正是「点局部刷新后多出一条栏目」的原因之一（另一个是刷新选错了容器，
   * 见 refreshAccountsCard 里的注释）。
   * 这里统一补上 XHTML 自闭合斜杠，让每个图形的边界明确。
   */
  svg.innerHTML = normalizeSvgPaths(paths)
  return svg
}

/** 给未闭合的形状标签补 ` /`（<rect x=..> → <rect x=.. />），保持文本模板解析。 */
function normalizeSvgPaths(paths) {
  const re = new RegExp(
    '<(rect|circle|ellipse|line|polyline|polygon|path|use|image)([^<>]*?)(?<!/)>',
    'g',
  )
  return String(paths).replace(re, '<$1$2 />')
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
    await renderDataFilesCard(view)
    await renderProxySettings(view)
    await renderModelSettings(view)
    if (state.me.role === 'admin') await renderFlowsCard(view)
  } catch (err) {
    endProgress()
    view.innerHTML = ''
    view.append(el('div', { class: 'card' }, err.message))
  }
}

/**
 * 数据文件自检（/api/system/data-status）。
 *
 * 起因是真实故障：镜像升级后服务起不来，日志里只有一行 warn，用户只能靠
 * "删掉几个 json 就好了"试错。这里把 data/ 下每个 JSON 的装载状态摊开显示，
 * 损坏的给出**可直接照做**的处置命令，并把"哪些是派生数据（删了自动重建）、
 * 哪些是真源（删了就丢用户/丢退款句柄）"讲清楚。
 */
async function renderDataFilesCard(view) {
  let data = null
  try { data = await api('/api/system/data-status') } catch { return }
  const files = data?.files || []
  if (!files.length) return
  const invalid = files.filter((f) => f.status === 'invalid')
  const dirty = files.filter((f) => (f.droppedEntries || 0) > 0)
  const summary = invalid.length
    ? `${invalid.length} 个损坏`
    : dirty.length
      ? `${dirty.length} 个含非法条目（已自动丢弃）`
      : '全部正常'
  const card = el('div', { id: 'data-files-card', class: 'card', style: 'margin-top:12px' })
  card.append(el('div', { class: 'row spread' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, '数据文件自检'),
      el('span', { class: 'muted' }, `${data.dir} · 共 ${files.length} 个 JSON（${summary}）`),
    ]),
    el('button', { class: 'muted', onclick: () => refreshDataFilesCard() }, [icon('refresh', 13), '局部刷新']),
  ]))
  if (invalid.length) {
    card.append(el('div', { class: 'muted', style: 'margin-top:8px;color:var(--red)' },
      '⚠ 损坏的文件会让对应功能降级（配置回落默认值 / 账号履历丢失 / 会话退款索引丢失）。'
      + '停服后把文件移走再启动即可自动重建；下面的命令可直接照做。'))
  }
  if (dirty.length) {
    card.append(el('div', { class: 'muted', style: 'margin-top:8px;color:var(--yellow,#e0a800)' },
      '⚠ 有文件里混进了结构非法的记录（null / 缺关键字段）。这类文件**本身没坏**，'
      + '新版本会逐条丢弃并留证，不影响启动——但请核对丢掉的原文，必要时从备份恢复。'))
  }
  const rows = files.map((f) => {
    const dirtyCount = f.droppedEntries || 0
    const badge = f.status === 'invalid'
      ? el('span', { class: 'badge err' }, '损坏')
      : f.status === 'missing'
        ? el('span', { class: 'badge' }, '尚未生成')
        : dirtyCount
          ? el('span', { class: 'badge err' }, `脏条目 ×${dirtyCount}`)
          : el('span', { class: 'badge ok' }, '正常')
    const desc = f.status === 'invalid'
      ? f.reason
      : dirtyCount
        ? `${f.droppedReason || '含非法条目'}${f.droppedBackup ? '；原文: ' + f.droppedBackup.split('/').pop() : ''}`
        : f.reason || (f.status === 'missing' ? '首次启动会自动创建' : '—')
    return el('tr', {}, [
      el('td', { class: 'mono', style: 'font-size:12px' }, f.name + (f.critical ? ' ⚠' : '')),
      el('td', {}, badge),
      el('td', { class: 'muted', style: 'font-size:12px' }, desc),
      el('td', {}, f.status === 'invalid'
        ? codeCopyButton(`mv ${f.file} ${f.file}.broken`)
        : el('span', { class: 'muted' }, dirtyCount ? '无需处置（已自动丢弃）' : '—')),
    ])
  })
  card.append(el('div', { class: 'table-wrap', style: 'margin-top:10px' }, [
    el('table', { style: 'font-size:12px' }, [
      el('thead', {}, el('tr', {}, ['文件', '状态', '说明', '处置'].map((t) => el('th', {}, t)))),
      el('tbody', {}, rows),
    ]),
  ]))
  view.append(card)
}

/** 一键复制命令的小按钮（运维照抄用）。 */
function codeCopyButton(cmd) {
  return el('div', { class: 'row', style: 'gap:6px' }, [
    el('code', { class: 'mono', style: 'font-size:11px' }, cmd),
    el('button', {
      class: 'icon', title: '复制这条命令',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(cmd)
          toast('已复制处置命令')
        } catch {
          toast('复制失败，请手动选中', true)
        }
      },
    }, icon('copy', 12)),
  ])
}

/** 数据文件自检卡片局部刷新。 */
async function refreshDataFilesCard() {
  const old = $('#data-files-card')
  if (!old) return
  const holder = document.createElement('div')
  await renderDataFilesCard(holder)
  const fresh = holder.querySelector('#data-files-card')
  if (fresh) old.replaceWith(fresh)
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
  // 全局闸门占用：inFlight 贴着 limit 不动就是槽位泄漏（服务会"看着在跑
  // 却不接单"）。排队数 >0 说明已经在限流。
  const slots = data.slots || null
  const gateValue = slots ? `${slots.inFlight}/${slots.limit}` : String(inFlight)
  const gateFull = slots ? slots.inFlight >= slots.limit : false
  const cards = [
    { label: '账号总数', value: total, cls: '' },
    { label: '可用账号', value: available, cls: 'green' },
    { label: '冷却中', value: cooldown, cls: cooldown ? 'yellow' : 'green' },
    {
      label: slots && slots.queued ? `在途请求（排队 ${slots.queued}）` : '在途请求',
      value: gateValue,
      cls: gateFull ? 'red' : '',
    },
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
    el('button', { class: 'muted', onclick: () => refreshAccountsCard({ silent: false }) }, [icon('refresh', 13), '局部刷新']),
  ])
  card.append(head)

  if (totalReq > 0) {
    const bar = el('div', { class: 'balance-bar', id: 'balance-bar' })
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

  // 账号分区容器必须**自带 id**：局部刷新要按它整体替换。
  // 早先这里直接 append 一个没 id 的 div，刷新时用 $('.table-wrap') 选到的却是
  // **第一个分区里的表**，把它替换成"整张新表"，于是新表被塞进第一个 <details>
  // 里、旧分区原样留着——用户看到的就是「多出一条栏目、旧的没被删掉」。
  card.append(el('div', { id: 'accounts-sections' }, buildAccountsTable(data.accounts)))
  return card
}

/**
 * 账号分区（用户口径）：按"这个号现在处于什么处境"分组，默认只展开"正在调度"，
 * 其余折叠——避免一屏全是已经被打废的号，把真正在干活的号淹掉。
 *
 * 顺序即优先级：封禁 > 额度不足 > 警告 > 正在调度 > 从未使用。判定按"最坏优先"，
 * 一个号只出现在一个分区里（否则"已封禁"还会同时出现在"额度不足"里，看着像有救）。
 */
const ACCOUNT_SECTIONS = [
  { id: 'banned', label: '已被封禁', hint: '上游已封号，不会再被调度', tone: 'err' },
  { id: 'exhausted', label: '额度不足', hint: 'Freebucks 买不起当前模型，等池子刷新或加号', tone: 'err' },
  { id: 'warning', label: '出现警告', hint: '限流 / 风控 / 探测失败，但还没封号', tone: 'warn' },
  { id: 'active', label: '正在调度', hint: '有活跃会话或已被选中过', tone: 'ok', open: true },
  { id: 'fresh', label: '从未使用', hint: '还没被调度过（干净号，尽量别浪费）', tone: 'idle' },
]

/** 把一个账号归类到唯一分区（最坏优先）。 */
function classifyAccount(a) {
  const probe = a.lastProbe && a.lastProbe.ok === false ? a.lastProbe : null
  const code = String(probe?.code || '').toLowerCase()
  // 1) 封禁：探测明确 banned，或已记录过封禁时间
  if (a.bannedAt || code.includes('banned')) return 'banned'
  // 2) 额度不足：**与后端 freebucksFor 的两条封号判定严格对齐**——
  //    ① 今日池跑完（daily.remaining <= 0，且 limit > 0 才算真有池子）；
  //    ② 余额买不起当前模型（balance < 单价）。
  //    前端先于后端修好过这条，而当时后端只判 ②，于是出现"控制台显示已用尽、
  //    调度器却仍把请求送上去"的错位；两处必须保持一致。
  const fb = a.freebucks
  if (fb) {
    const price = fb.prices && a.session?.model ? fb.prices[a.session.model] : null
    const short =
      price != null && !fb.quotaExempt && Number(fb.balance) < Number(price)
    const dailyGone =
      fb.daily && Number(fb.daily.remaining) <= 0 && Number(fb.daily.limit) > 0
    if (short || dailyGone) return 'exhausted'
  }
  // 3) 警告：探测失败（风控/限流/凭证）或正在冷却
  if (probe || a.cooldownUntil) return 'warning'
  // 4) 正在调度：有活跃/在途会话，或被选号过
  if (a.session?.live || a.used || a.requests > 0 || a.inFlight > 0) return 'active'
  // 5) 剩下的就是从未使用
  return 'fresh'
}

function buildAccountsTable(accounts) {
  const groups = new Map(ACCOUNT_SECTIONS.map((s) => [s.id, []]))
  for (const a of accounts) {
    const id = classifyAccount(a)
    ;(groups.get(id) || groups.get('fresh')).push(a)
  }
  const node = el('div', { style: 'margin-top:12px' })
  for (const section of ACCOUNT_SECTIONS) {
    const rows = groups.get(section.id) || []
    if (!rows.length) continue
    const table = el('div', { class: 'table-wrap' }, [
      el('table', {}, [
        el('thead', {}, el('tr', {}, ['账号', '状态', 'Session', '并发', '时间（导入/更新/调度）', '额度（今日 · FB/h）', 'Freebucks', '请求', '冷却', '操作'].map((t) => el('th', {}, t)))),
        el('tbody', {}, rows.map((a, i) => buildAccountRow(a, i))),
      ]),
    ])
    const details = el('details', { class: 'acct-section', ...(section.open ? { open: 'open' } : {}) }, [
      el('summary', {}, [
        el('span', { class: `badge ${section.tone}` }, `${rows.length}`),
        el('span', { style: 'margin-left:8px;font-weight:600' }, section.label),
        el('span', { class: 'muted', style: 'margin-left:8px;font-size:12px' }, section.hint),
      ]),
      table,
    ])
    node.append(details)
  }
  return node
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
  const hasSession = Boolean(a.session?.live)
  const ops = el('div', { class: 'row', style: 'gap:6px' }, [
    el('button', { class: 'icon muted', title: '检测该账号（只读拉取状态/模型列表，不占额度）', onclick: (e) => probeAccount(a, e.currentTarget) }, icon('activity', 14)),
    hasSession
      ? el('button', { class: 'icon', title: '关闭这个上游会话（立即早退 DELETE，停止按占用时长计费；有回复在传输时会先等它结束）', onclick: (e) => closeAccountSession(a, e.currentTarget) }, icon('x', 14))
      : null,
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
    accountTimeCell(a),
    el('td', {}, fmtQuota(a.quota, a.freebucks)),
    el('td', {}, fmtFreebucks(a.freebucks, a.session?.model, a.lastRefund)),
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

/**
 * 账号表局部刷新（不重建整个页面）。
 * 默认**不弹 toast**：它常被操作成功后调用，一起弹会把"操作结果"顶掉
 * （实测点「关闭会话」后用户只看到"账号状态已刷新"）。要提示就由调用方自己弹。
 */
async function refreshAccountsCard({ silent = true } = {}) {
  const wrap = $('#accounts-sections')
  if (!wrap) return render()
  wrap.classList.add('refreshing')
  try {
    const data = await api('/api/overview')
    state.accounts = data.accounts
    // 整体替换容器内部（不换容器本身，旧内容必然清空，不会残留分区）
    wrap.innerHTML = ''
    wrap.append(buildAccountsTable(data.accounts))
    wrap.classList.remove('refreshing')
    refreshSnapshotExtras(data)
    if (!silent) toast('账号状态已刷新')
  } catch (err) {
    wrap.classList.remove('refreshing')
    toast(err.message, true)
  }
}

/**
 * 概览页 snapshot 型区块的定点刷新：统计卡、负载均衡条、账号池计数。
 * 都不重建页面、不动其它卡片。
 */
function refreshSnapshotExtras(data) {
  const statGrid = $('.stat-grid', $('#app'))
  if (statGrid) statGrid.replaceWith(renderStatCards(data))
  const barHost = $('#balance-bar')
  const totalReq = (data.accounts || []).reduce((n, a) => n + (a.requests || 0), 0)
  if (barHost && totalReq > 0) {
    barHost.innerHTML = ''
    for (const a of data.accounts) {
      if (!a.requests) continue
      const pct = Math.round((a.requests / totalReq) * 100)
      barHost.append(el('div', {
        style: `flex:${pct};background:${colorFor(a.email)}`,
        title: `${a.email} ${pct}%（${a.requests}/${totalReq}）`,
      }))
    }
  }
  const h2 = $('#app h2')
  if (h2 && h2.textContent.startsWith('账号池') && data.accountCount != null) {
    h2.textContent = `账号池（${data.accountCount}）`
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
    // 与 refreshAccountsCard 共用同一套定点更新（同一个 id 容器），
    // 绝不再用 $('.table-wrap') 去选"第一个分区的表"。
    const wrap = $('#accounts-sections')
    if (wrap) {
      wrap.innerHTML = ''
      wrap.append(buildAccountsTable(data.accounts))
    }
    refreshSnapshotExtras(data)
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
        .map(([id, info]) => `${shortModel(id)} ${fmtNum(info?.recentCount)}/${info?.limit ?? '?'}`)
        .join(' · ')
      toast(`✅ ${a.email} 可用 · ${modelCount} 个模型${models ? '：' + models : ''}`)
      await refreshAccountsCard()
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
    const wrap = $('#accounts-sections')
    if (wrap) {
      wrap.innerHTML = ''
      wrap.append(buildAccountsTable(r.accounts))
      refreshSnapshotExtras({ accounts: r.accounts })
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

  const concurrency = settings.accountMaxConcurrency ?? 2
  const schedMode = settings.accountSchedulingMode === 'spread' ? 'spread' : 'sticky'
  const overflowWaitMs = settings.accountOverflowWaitMs ?? 15000
  view.append(el('div', { class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, '账号调度'),
        el('span', { class: 'muted' }, '粘性优先 = 请求集中到尽可能少的账号（换号 = 新买一条 Freebucks 计费行，能复用就复用）；并发优先 = 账号满员就换号，不再让请求在一个号上干等。两种模式都优先复用同模型热 session、都让从未用过的账号排最后。'),
      ]),
    ]),
    el('div', { class: 'row', style: 'margin-top:12px;gap:24px;flex-wrap:wrap' }, [
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, '调度模式'),
        el('div', { class: 'row' }, [
          el('select', {
            id: 'scheduling-mode',
            style: 'width:210px',
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }, [
            el('option', { value: 'sticky', ...(schedMode === 'sticky' ? { selected: '' } : {}) }, '粘性优先（最少换号，默认）'),
            el('option', { value: 'spread', ...(schedMode === 'spread' ? { selected: '' } : {}) }, '并发优先（满员即换号）'),
          ]),
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
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, '溢出排队上限（毫秒，仅并发优先）'),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'overflow-wait-ms',
            type: 'number',
            min: 0,
            max: 600000,
            step: 1000,
            style: 'width:110px',
            value: overflowWaitMs,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
        ]),
      ]),
      state.me.role === 'admin'
        ? el('div', { style: 'align-self:flex-end' }, el('button', { class: 'primary', onclick: saveLoadBalanceSettings }, '保存并生效'))
        : null,
    ]),
    el('div', { class: 'muted', id: 'scheduling-hint', style: 'margin-top:8px' }, schedulingHint(schedMode, concurrency, overflowWaitMs) + (state.me.role !== 'admin' ? '（管理员可调）' : '')),
  ]))

  const idleReleaseSec = settings.idleReleaseSec ?? 60
  const maxNewSessions = settings.maxNewSessionsPerRequest ?? 2
  view.append(el('div', { class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, '额度保护（Freebucks 计费）'),
        el('span', { class: 'muted' }, '上游 2026-09 改版：按 Freebucks 计量 —— 每个模型有单价（N/h），session 从 admit 起按时长计费、提前结束（DELETE）把未用时长退回。所以会话空挂后台 = 白扣时长，空闲要及时早退；报错时也不要挨个账号去 admit（换号 = 新买一条计费行）。'),
      ]),
    ]),
    el('div', { class: 'row', style: 'margin-top:12px;gap:24px;flex-wrap:wrap' }, [
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, '空闲自动释放（秒，0 = 关闭；最小 5）'),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'idle-release-sec',
            type: 'number',
            min: 0,
            max: 86400,
            style: 'width:90px',
            value: idleReleaseSec,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
        ]),
      ]),
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, '单请求新会话上限（个）'),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'max-new-sessions',
            type: 'number',
            min: 0,
            max: 16,
            style: 'width:90px',
            value: maxNewSessions,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
          state.me.role === 'admin'
            ? el('button', { class: 'primary', onclick: saveQuotaProtectionSettings }, '保存并生效')
            : null,
        ]),
      ]),
    ]),
    el('div', { class: 'muted', style: 'margin-top:8px' }, idleReleaseSec > 0
      ? `当前：会话空闲 ${idleReleaseSec}s 后早退退款（按未用时长退 Freebucks）· 一个请求最多新建 ${maxNewSessions || '不限'} 个上游会话`
      : `当前：空闲不释放（旧行为，账号会一直挂到过期）· 一个请求最多新建 ${maxNewSessions || '不限'} 个上游会话`),
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

/** 同步 switch 旁边的「已开启/已关闭」文字标签，保持 DOM 与状态一致 */
function updateSwitchLabel(input) {
  const track = input.closest('.switch')
  if (!track) return
  const statusEl = track.querySelector('.switch-status')
  if (statusEl) statusEl.textContent = input.checked ? '已开启' : '已关闭'
}

/**
 * 调度模式说明文案（前端即时预览，保存后由服务端返回的实际值再刷新一次）。
 * 这段文字是用户理解"为什么只开了一个号"的关键，措辞要直白。
 */
function schedulingHint(mode, concurrency, overflowWaitMs) {
  const cap = `每账号 ${concurrency} 路并发`
  if (mode === 'spread') {
    return `当前：并发优先 · ${cap}。账号满员就立刻换到下一个有空闲槽位的账号（最多先等 ${overflowWaitMs} ms），不会再出现"设了并发 2 却只开 1 个号"。已用过的账号仍优先于从未用过的账号。`
  }
  return `当前：粘性优先 · ${cap}。并发请求先挤同一账号（超过上限就在该账号排队，超时才溢出到下一个），最少换号 = 最少新建计费会话。想让并发铺开多个账号，把模式改成「并发优先」。`
}

async function saveLoadBalanceSettings() {
  const acc = $('#account-concurrency')
  if (!acc) return
  const modeEl = $('#scheduling-mode')
  const waitEl = $('#overflow-wait-ms')
  try {
    const v = Math.max(1, Math.min(16, parseInt(acc.value, 10) || 2))
    const mode = modeEl && modeEl.value === 'spread' ? 'spread' : 'sticky'
    const waitMs = Math.max(
      0,
      Math.min(600000, parseInt((waitEl && waitEl.value) || '15000', 10) || 0),
    )
    const res = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        accountMaxConcurrency: v,
        accountSchedulingMode: mode,
        accountOverflowWaitMs: waitMs,
      }),
    })
    // 用服务端回传的**实际生效值**刷新控件与文案（夹取/clamp 后的真值）
    const realMode = res.accountSchedulingMode === 'spread' ? 'spread' : 'sticky'
    const realWait = res.accountOverflowWaitMs ?? waitMs
    const realConc = res.accountMaxConcurrency ?? v
    acc.value = realConc
    if (modeEl) modeEl.value = realMode
    if (waitEl) waitEl.value = realWait
    toast(
      realMode === 'spread'
        ? `调度已更新：并发优先 · 每账号 ${realConc} 路（满员即换号）`
        : `调度已更新：粘性优先 · 每账号 ${realConc} 路（先排队，超时才换号）`,
    )
    const hint = $('#scheduling-hint')
    if (hint) {
      hint.textContent =
        schedulingHint(realMode, realConc, realWait) +
        (state.me.role !== 'admin' ? '（管理员可调）' : '')
    }
  } catch (err) {
    toast(err.message, true)
  }
}

/** 保存「额度保护」设置：空闲自动释放秒数 + 单请求新会话预算（立即生效） */
async function saveQuotaProtectionSettings() {
  const idle = $('#idle-release-sec')
  const budget = $('#max-new-sessions')
  if (!idle || !budget) return
  try {
    const v = Math.max(0, Math.min(86400, parseInt(idle.value, 10) || 0))
    const b = Math.max(0, Math.min(16, parseInt(budget.value, 10) || 0))
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ idleReleaseSec: v, maxNewSessionsPerRequest: b }),
    })
    toast(v > 0
      ? `额度保护已更新：空闲 ${v}s 后早退退款 · 单请求最多 ${b || '不限'} 个新会话`
      : `已关闭空闲释放（旧行为）· 单请求最多 ${b || '不限'} 个新会话`)
    const hint = [...document.querySelectorAll('.card .muted')].find((n) => n.textContent.includes('空闲不释放') || n.textContent.includes('后早退退款'))
    if (hint) {
      hint.textContent = v > 0
        ? `当前：会话空闲 ${v}s 后早退退款 · 一个请求最多新建 ${b || '不限'} 个上游会话`
        : `当前：空闲不释放（旧行为，账号会一直挂到过期）· 一个请求最多新建 ${b || '不限'} 个上游会话`
    }
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
          ` · 上游状态 ${res.codebuffStatus ?? '?'}`,
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

/**
 * 时长（毫秒）→ 人类可读：<1 分钟显示秒，<1 小时显示 m/s，否则 h/m。
 * 调度时长经常只有几十秒（短批量），fmtMs 一律显示 "0 分钟" 会看不出差别。
 */
function fmtDurationMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '0'
  const s = Math.floor(n / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 时 ${m % 60} 分`
}

/** 时间戳 → 短格式（月-日 时:分），无值时 '—'。 */
function fmtTime(iso) {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 账号时间轴单元格：导入 / 更新 / 调度累计（+ 本轮实时）。
 * 全部来自持久化账本（/data/account-state.json），重启/换容器都不丢。
 * 悬停显示完整本地时间，避免列太宽。
 */
function accountTimeCell(a) {
  const imported = fmtTime(a.importedAt)
  const updated = a.credentialUpdatedAt ? fmtTime(a.credentialUpdatedAt) : null
  const total = fmtDurationMs(a.scheduledMs)
  const running =
    a.currentSchedulingMs > 0
      ? `本轮 ${fmtDurationMs(a.currentSchedulingMs)}`
      : a.lastScheduledAt
        ? `上次 ${fmtTime(a.lastScheduledAt)}`
        : '未调度'
  const title = [
    `导入：${a.importedAt ? new Date(a.importedAt).toLocaleString() : '未知'}`,
    `凭证更新：${a.credentialUpdatedAt ? new Date(a.credentialUpdatedAt).toLocaleString() : '从未更新'}`,
    `累计调度：${fmtDurationMs(a.scheduledMs)}`,
    a.schedulingSince
      ? `本轮自：${new Date(a.schedulingSince).toLocaleString()}`
      : null,
  ].filter(Boolean).join('\n')
  return el('td', { class: 'mono', style: 'font-size:11px;line-height:1.5', title }, [
    el('div', {}, `导入 ${imported}`),
    el('div', { class: 'muted' }, updated ? `更新 ${updated}` : '更新 —'),
    el('div', { class: a.currentSchedulingMs > 0 ? '' : 'muted' }, `调度 ${total}`),
    el('div', { class: 'muted', style: 'font-size:10px' }, running),
  ])
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
          el('th', {}, '额度（今日 · FB/h）'),
          el('th', {}, 'agent (base2)'),
          el('th', {}, '兜底 agent (base3)'),
          el('th', {}, '来源'),
          isAdmin ? el('th', {}, '操作') : null,
        ])),
        el('tbody', {}, rows.map((m) => el('tr', {}, [
          el('td', { style: 'font-family:var(--mono);font-size:11px' }, m.id),
          el('td', {}, m.display_name || m.displayName || '—'),
          el('td', {}, el('span', { class: 'badge', class: poolBadgeClass(m.pool) }, poolLabel(m.pool))),
          el('td', {}, fmtModelPrice(m)),
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

/**
 * Freebucks 计量展示（上游 2026-09 改版）。
 *
 * **口径 = 时长**：上游按「模型单价（Freebucks/小时）× 会话实际占用时长」结算，
 * admit 时按整小时预占、提前 DELETE 按未用时长退款。所以这里不再说"今天用了几次
 * 会话"，而是直接回答「这个号还能用多久」：
 *   余额 N FB · 单价 N/h · ≈可用 M 分钟 · 今日 剩余/上限
 * 金额单位是 Freebucks，时长单位是分钟（<1 分钟显示秒）。
 */
function fmtFreebucks(fb, currentModel, lastRefund) {
  if (!fb) return el('span', { class: 'muted' }, '—')
  const price = currentModel && fb.prices ? fb.prices[currentModel] : null
  const reset = fb.daily?.resetAt ? new Date(fb.daily.resetAt) : null
  /** 余额（或今日池余额）按单价折算的可用时长。 */
  const minutes = (amount) =>
    price != null && price > 0 ? (Number(amount) / price) * 60 : null
  const balanceMin = minutes(fb.balance)
  const dailyMin = fb.daily ? minutes(fb.daily.remaining) : null
  const tip = [
    `余额 ${fmtNum(fb.balance)} Freebucks`,
    balanceMin != null ? `≈ 可用 ${fmtDuration(balanceMin)}（${currentModel} 单价 ${fmtNum(price)}/h）` : null,
    fb.daily
      ? `每日池 剩余 ${fmtNum(fb.daily.remaining)}/${fmtNum(fb.daily.limit)} Freebucks` +
        (dailyMin != null ? ` ≈ ${fmtDuration(dailyMin)}` : '') +
        `（重置 ${reset ? reset.toLocaleString() : '太平洋午夜'}）`
      : null,
    `计费方式：按实际占用时长结算（admit 预占整小时，提前 DELETE 退未用时长）`,
    fb.wallet && fb.wallet.balance ? `钱包 ${fmtNum(fb.wallet.balance)}` : null,
    fb.quotaExempt ? '服务端配额豁免' : null,
    lastRefund && lastRefund.refund != null
      ? `上次早退退款 ${fmtNum(lastRefund.refund)} Freebucks`
      : null,
  ].filter(Boolean).join('\n')
  const low = price != null && !fb.quotaExempt && Number(fb.balance) < price
  return el('div', { class: 'mono', style: 'font-size:12px', title: tip }, [
    el('span', { class: low ? 'badge err' : 'badge ok' }, `${fmtNum(fb.balance)} FB`),
    price != null ? el('span', { class: 'muted' }, ` · ${fmtNum(price)}/h`) : null,
    balanceMin != null
      ? el('span', { class: 'muted' }, ` · ≈${fmtDuration(balanceMin)}`)
      : null,
    fb.daily
      ? el('div', { class: 'muted', style: 'font-size:11px' },
          `今日剩余 ${fmtNum(fb.daily.remaining)}/${fmtNum(fb.daily.limit)} FB` +
          (dailyMin != null ? `（≈${fmtDuration(dailyMin)}）` : ''))
      : null,
  ])
}

/** 把分钟数渲染成人读时长：<1 分钟给秒，否则给「X 分」「X 小时 Y 分」。 */
function fmtDuration(minutes) {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m <= 0) return '0 分钟'
  if (m < 1) return `${Math.max(1, Math.round(m * 60))} 秒`
  if (m < 60) return `${Math.round(m)} 分钟`
  const h = Math.floor(m / 60)
  const rest = Math.round(m - h * 60)
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`
}

function fmtNum(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return String(Math.round(v * 100) / 100)
}

/**
 * 额度徽章颜色：用尽=红，余量≤2=黄，其余=绿。
 * 注意 recentCount 在按时长结算时是**小数**（admit 预占、提前释放按实际占用
 * 结算），所以这里保留小数、不用 ceil 抹平——否则 0.1 次会被显示成"已用 1 次"。
 */
function quotaBadgeClass(m) {
  const used = Math.max(0, Number(m.recentCount) || 0)
  const limit = Number(m.limit)
  if (!Number.isFinite(limit) || limit <= 0) return ''
  const left = limit - used
  return left <= 0 ? 'err' : left <= 2 ? 'warn' : 'ok'
}

/**
 * 每个模型的每日额度：已用/上限 + 重置时间。
 * **口径是「占用的时长」不是「几次」**：上游按 session 时长结算，admit 先预占
 * 1 小时、提前释放按实际占用回填，所以 recentCount 是小数（如 0.4/6 = 用了 24
 * 分钟）。这里保留小数（最多两位），不再 ceil 成整数。
 */
function fmtQuota(quota, fb) {
  const byModel = quota?.byModel || {}
  if (!Object.keys(byModel).length) {
    return el('span', { class: 'muted', title: '尚无额度数据：账号首次 admit（发起对话/创建 session）后上游才会返回；可点行内「检测」查看' }, '—')
  }
  // 计费口径（2026-09）：上游按**会话实际占用时长**结算 Freebucks，每模型单价
  // 由 freebucks.prices 给出（N FB/小时）。所以这里显示 FB，不再显示「次数」。
  // 诚实边界：上游只提供**账号级** daily.spent，没有按模型的消耗明细——
  // 因此每模型能展示的是「单价」+「今日池折算的可用时长」，不编造每模型已用量。
  const prices = fb && fb.prices ? fb.prices : null
  const poolLeft = fb && fb.daily ? Number(fb.daily.remaining) : null
  const chips = []
  for (const [model, q] of Object.entries(byModel)) {
    if (!q) continue
    const price = prices ? prices[model] : null
    const hasPrice = Number.isFinite(price)
    // 可用时长：今日池余额 ÷ 单价
    const minutes =
      hasPrice && price > 0 && Number.isFinite(poolLeft)
        ? (poolLeft / price) * 60
        : null
    // 颜色：池子见底=红；连 1 小时都买不起=黄；其余绿
    const cls = poolLeft != null && poolLeft <= 0
      ? 'err'
      : (hasPrice && Number.isFinite(poolLeft) && poolLeft < price ? 'warn' : 'ok')
    const tip = [
      model,
      hasPrice
        ? `单价 ${fmtNum(price)} FB/小时（计入今日 Freebucks 池，按实际占用时长结算）`
        : '上游未返回该模型单价（freebucks.prices 无此模型）',
      minutes != null
        ? `今日池余额 ${fmtNum(poolLeft)} FB → ≈ 可用 ${fmtDuration(minutes)}`
        : null,
      Number.isFinite(q.limit)
        ? `上游另有请求额度 ${fmtNum(q.recentCount)}/${q.limit}（${q.poolLabel || 'Daily'}）`
        : null,
      q.resetAt ? `重置 ${fmtReset(q.resetAt, q.resetTimeZone)} · ${fmtCountdown(q.resetAt)}` : null,
    ].filter(Boolean).join('\n')
    const label = hasPrice
      ? (price > 0 ? `${fmtNum(price)} FB/h` : '免费')
      : '—'
    // 池空时不要再输出「≈0 分钟」这种噪音；直接说明池子已空更清楚。
    const exhausted = poolLeft != null && poolLeft <= 0 && hasPrice && price > 0
    chips.push(el('span', {
      class: `badge ${cls}`,
      style: 'margin:2px 4px 2px 0',
      title: tip,
    }, [
      el('span', { class: 'muted' }, `${shortModel(model)} `),
      label,
      exhausted
        ? el('span', { class: 'muted' }, ' · 池空')
        : (minutes != null && minutes >= 1
            ? el('span', { class: 'muted' }, ` · ≈${fmtDuration(minutes)}`)
            : null),
    ]))
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

/**
 * 模型管理表的「额度」列：显示 **Freebucks 单价**（FB/小时），不再显示次数。
 * 上游按会话实际占用时长结算，单价才是决定"这个模型多贵"的量；旧的
 * `已用/上限` 次数口径已不再对应用户实际关心的消耗。限额仍保留在悬停提示里。
 */
function fmtModelPrice(m) {
  const price = m.freebucksPerHour
  const hasPrice = Number.isFinite(price)
  const tip = [
    m.id,
    hasPrice ? `单价 ${fmtNum(price)} FB/小时（按会话实际占用时长结算）` : '上游未返回该模型单价',
    m.limit != null ? `上游请求额度 ${fmtNum(m.recentCount)}/${m.limit}（${poolLabel(m.pool)}）` : null,
    m.resetAt ? `重置 ${fmtReset(m.resetAt, m.resetTimeZone)} · ${fmtCountdown(m.resetAt)}` : null,
  ].filter(Boolean).join('\n')
  if (!hasPrice) {
    return m.limit != null
      ? el('span', { class: 'badge ' + quotaBadgeClass(m), title: tip }, '—')
      : el('span', { class: 'muted', title: tip }, '—')
  }
  const cls = price <= 0 ? 'ok' : (price >= 50 ? 'err' : price >= 25 ? 'warn' : 'ok')
  return el('span', { class: `badge ${cls}`, title: tip },
    price > 0 ? `${fmtNum(price)} FB/h` : '免费')
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

/**
 * 主动关闭某账号的上游会话（操作列「✕」）：用户明确要结束这条会话。
 * 上游按会话占用时长结算，早退 DELETE 就是"停止计费"；有回复在传输时后端
 * 会先有界等待它结束（不硬掐断），超时仍在途则如实提示"已中断在途回复"。
 */
async function closeAccountSession(a, btn) {
  const label = a.session?.model ? `会话（${shortModel(a.session.model)}）` : '会话'
  const tip = `确认关闭 ${a.email} 的${label}？\n\n会立即向上游发起早退 DELETE 停止计费；\n若此刻有回复正在传输，会先等它结束（最多 10 秒），超时才中断。`
  if (!confirm(tip)) return
  const restore = withButtonLoading(btn)
  try {
    const r = await api(`/api/accounts/${encodeURIComponent(a.key)}/session`, {
      method: 'POST',
      body: JSON.stringify({ waitInFlightMs: 10000 }),
    })
    if (r.ok) {
      const extra = r.refund != null ? `，退款 ${fmtNum(r.refund)} FB` : ''
      const cut = r.interrupted ? '（在途回复被中断）' : ''
      toast(`✅ 已关闭 ${a.email} 的会话${extra}${cut}`)
    } else {
      toast(`⚠️ 会话未关闭成功：${r.error || '上游拒绝'}（句柄已记录，服务重启时会自动重试退款）`, true)
    }
    refreshAccountsCard()
  } catch (err) {
    toast(err.message, true)
  } finally {
    restore()
  }
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

/**
 * 用户表定点刷新：只更新表格与「新建用户」卡片，标题和页面骨架保持不动。
 * 早先「局部刷新」直接调 renderUsers(view)（先 view.innerHTML = '' 再重建），
 * 那不是刷新而是"重建整页"，用户观感就是"又多出一条栏目"。
 */
async function refreshUsersTable(view) {
  const oldTable = $('#users-table')
  if (!oldTable) return renderUsers(view)
  // 渲染进**游离容器**再取出新表替换旧表：标题、表单、滚动位置都不动，
  // 也绝不会有旧节点残留（游离容器里的东西不参与文档渲染）。
  const holder = document.createElement('div')
  await renderUsers(holder)
  const fresh = holder.querySelector('#users-table')
  if (fresh) oldTable.replaceWith(fresh)
}

async function renderUsers(view) {
  view.innerHTML = ''
  view.append(el('div', { class: 'row spread', style: 'margin-bottom:16px' }, [
    el('h2', { style: 'margin:0' }, '用户管理'),
    // 局部刷新必须是"原地更新"：早先直接 renderUsers(view) 会把 view 整个清空重渲染，
    // 用户看到的是"又新出一条栏目"（而它并不是真的刷新）。
    el('button', { class: 'muted', onclick: () => refreshUsersTable(view) }, [icon('refresh', 13), '局部刷新']),
  ]))
  state.users = (await api('/api/users')).data

  const table = el('div', { class: 'table-wrap', id: 'users-table' }, [
    el('table', {}, [
      el('thead', {}, el('tr', {}, ['用户名', '角色', 'API Key', '操作'].map((t) => el('th', {}, t)))),
      el('tbody', {}, state.users.map((u, i) => {
        return el('tr', { class: 'row-in', style: `animation-delay:${i * 40}ms` }, [
          el('td', {}, [
            u.username,
            u.username === state.me.username ? el('span', { class: 'muted', style: 'margin-left:4px' }, '(我)') : null,
          ]),
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

  const form = el('div', { class: 'card', id: 'users-new-card' }, [
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
