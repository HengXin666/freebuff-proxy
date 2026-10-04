/* Freebuff Proxy 控制台 — 零依赖原生 JS SPA
 * 现代 UI：SVG 图标、局部刷新（不整页重建）、骨架屏/进度条加载态、
 * 每账号「检测」按钮（单账号只读探测）、动画与响应式。
 * 功能与后端 API 保持不变。
 */
'use strict'

import {
  t, getLocale, setLocale, initLocale, DEFAULT_LOCALE, LOCALES, LOCALE_LABELS,
} from './i18n.js'

const state = {
  me: null,
  accounts: [],
  users: [],
  models: [],
  flows: [],
  proxies: [],
  version: null,
  lowBalanceThreshold: 15,
  /**
   * 分区展开/折叠记忆（分区 id → 是否展开）。
   * 局部刷新**不能**重置它：用户手动摊开"额度不足"看细节，一次刷新就折回去
   * 等于把界面状态当垃圾扔掉（用户明确要求"不要重置当前分组展开和折叠的状态"）。
   * 记录在内存里而不是读 DOM：分区可能因为这一轮没有任何账号而暂时消失，
   * 消失期间也要记住用户的偏好，等账号回来时按原样展开。
   */
  acctSectionsOpen: {},
  /** 上游此刻真实给出额度的模型 id（多账号并集），测试对话据此标注。 */
  upstreamModelIds: [],
  /**
   * 目录 key（m-00032eaeec）→ 可读显示名（MiMo 2.6 Flash）。
   *
   * 账号表的 session 列与「额度」chip 的数据源都是**上游回执**，键全是不透明
   * 目录 key；后端把这一屏用到的映射随 /api/overview 一起下发，前端只管查表。
   * 查不到就回落原 key —— 绝不因为取不到名字让整行渲染失败。
   */
  modelNames: {},
  /**
   * 上游此刻给了额度的模型的「可读三件套」：`{key, displayName, catalogId}`。
   * /api/models 的 id 是**可读名**（口径 = `displayName || key`，与后端
   * `catalogDisplayName()` 同源），而 upstreamModelIds 是目录 key ——
   * 标注 ✅ 时必须用这张表换算，否则永远对不上。
   */
  upstreamModels: [],
}

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
        // 文案必须留在 console.warn 所在行：红线只豁免 console.* 那一行
        console.warn('[dashboard] HTML 片段里有未自闭合的 SVG 形状标签，可能吞掉相邻节点；请改用 icon() 或补上" /"', c)
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
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
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
    throw new Error(body?.error || t('login.notSignedIn'))
  }
  if (!res.ok) {
    /**
     * ⚠️ 除 message 外，把后端给的**结构化判据**挂在 error 上：
     *   `code`（稳定业务码，如 upstream_timeout / upstream_network）
     *   `cause`（底层原始码，如 ECONNREFUSED / ENOTFOUND）
     *
     * 以前只传 `body.error` 字符串，前端想区分故障类型只能解析中文文案，
     * 文案一改就崩。现在调用方可以按 err.code 做不同提示。
     */
    const err = new Error(body?.error || `HTTP ${res.status}`)
    err.code = body?.code ?? null
    err.cause = body?.cause ?? null
    err.status = res.status
    throw err
  }
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

/** 复制文本到剪贴板（navigator.clipboard 不可用时回落 execCommand）。 */
function copyText(text) {
  const done = () => toast(t('common.copied'))
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
    return
  }
  fallbackCopy(text, done)
}

function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    done()
  } catch {
    toast(t('toast.copyFailSelect'), true)
  }
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
async function render(opts = {}) {
  const app = $('#app')
  if (!state.me) {
    app.innerHTML = ''
    app.append(renderLogin())
    return
  }
  const route = (location.hash || '#overview').slice(1) || 'overview'
  // 骨架已存在且登录态没变 → 只更新内容区（标准 SPA 行为）
  //
  // ⚠️ force=true（切换语言时用）：**连 header / nav 一起重建**。
  // 否则顶栏与导航会保留切换前的语言（它们不在这次重渲染范围内），
  // 表现就是"内容变了、顶栏没变"，用户只能手动刷新页面。
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
  // 语言切换：改语种后**整页重渲染**（文案散布在各处，逐个区块刷新容易漏）。
  // 只重画 DOM，不重新拉数据 —— 不打断在途请求、不释放已购会话。
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

/** 版本号徽章 + GitHub 仓库链接（版本号由发版流水线硬编码进 version.json） */
/**
 * 顶栏语言切换器：**下拉菜单**（select），显式限宽以免撑开顶栏。
 *
 * ⚠️ 为什么必须限宽：原生 select 未显式设 width 时会按**最长 option** 撑开
 * （"简体中文" 远比 "EN" 宽），实测能把顶栏顶出一条 780px 的宽条 ——
 * 与相邻 56px 的按钮完全不协调（用户反馈过"选项栏变得非常宽"）。
 * 这里用 `.locale-select { width: 72px }` 钉死。
 *
 * 切换后 `render({ force: true })` **连 header/nav 一起重建**：只更新内容区的话
 * 顶栏与导航会留着切换前的语言（表现为"内容变了、顶栏没变"，只能手动刷新）。
 * 重渲染只重画 DOM、不重新拉数据 —— 不打断在途请求、不释放已买断的会话。
 * @returns {HTMLElement}
 */
function buildLocaleSwitcher() {
  const cur = getLocale()
  return el('select', {
    class: 'locale-select',
    title: t('nav.language'),
    'aria-label': t('nav.language'),
    onchange: (e) => {
      setLocale(e.target.value)
      // 同步 <html lang>：屏幕阅读器与浏览器拼写检查据此选语言
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
    const failed = (r.accounts || []).filter((x) => !x.ok)
    toast(failed.length ? t('system.reconnectPartial', { n: failed.length }) : t('system.reconnectDone'))
    refreshOverviewAfterAccountChange()
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
    // 数据文件自检是排障工具，不是日常操作——从总览页搬出来，admin 专属独立页。
    items.push(['system', t('nav.system'), 'cpu'])
    // 日志页：上游故障判据（如 countryBlockReason）只写进 stdout，用户以往
    // 只能看到一串 503 却不知为何。这里让完整字段在页面上可读、可筛选、可展开。
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
    // 低额度分组阈值必须先于账号表拿到：账号表在 renderProxySettings 之前渲染，
    // 而阈值是在那里才读 /api/settings 的。若不在这里先取一次，首屏会**恒定**
    // 用默认 15 分组（用户改过阈值却看不到效果）——与推荐值那次是同一类数据依赖坑。
    try {
      const s = await api('/api/settings')
      if (Number.isInteger(s.lowBalanceThreshold)) {
        state.lowBalanceThreshold = s.lowBalanceThreshold
      }
    } catch { /* 拿不到就用默认 15，不阻塞总览 */ }
    const data = await api('/api/overview')
    state.accounts = data.accounts
    applyModelNames(data)
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

/* ================================================================
   SYSTEM — 数据文件自检（admin 独立页）
   （为什么独立成页、而不是留在总览或折叠：见
   .agents/notes/implemented/feature/2026-09-13-console-system-tab.md）
   总览页只放日常要看的（账号 / 额度 / 代理 / 模型）；"出问题了才来看"的
   数据文件状态搬到这一页。起因仍是真实故障：镜像升级后服务起不来，日志里
   只有一行 warn，用户只能靠"删掉几个 json 就好了"试错——这里把 data/ 下
   每个 JSON 的装载状态摊开显示，损坏的给出**可直接照做**的处置命令，并把
   "哪些是派生数据（删了自动重建）、哪些是真源（删了就丢用户/丢会话句柄）"
   讲清楚。
   ================================================================ */
/* ================================================================
   LOGS — 进程内日志缓冲（admin 独立页）
   起因是真实排障代价：上游把故障判据（countryBlockReason / banned /
   rate_limited …）只写进 stdout，用户在容器里看不到，也不该被要求 docker
   logs —— 于是前端只显示一串 503，用户只能猜。这里把缓冲里的**完整字段**
   摊开：可按级别过滤、可按关键词搜、可展开整条 JSON、可复制。
   ================================================================ */

/** 日志页的视图状态（切走再回来保持筛选条件）。 */
const logsView = {
  level: 'all',
  q: '',
  account: '',
  auto: false,
  expanded: new Set(),
  timer: null,
  lines: [],
}

function logsLevelTone(level) {
  if (level === 'error') return 'err'
  if (level === 'warn') return 'warn'
  return ''
}

/**
 * 时间戳 → 人读的本地时间（`MM-DD HH:mm:ss`）。
 *
 * 原样吐 ISO 串（`2026-10-03T18:52:20.220Z`）有两个毛病：它是 UTC，与用户
 * 本地墙钟差 8 小时；且一屏几十条里 T/Z 分隔符和毫秒全是噪音，扫读不出
 * "刚刚发生了什么"。保留完整 ISO 在 title 里，鼠标悬停仍可看精确值。
 */
function logsTs(iso) {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return String(iso)
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 一条日志：默认只给 ts/level/msg，点开才给完整字段（避免一眼全是噪音）。 */
function buildLogRow(line, idx) {
  const key = (line.ts || '') + '|' + idx
  const open = logsView.expanded.has(key)
  const ts = logsTs(line.ts)
  const extra = { ...line }
  delete extra.ts
  delete extra.level
  delete extra.msg
  const hasExtra = Object.keys(extra).length > 0

  const row = el('div', { class: 'log-row' + (open ? ' open' : '') }, [
    el('button', {
      class: 'log-head',
      onclick: () => {
        if (open) logsView.expanded.delete(key)
        else logsView.expanded.add(key)
        renderLogsList()
      },
    }, [
      el('span', { class: 'log-ts' }, ts),
      el('span', { class: 'badge ' + logsLevelTone(line.level) }, line.level),
      // ⚠️ 账号 + 请求 id：此前日志里没有这两个维度，多账号池并发时几十条
      // 无主记录交织，排障只能靠猜。reqId 同时是聚合键（可用它筛选整条链路）。
      //
      // 账号**显示完整邮箱**：此前写成 `split('@')[0]`（只留本地部分），
      // 于是 `a@gmail.com` 与 `a@outlook.com` 在日志页上长得一模一样 ——
      // 多账号池里这直接把"哪个号出的问题"变成了猜谜。用户要的就是邮箱。
      line.account
        ? el('span', {
            class: 'badge',
            style: 'font-size:11px',
            title: t('logs.accountHint'),
            onclick: (e) => {
              e.stopPropagation()
              logsView.account = String(line.account)
              const sel = document.querySelector('#logs-account')
              if (sel) sel.value = logsView.account
              refreshLogs()
            },
          }, String(line.account))
        : null,
      line.reqId
        ? el('span', {
            class: 'badge muted',
            style: 'font-size:11px',
            title: t('logs.reqIdHint'),
            onclick: (e) => {
              e.stopPropagation()
              logsView.q = line.reqId
              const input = document.querySelector('#logs-search')
              if (input) input.value = line.reqId
              refreshLogs()
            },
          }, '#' + line.reqId)
        : null,
      el('span', { class: 'log-msg' }, line.msg || ''),
      hasExtra ? el('span', { class: 'muted', style: 'font-size:11px' }, open ? '▾' : '▸') : null,
    ].filter(Boolean)),
    open && hasExtra
      ? el('div', { class: 'log-body' }, [
          el('div', { class: 'row', style: 'justify-content:flex-end;margin-bottom:6px' }, [
            el('button', {
              class: 'muted',
              style: 'font-size:11px',
              onclick: (e) => {
                e.stopPropagation()
                copyText(JSON.stringify(line, null, 2))
              },
            }, [icon('copy', 11), t('logs.copyJson')]),
          ]),
          el('pre', { class: 'log-pre' }, JSON.stringify(extra, null, 2)),
        ])
      : null,
  ].filter(Boolean))
  return row
}

function renderLogsList() {
  const host = document.querySelector('#logs-list')
  if (!host) return
  const lines = logsView.lines
  if (!lines.length) {
    host.innerHTML = ''
    host.append(el('div', { class: 'muted', style: 'padding:14px' },
      t('logs.empty')))
    return
  }
  host.innerHTML = ''
  // 新的在前：排障时关心的是刚刚发生了什么
  for (let i = lines.length - 1; i >= 0; i--) {
    host.append(buildLogRow(lines[i], i))
  }
}

async function refreshLogs() {
  const q = new URLSearchParams({ level: logsView.level, limit: '300' })
  if (logsView.q.trim()) q.set('q', logsView.q.trim())
  // 账号维度：后端已支持 `account=` 过滤（src/util/log.js readLogBuffer），
  // 此前前端从未传过 —— 多账号池下"只看某个号"只能靠在搜索框里手打邮箱。
  if (logsView.account) q.set('account', logsView.account)
  let data = null
  try { data = await api('/api/logs?' + q.toString()) } catch { return }
  logsView.lines = data?.lines || []
  renderLogsList()
  const meta = document.querySelector('#logs-meta')
  if (meta) {
    meta.textContent = t('logs.meta', {
      n: logsView.lines.length,
      time: logsTs(data?.serverTime),
    })
  }
}

function stopLogsAuto() {
  if (logsView.timer) {
    clearInterval(logsView.timer)
    logsView.timer = null
  }
}

async function renderLogs(view) {
  view.innerHTML = ''
  view.append(el('h2', { style: 'margin:0 0 12px' }, t('nav.logs')))

  const card = el('div', { class: 'card' })
  card.append(el('div', { class: 'row spread' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('logs.inProcessTitle')),
      el('span', { class: 'muted', id: 'logs-meta' }, t('common.loading')),
    ]),
    el('div', { class: 'row' }, [
      el('button', {
        class: logsView.auto ? '' : 'muted',
        id: 'logs-auto-btn',
        onclick: () => {
          logsView.auto = !logsView.auto
          const btn = document.querySelector('#logs-auto-btn')
          if (btn) {
            btn.className = logsView.auto ? '' : 'muted'
            btn.textContent = logsView.auto ? t('logs.stopAuto') : t('logs.auto')
          }
          if (logsView.auto) {
            stopLogsAuto()
            logsView.timer = setInterval(() => refreshLogs(), 3000)
          } else {
            stopLogsAuto()
          }
        },
      }, [icon('refresh', 13), logsView.auto ? t('logs.stopAuto') : t('logs.auto')]),
      el('button', { class: 'muted', onclick: () => refreshLogs() }, [icon('refresh', 13), t('common.refresh')]),
      /**
       * 清空缓冲：环形缓冲会**自动丢最旧的**，但用户想"从现在起只看新的"时
       * 旧条目仍占满整页（一次故障刷出几百条后新日志被挤到最底下）。
       * 没有这个按钮就只能重启进程，而重启会连带丢掉热会话现场。
       * 只清内存里的日志缓冲，不动任何落盘数据。
       */
      el('button', {
        class: 'danger',
        id: 'logs-clear-btn',
        onclick: async () => {
          if (!confirm(t('logs.clearConfirm'))) return
          try {
            await api('/api/logs', { method: 'DELETE' })
            logsView.lines = []
            logsView.expanded.clear()
            renderLogsList()
            toast(t('logs.cleared'))
          } catch (err) {
            toast(err.message, true)
          }
        },
      }, [icon('trash', 13), t('logs.clear')]),
    ]),
  ]))

  // 筛选条：级别 + 关键词（关键词直接命中完整 JSON，含上游原始字段）
  const levelSel = el('select', {
    id: 'logs-level',
    onchange: (e) => { logsView.level = e.target.value; refreshLogs() },
  }, [
    ['all', t('logs.levelAll')],
    ['info', t('logs.levelInfo')],
    ['warn', t('logs.levelWarn')],
    ['error', t('logs.levelError')],
  ].map(([v, label]) => el('option', { value: v, selected: logsView.level === v ? 'selected' : null }, label)))

  /**
   * 账号筛选下拉：选项直接取账号池的**邮箱**。
   *
   * 为什么不是"填关键词"：日志里的 `account` 字段就是邮箱，但用户得先知道
   * 拼法才能搜；而账号池是他自己导入的，下拉里点一下即可。
   * 还额外并入**缓冲里出现过**的账号 —— 有些日志来自已删除/尚未刷进
   * `state.accounts` 的号，只按账号池建选项会漏掉它们。
   */
  const accountOptions = [['', t('logs.accountAll')]]
  const seen = new Set()
  for (const a of state.accounts || []) {
    const email = String(a?.email || '').trim()
    if (email && !seen.has(email)) {
      seen.add(email)
      accountOptions.push([email, email])
    }
  }
  for (const line of logsView.lines) {
    const email = String(line?.account || '').trim()
    if (email && !seen.has(email)) {
      seen.add(email)
      accountOptions.push([email, email])
    }
  }
  const accountSel = el('select', {
    id: 'logs-account',
    onchange: (e) => { logsView.account = e.target.value; refreshLogs() },
  }, accountOptions.map(([v, label]) =>
    el('option', { value: v, selected: logsView.account === v ? 'selected' : null }, label)))

  const searchInput = el('input', {
    id: 'logs-q',
    placeholder: t('logs.searchPlaceholder'),
    value: logsView.q,
    oninput: (e) => { logsView.q = e.target.value },
    onkeydown: (e) => { if (e.key === 'Enter') refreshLogs() },
  })

  card.append(el('div', { class: 'row', style: 'margin-top:10px;gap:8px;flex-wrap:wrap' }, [
    levelSel,
    accountSel,
    searchInput,
    el('button', { onclick: () => refreshLogs() }, [icon('search', 13), t('common.search')]),
    el('button', {
      class: 'muted',
      onclick: () => {
        logsView.q = ''
        logsView.level = 'all'
        logsView.account = ''
        logsView.expanded.clear()
        const inp = document.querySelector('#logs-q')
        if (inp) inp.value = ''
        const sel = document.querySelector('#logs-level')
        if (sel) sel.value = 'all'
        const asel = document.querySelector('#logs-account')
        if (asel) asel.value = ''
        refreshLogs()
      },
    }, t('logs.clearFilters')),
  ]))

  card.append(el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
    t('logs.expandHint')))

  card.append(el('div', { id: 'logs-list', class: 'logs-list' }))
  view.append(card)
  await refreshLogs()
}

async function renderSystem(view) {
  view.innerHTML = ''
  view.append(el('h2', { style: 'margin:0 0 12px' }, t('nav.system')))
  await renderDataFilesCard(view)
}

async function renderDataFilesCard(view) {
  let data = null
  try { data = await api('/api/system/data-status') } catch { return }
  const files = data?.files || []
  if (!files.length) return
  const invalid = files.filter((f) => f.status === 'invalid')
  const dirty = files.filter((f) => (f.droppedEntries || 0) > 0)
  const pending = files.reduce((n, f) => n + (f.openHandles || 0), 0)
  const summary = [
    invalid.length ? t('system.filesBroken', { n: invalid.length }) : null,
    dirty.length ? t('system.filesDirty', { n: dirty.length }) : null,
    pending ? t('system.filesPending', { n: pending }) : null,
  ].filter(Boolean).join(' · ') || t('common.ok')
  const card = el('div', { id: 'data-files-card', class: 'card' })
  card.append(el('div', { class: 'row spread' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('system.dataSelfCheck')),
      el('span', { class: 'muted' }, t('system.dataDirSummary', { dir: data.dir, n: files.length, summary })),
    ]),
    el('button', { class: 'muted', onclick: () => refreshDataFilesCard() }, [icon('refresh', 13), t('common.refresh')]),
  ]))
  if (invalid.length) {
    card.append(el('div', { class: 'muted', style: 'margin-top:8px;color:var(--red)' },
      t('system.invalidHint')))
  }
  if (dirty.length) {
    card.append(el('div', { class: 'muted', style: 'margin-top:8px;color:var(--yellow,#e0a800)' },
      t('system.dirtyHint')))
  }
  const rows = files.map((f) => {
    const dirtyCount = f.droppedEntries || 0
    const pending = f.openHandles || 0
    const badge = f.status === 'invalid'
      ? el('span', { class: 'badge err' }, t('system.statusBroken'))
      : f.status === 'missing'
        ? el('span', { class: 'badge' }, t('system.statusMissing'))
        : dirtyCount
          ? el('span', { class: 'badge err' }, t('system.statusDirtyCount', { n: dirtyCount }))
          : pending
            ? el('span', { class: 'badge' }, t('system.statusPendingCount', { n: pending }))
            : el('span', { class: 'badge ok' }, t('common.ok'))
    const desc = f.status === 'invalid'
      ? f.reason
      : dirtyCount
        ? `${f.droppedReason || t('system.descDirty')}${f.droppedBackup ? t('system.descBackup', { name: f.droppedBackup.split('/').pop() }) : ''}`
        : pending
          ? t('system.descPendingHandles', { n: pending })
          : f.reason || (f.status === 'missing' ? t('system.descAutoCreate') : t('common.none'))
    return el('tr', {}, [
      el('td', { class: 'mono', style: 'font-size:12px' }, f.name + (f.critical ? ' ⚠' : '')),
      el('td', {}, badge),
      el('td', { class: 'muted', style: 'font-size:12px' }, desc),
      el('td', {}, f.status === 'invalid'
        // 真源文件（users.json / sessions.json）不能照抄 mv：sessions.json 里
        // 可能还挂着没结算的会话句柄，删掉就永久失去寻址能力（槽位一直占着）。
        ? (f.critical
            ? el('span', { class: 'muted' }, t('system.actionBackupThenMove'))
            : codeCopyButton(`mv ${f.file} ${f.file}.broken`))
        : el('span', { class: 'muted' }, dirtyCount ? t('system.actionNoneNeeded') : t('common.none'))),
    ])
  })
  card.append(el('div', { class: 'table-wrap', style: 'margin-top:10px' }, [
    el('table', { style: 'font-size:12px' }, [
      el('thead', {}, el('tr', {}, [t('system.colFile'), t('common.status'), t('system.colDesc'), t('system.colAction')].map((h) => el('th', {}, h)))),
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
      class: 'icon', title: t('system.copyCommand'),
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(cmd)
          toast(t('toast.commandCopied'))
        } catch {
          toast(t('toast.copyFailSelectShort'), true)
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
      el('h2', { style: 'margin:0 0 4px' }, t('overview.poolTitle', { n: data.accountCount })),
      el('span', { class: 'muted' }, t('overview.poolSubtitle', {
        apiBase: data.upstream.apiBase,
        models: data.models,
        dataDir: data.dataDir,
      })),
    ]),
    el('div', { class: 'row' }, [
      // 主操作 = 一键刷新：额度 + 账号状态 + 上游模型目录，一次全刷（只读）。
      el('button', { class: 'primary', onclick: (e) => oneClickRefresh(e.currentTarget) },
        [icon('refresh', 14), t('overview.oneClickRefresh')]),
      el('button', { onclick: (e) => probeAllAccounts(e.currentTarget), title: t('overview.probeOnlyTip') },
        [icon('activity', 14), t('overview.probeRefresh')]),
      state.me.role === 'admin'
        ? el('div', { class: 'row' }, [
            el('button', { onclick: () => openImportModal() }, [icon('box', 14), t('account.import')]),
            el('button', { class: 'primary', onclick: () => openAddAccount() }, [icon('plus', 14), t('overview.addAccount')]),
          ])
        : null,
    ]),
  ])
}

/** 统计卡片 */
function renderStatCards(data) {
  const total = data.accounts.length
  // 可用 = 无账号级冷却 **且** 未封禁。以前只看 available，会把已封禁的号
  // 算进"可用账号"里（banned 冷却 24h 到期后 available 又会变回 true）。
  const banned = data.accounts.filter((a) => a.banned === true || a.bannedAt).length
  const available = data.accounts.filter((a) => a.available && !(a.banned === true || a.bannedAt)).length
  const cooldown = data.accounts.filter((a) => a.cooldownUntil && !a.banned).length
  const inFlight = data.accounts.reduce((n, a) => n + (a.inFlight || 0), 0)
  // 全局闸门占用：inFlight 贴着 limit 不动就是槽位泄漏（服务会"看着在跑
  // 却不接单"）。排队数 >0 说明已经在限流。
  const slots = data.slots || null
  const gateValue = slots ? `${slots.inFlight}/${slots.limit}` : String(inFlight)
  const gateFull = slots ? slots.inFlight >= slots.limit : false
  // 会话复用率 = "我们在省钱"的全局证据：一次 admit 就买断一小时，所以每次
  // 复用都是**零边际成本**的。复用率 = 复用次数 /（复用 + 新买）。
  const admits = data.accounts.reduce((n, a) => n + (Number(a.admitCount) || 0), 0)
  const reuses = data.accounts.reduce((n, a) => n + (Number(a.reuseCount) || 0), 0)
  const reusePct =
    admits + reuses > 0 ? Math.round((reuses / (admits + reuses)) * 100) : null
  const cards = [
    { label: t('overview.statTotal'), value: total, cls: '' },
    { label: t('overview.statAvailable'), value: available, cls: 'green' },
    { label: t('overview.statBanned'), value: banned, cls: banned ? 'red' : 'green',
      tip: t('overview.statBannedTip') },
    { label: t('overview.statCooling'), value: cooldown, cls: cooldown ? 'yellow' : 'green',
      tip: t('overview.statCoolingTip') },
    {
      label: slots && slots.queued ? t('overview.statInFlightQueued', { n: slots.queued }) : t('overview.statInFlight'),
      value: gateValue,
      cls: gateFull ? 'red' : '',
    },
    {
      // 复用率越高 = 越少重复买整小时。hover 给出原始次数，便于核对。
      label: t('overview.statReuseRate'),
      value: reusePct != null ? `${reusePct}%` : t('common.none'),
      cls: reusePct != null && reusePct > 0 ? 'green' : '',
      tip:
        reusePct != null
          ? t('overview.statReuseTip', { admits, reuses })
          : t('overview.statReuseEmpty'),
    },
  ]
  return el('div', { class: 'stat-grid' }, cards.map((c, i) =>
    el('div', { class: 'stat', style: `animation-delay:${i * 60}ms`, ...(c.tip ? { title: c.tip } : {}) }, [
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
      el('p', { style: 'margin:0 0 10px' }, t('account.emptyNoFreebuff')),
      state.me.role === 'admin'
        ? el('button', { class: 'primary', onclick: () => openAddAccount() }, [icon('plus', 14), t('overview.addFirstAccount')])
        : el('p', { class: 'muted' }, t('overview.askAdminForAccount')),
    )
    return card
  }

  // 负载均衡概览
  const totalReq = data.accounts.reduce((n, a) => n + (a.requests || 0), 0)
  const head = el('div', { class: 'row spread' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('overview.accountPool')),
      el('span', { class: 'muted' }, totalReq > 0
        ? t('overview.loadBalance', { n: totalReq })
        : t('overview.noRequestsYet')),
    ]),
    el('div', { class: 'row', style: 'gap:6px' }, [
      el('button', { class: 'primary', onclick: (e) => oneClickRefresh(e.currentTarget) },
        [icon('refresh', 13), t('overview.oneClickRefresh')]),
      el('button', { class: 'muted', onclick: (e) => probeAllAccounts(e.currentTarget), title: t('overview.probeReadOnlyTip') },
        [icon('activity', 13), t('overview.probeRefresh')]),
      el('button', { class: 'muted', onclick: () => refreshAccountsCard({ silent: false }) }, [icon('refresh', 13), t('common.refresh')]),
    ]),
  ])
  card.append(head)

  if (totalReq > 0) {
    const bar = el('div', { class: 'balance-bar', id: 'balance-bar' })
    for (const a of data.accounts) {
      if (!a.requests) continue
      const pct = Math.round((a.requests / totalReq) * 100)
      bar.append(el('div', {
        style: `flex:${pct};background:${colorFor(a.email)}`,
        title: t('overview.shareBarTip', { email: a.email, pct, req: a.requests, total: totalReq }),
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
 *
 * label/hint 用 getter 而不是求值好的字面量：这个常量在模块加载时就定型，
 * 若此刻取文案，切换语言后分区标题会一直停在旧语种（要刷新页面才变）。
 */
const ACCOUNT_SECTIONS = [
  { id: 'banned', tone: 'err',
    get label() { return t('account.section.banned.label') },
    get hint() { return t('account.section.banned.hint') } },
  { id: 'exhausted', tone: 'err',
    get label() { return t('account.section.exhausted.label') },
    get hint() { return t('account.section.exhausted.hint') } },
  { id: 'warning', tone: 'warn',
    get label() { return t('account.section.warning.label') },
    get hint() { return t('account.section.warning.hint') } },
  { id: 'lowbalance', tone: 'warn',
    get label() { return t('account.section.lowbalance.label') },
    get hint() { return t('account.section.lowbalance.hint') } },
  { id: 'active', tone: 'ok', open: true,
    get label() { return t('account.section.active.label') },
    get hint() { return t('account.section.active.hint') } },
  { id: 'fresh', tone: 'idle',
    get label() { return t('account.section.fresh.label') },
    get hint() { return t('account.section.fresh.hint') } },
]

/**
 * 「低额度」判定：余额低于阈值（可调，默认 15 FB），但**还买得起当前模型**。
 * 阈值来源：/api/settings 的 lowBalanceThreshold（0 = 关闭该分组）。
 * 用户要这个分组的原因是「一眼看到快跑完的号」——所以它**不影响调度**，
 * 归到这里的号照常参与选号（这点和「额度不足」完全不同）。
 */
function lowBalanceHit(a) {
  const th = state.lowBalanceThreshold ?? 15
  if (!(th > 0)) return false
  const fb = a.freebucks
  if (!fb || fb.quotaExempt) return false
  // 今日池跑完 = 真的不能用 → 归 exhausted，不算「低额度」
  if (fb.daily && Number(fb.daily.remaining) <= 0 && Number(fb.daily.limit) > 0) return false
  const bal = Number(fb.balance)
  if (!Number.isFinite(bal)) return false
  // 买不起当前模型的不算（那是 exhausted）
  const price = fb.prices && a.session?.model ? fb.prices[a.session.model] : null
  if (price != null && bal < Number(price)) return false
  // 「低于它无法使用就不纳入本组」：连**最便宜的模型**都买不起 = 实质不可用，
  // 归 exhausted。否则余额 0 的号会被标成「低额度」，看着像还能救。
  const prices = fb.prices ? Object.values(fb.prices).map(Number).filter((n) => Number.isFinite(n) && n > 0) : []
  if (prices.length && bal < Math.min(...prices)) return false
  if (bal <= 0) return false
  return bal < th
}

/** 把一个账号归类到唯一分区（最坏优先）。 */
function classifyAccount(a) {
  const probe = a.lastProbe && a.lastProbe.ok === false ? a.lastProbe : null
  const code = String(probe?.code || a.cooldownCode || '').toLowerCase()
  // 1) 封禁：探测明确 banned、账本记过 bannedAt、或后端已判 banned。
  //    注意 CDN 兜底：country_blocked 是出口风控，不是账号封禁，刻意不归这里。
  if (a.banned === true || a.bannedAt || code.includes('banned')) return 'banned'
  // 2) 额度不足：**与后端的两道闸门严格对齐**——
  //    ① Freebucks：今日池跑完（daily.remaining <= 0，且 limit > 0 才算真有池子）
  //       或余额买不起当前模型（balance < 单价）；
  //    ② session_units：该模型时长额度用尽（recentCount >= limit，**小数**）。
  //    前端先于后端修好过这条，而当时后端只判 ②，于是出现"控制台显示已用尽、
  //    调度器却仍把请求送上去"的错位；两处必须保持一致。
  //    ⚠️ 两本账是**并行**的两道闸门（一笔会话两本账都扣，一手实测见
  //    docs/evidence/ledger-session-units-vs-freebucks.json），所以任一用尽都要归到这里。
  //    ⚠️ **付费时段内不算「额度不足」**：一次 admit 买断一小时，池子当场扣到 0
  //    之后这个小时仍然完全可用（rem=0 是"已付款"的正常状态，不是"用不了"）。
  //    少这一条会把正在被正常使用的账号标成「额度不足」，并把它从"正在调度"里挤出去。
  const inPaidWindow =
    a.session?.live === true &&
    !!a.session?.expiresAt &&
    Date.parse(a.session.expiresAt) > Date.now()
  const fb = a.freebucks
  if (fb && !inPaidWindow) {
    const price = fb.prices && a.session?.model ? fb.prices[a.session.model] : null
    const short =
      price != null && !fb.quotaExempt && Number(fb.balance) < Number(price)
    const dailyGone =
      fb.daily && Number(fb.daily.remaining) <= 0 && Number(fb.daily.limit) > 0
    if (short || dailyGone) return 'exhausted'
  }
  // ② session_units 用尽（时长闸门）：与后端 sessionUnitsFor 对齐，
  //    ⚠️ recentCount 是小数，边界必须用 >=。
  const uRow = a.quota && a.quota.byModel && a.session?.model ? a.quota.byModel[a.session.model] : null
  if (uRow) {
    const uLimit = Number(uRow.limit)
    const uUsed = Number(uRow.recentCount)
    if (Number.isFinite(uLimit) && uLimit > 0 && Number.isFinite(uUsed) && uUsed >= uLimit) {
      return 'exhausted'
    }
  }
  // 2.5) 低额度：余额低于用户设的阈值（默认 15 FB ≈ deepseek-v4-flash 单价），
  //      但**还买得起当前模型**——所以这不是故障，是「快见底了」的提前预警。
  //      注意必须排在「额度不足」之后：真买不起的号属于 exhausted，不该混进来。
  if (lowBalanceHit(a)) return 'lowbalance'
  // 3) 警告：探测失败（风控/限流/凭证）或正在冷却
  if (probe || a.cooldownUntil) return 'warning'
  // 4) 正在调度：有活跃/在途会话，或被选号过
  if (a.session?.live || a.used || a.requests > 0 || a.inFlight > 0) return 'active'
  // 5) 剩下的就是从未使用
  return 'fresh'
}

/** 账号 → 分区分组（一个号只落在一个分区里，最坏优先）。 */
function groupAccounts(accounts) {
  const groups = new Map(ACCOUNT_SECTIONS.map((s) => [s.id, []]))
  for (const a of accounts) {
    const id = classifyAccount(a)
    ;(groups.get(id) || groups.get('fresh')).push(a)
  }
  return groups
}

/**
 * 分区的展开状态：**用户的显式操作优先**，其次才是章节默认值。
 * 读 state 而不是读 DOM —— 分区可能因为这一轮没有任何账号而整个消失，
 * 消失期间也必须记住用户摊开过它。
 */
function sectionOpen(section) {
  const v = state.acctSectionsOpen[section.id]
  return typeof v === 'boolean' ? v : Boolean(section.open)
}

/** 建一个分区外壳（details + summary + 表）。新节点按记忆/默认值决定展开。 */
function buildAccountSection(section, rows) {
  const table = el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, el('tr', {}, [
        t('account.email'),
        t('common.status'),
        t('account.session'),
        t('account.concurrency'),
        t('account.timeline'),
        t('account.quotaHeader'),
        t('account.freebucks'),
        t('account.requests'),
        t('account.cooldown'),
        t('common.actions'),
      ].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((a, i) => buildAccountRow(a, i))),
    ]),
  ])
  const details = el('details', {
    class: 'acct-section',
    'data-section': section.id,
    ...(sectionOpen(section) ? { open: 'open' } : {}),
  }, [
    el('summary', {}, [
      el('span', { class: `badge ${section.tone}` }, `${rows.length}`),
      el('span', { style: 'margin-left:8px;font-weight:600' }, section.label),
      el('span', { class: 'muted', style: 'margin-left:8px;font-size:12px' }, section.hint),
    ]),
    table,
  ])
  // 记住用户的手动展开/折叠：这是**唯一**的状态写入点，刷新不会覆盖它。
  details.addEventListener('toggle', () => {
    state.acctSectionsOpen[section.id] = details.open
  })
  return details
}

function buildAccountsTable(accounts) {
  const groups = groupAccounts(accounts)
  const node = el('div', { style: 'margin-top:12px' })
  for (const section of ACCOUNT_SECTIONS) {
    const rows = groups.get(section.id) || []
    if (!rows.length) continue
    node.append(buildAccountSection(section, rows))
  }
  return node
}

/**
 * **账号分区定点更新**（局部刷新的唯一入口）。
 *
 * 为什么不能像以前那样 `wrap.innerHTML = ''` 再整块重建：那等于把整个列表
 * 换成一批全新的 <details>，一切**纯 UI 状态**随之归零 —— 用户手动摊开的分区
 * 被折回去、滚动位置跳回顶部、正在看的行闪烁。用户明确要求刷新**不得重置**
 * 分组的展开/折叠状态。
 *
 * 做法：复用现有的 <details> 外壳（连同它的 open 状态），只替换 <tbody> 的行；
 * 用 append 移动节点来校正分区顺序（移动同一元素不会重置它的展开状态）。
 * @returns {boolean} 是否命中容器（false = 容器不存在，调用方需整页回退）
 */
function applyAccountsSections(accounts) {
  const host = $('#accounts-sections')
  if (!host) return false
  const groups = groupAccounts(accounts)
  const keep = new Set()
  for (const section of ACCOUNT_SECTIONS) {
    const rows = groups.get(section.id) || []
    if (!rows.length) continue
    keep.add(section.id)
    let node = host.querySelector(`details.acct-section[data-section="${section.id}"]`)
    if (node) {
      const tbody = node.querySelector('tbody')
      if (tbody) tbody.replaceChildren(...rows.map((a, i) => buildAccountRow(a, i)))
      const badge = node.querySelector('summary .badge')
      if (badge) badge.textContent = String(rows.length)
    } else {
      node = buildAccountSection(section, rows)
    }
    // append 对已存在的节点 = 移动到新位置，不重建、不重置展开状态。
    host.append(node)
  }
  for (const node of [...host.querySelectorAll('details.acct-section')]) {
    if (!keep.has(node.dataset.section)) node.remove()
  }
  return true
}

function buildAccountRow(a, i) {
  const cd = a.cooldownUntil ? new Date(a.cooldownUntil).toLocaleString() : null
  // Session 列同时回答两件事：(1) 这条会话**还能白用多久**；(2) 这个号
  // 到现在为止**买过几条 / 复用了几次**——后者是"我们在省钱"的直接证据，
  // 因为复用发生在已买断的一小时内，边际成本为 0。
  const admits = Number(a.admitCount) || 0
  const reuses = Number(a.reuseCount) || 0
  const reuseRate =
    admits + reuses > 0 ? Math.round((reuses / (admits + reuses)) * 100) : null
  const countsTip =
    t('account.countsTip', { admits, reuses }) +
    (reuseRate != null ? t('account.countsRate', { rate: reuseRate }) : '') +
    t('account.countsTipTail')
  /**
   * ⚠️ 「这一小时已买给模型 X」必须显示出来（issue #24）。
   *
   * 此前这条会话显示成 `MiMo 2.6 Flash · 50 分钟`——看着完全正常，但它
   * **只服务这一个模型**：此时请求任何别的模型都会被上游拒（实测
   * purchase_claim_released，且 DELETE 之后接不回来），而面板仍写 status=ok。
   * 用户对着"正常"去查一个根本没坏的账号，排障只能翻日志。
   *
   * 后端已给 `session.inPaidWindow`，这里据此加一行标注，把"还能用多久、
   * 只能用哪个模型、什么时候能换"讲清楚。
   */
  const paidBound = a.session?.live && a.session?.inPaidWindow === true
  const sessNode = el('div', {}, [
    // 这里显示的是**给人看的模型名**：a.session.model 是目录 key
    // （m-00032eaeec），必须换成可读名（MiMo 2.6 Flash）。
    el('div', {}, a.session?.live
      ? `${modelLabel(a)} · ${fmtMs(a.session.remainingMs)}`
      : (a.session?.status === 'none' ? t('account.noActiveSession') : (a.session?.status || '—'))),
    paidBound
      ? el('div', {
          class: 'badge warn',
          style: 'font-size:11px;margin-top:2px',
          title: t('account.paidWindowTip', {
            model: modelLabel(a),
            until: a.session?.expiresAt ? fmtTime(a.session.expiresAt) : '—',
          }),
        }, t('account.paidWindowShort'))
      : '',
    admits + reuses > 0
      ? el('div', { class: 'muted', style: 'font-size:11px', title: countsTip },
          reuseRate != null
            ? t('account.boughtReuse', { admits, reuses, rate: reuseRate })
            : t('account.bought', { admits }))
      : '',
  ])
  const sess = sessNode
  // 探测失败原因（country_blocked 强风控 / rate_limited / banned / 凭证无效…）
  const probeFail = a.lastProbe && a.lastProbe.ok === false ? a.lastProbe : null
  const probe = probeFail ? probeReason(probeFail.code, probeFail.message) : null
  /**
   * 状态徽章分三档（用户要求：刷新后至少能区分 ban 和正常）：
   *   banned（红 · 不可恢复）/ unavailable（黄 · 暂时被拒，冷却到期自愈）/ ok（绿）。
   * 判定优先用后端给的 banned/unavailable 字段（与调度器同一套 code），
   * 老版本后端没有这两个字段时按 available 兜底，不会崩。
   */
  const banned = a.banned === true || Boolean(a.bannedAt)
  const unavailable = banned || a.unavailable === true || a.available === false
  const statusDot = el('span', { class: banned ? 'status-dot err' : unavailable ? 'status-dot warn' : 'status-dot ok' })
  let statusLabel = banned
    ? t('account.bannedShort')
    : unavailable
      ? (cd ? t('account.coolingUntil', { until: cd }) : t('account.unavailable'))
      : t('model.available')
  let statusTip = banned
    ? t('account.statusTipBanned')
    : unavailable
      ? t('account.statusTipUnavailable')
      : t('account.statusTipOk')
  let statusCls = banned ? 'badge err' : unavailable ? 'badge warn' : 'badge ok'
  // 探测失败的**具体原因**比笼统的"不可用"更有信息量，覆盖之（但 ban 优先级最高）。
  if (!banned && probe) {
    statusLabel = probe.label
    statusTip = probe.tip
    statusCls = 'badge err'
  }
  const statusBadge = el('span', { class: statusCls, style: 'display:inline-flex', title: statusTip },
    [statusDot, statusLabel])
  const hasSession = Boolean(a.session?.live)
  const ops = el('div', { class: 'row', style: 'gap:6px' }, [
    el('button', { class: 'icon muted', title: t('account.probeTitle'), onclick: (e) => probeAccount(a, e.currentTarget) }, icon('activity', 14)),
    hasSession
      ? el('button', { class: 'icon', title: t('account.closeSessionTitle'), onclick: (e) => closeAccountSession(a, e.currentTarget) }, icon('x', 14))
      : null,
    state.me.role === 'admin'
      ? el('button', { class: 'icon muted', title: t('account.clearCooldownTitle'), onclick: () => clearCooldown(a.key) }, icon('zap', 14))
      : null,
    el('button', { class: 'icon muted', title: t('account.credentialButtonTitle'), onclick: () => openCredentialModal(a) }, icon('key', 14)),
    state.me.role === 'admin'
      ? el('button', { class: 'icon danger', title: t('account.deleteTitle'), onclick: () => removeAccount(a.key, a.email) }, icon('trash', 14))
      : null,
  ])
  return el('tr', { class: 'row-in', style: `animation-delay:${Math.min(i * 40, 400)}ms` }, [
    el('td', {}, [
      a.email,
      a.id && a.id !== a.email ? el('div', { class: 'muted', style: 'font-size:11px' }, `ID ${a.id}`) : '',
      a.lastUsed ? el('span', { class: 'badge ok', style: 'margin-left:6px' }, t('account.lastUsed')) : '',
    ]),
    el('td', {}, statusBadge),
    el('td', { class: 'mono', style: 'font-size:12px' }, sess),
    el('td', { class: 'mono' }, `${a.inFlight || 0}/${a.concurrency || 1}`),
    accountTimeCell(a),
    el('td', {}, fmtQuota(a.quota, a.freebucks)),
    // a.session.model 是**目录 key**（m-00032eaeec）；可读名由后端解析并放在
    // session.modelDisplayName（AccountRuntimes.list() 统一带上）。
    // ⚠️ 之前写成 a.modelDisplayName（顶层）—— 字段不在顶层，永远取不到，
    // 于是这一列一直回落成裸 key。拿到不到就回落到 key，绝不显示空。
    el('td', {}, fmtFreebucks(
      a.freebucks,
      a.session?.modelDisplayName || a.session?.model,
      a.lastRefund,
    )),
    el('td', { class: 'mono' }, t('common.times', { n: a.requests || 0 })),
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
  const msg = message || c || t('account.unknownReason')
  if (c.includes('country_blocked') || c.includes('countryblocked')) {
    return { label: t('account.probeCountryBlocked'), tip: t('account.probeCountryBlockedTip', { msg }) }
  }
  if (c.includes('banned')) {
    return { label: t('account.bannedShort'), tip: t('account.probeBannedTip', { msg }) }
  }
  if (c.includes('ip_capped')) {
    return { label: t('account.probeIpCapped'), tip: t('account.probeIpCappedTip', { msg }) }
  }
  if (/rate_limited|spend_limited|free_mode_rate_limited/.test(c)) {
    return { label: t('account.probeRateLimited'), tip: t('account.probeRateLimitedTip', { msg }) }
  }
  /**
   * ⚠️ 401 单独判，且**只认真正的鉴权失败**。
   *
   * 此前写成 `c.includes('unauthorized') || c.includes('invalid') || c.includes('401')`
   * —— 宽匹配把任何含这些子串的 code 都判成「凭证无效」，而「凭证无效」
   * 在控制台上的含义是"这个号要重新登录"，处置成本最高（要用户去浏览器重登
   * 再导入）。真因若是别的，用户就照着错的提示白折腾一遍。
   *
   * 现在：后端已把 session 401 归一成 `auth_unauthorized`（见
   * upstream/client.js 的 401 分支），这里按精确 code 命中，并把上游原文
   * （"Invalid API key" / "Missing or invalid Authorization header"）带进 tip。
   * 拿不到结构化 code 的老后端仍靠上游原文兜底，不退化成"未知原因"。
   */
  if (c === 'auth_unauthorized' || /unauthorized|invalid api key|missing or invalid authorization/.test(c + ' ' + msg.toLowerCase())) {
    return { label: t('account.probeInvalidCred'), tip: t('account.probeInvalidCredTip', { msg }) }
  }
  return { label: t('account.probeFailed'), tip: msg }
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
    applyModelNames(data)
    try {
      const s = await api('/api/settings')
      if (Number.isInteger(s.lowBalanceThreshold)) {
        state.lowBalanceThreshold = s.lowBalanceThreshold
      }
    } catch { /* 沿用当前值 */ }
    // **定点更新**：复用现有分区外壳（保住展开状态/滚动位置），只换行。
    applyAccountsSections(data.accounts)
    wrap.classList.remove('refreshing')
    refreshSnapshotExtras(data)
    if (!silent) toast(t('account.refreshed'))
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
        title: t('overview.balanceBarTitle', { email: a.email, pct, used: a.requests, total: totalReq }),
      }))
    }
  }
  const h2 = $('#app h2')
  if (h2 && h2.textContent.startsWith(t('overview.accountPool')) && data.accountCount != null) {
    h2.textContent = t('overview.accountPoolCount', { n: data.accountCount })
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
    applyModelNames(data)
    // 与 refreshAccountsCard 共用同一套定点更新（同一个 id 容器），
    // 绝不再用 $('.table-wrap') 去选"第一个分区的表"，也不整块重建
    // （整块重建会重置分区的展开/折叠状态）。
    applyAccountsSections(data.accounts)
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
    // 先并入模型名映射：下面那行 toast 会打印每个模型的已用/上限，
    // 而它的键是目录 key —— 不先并表就又会把 m-00032eaeec 弹给用户。
    applyModelNames(r)
    const sess = r.session || {}
    const limits = sess.rateLimitsByModel || {}
    const modelCount = Object.keys(limits).length
    if (r.ok) {
      const models = Object.entries(limits)
        .map(([id, info]) => `${modelNameFor(id)} ${fmtNum(info?.recentCount)}/${info?.limit ?? '?'}`)
        .join(' · ')
      toast(t('account.probeOk', { email: a.email, n: modelCount }) + (models ? t('account.probeModelList', { list: models }) : ''))
      await refreshAccountsCard()
    } else {
      const code = r.code || sess?.status || sess?.error || r.error || t('account.unknownReason')
      const reason = probeReason(code, r.error || r.message)
      toast(t('account.probeAbnormal', { email: a.email, label: reason.label, tip: String(reason.tip).slice(0, 140) }), true)
    }
  } catch (err) {
    restore()
    toast(t('account.probeFail', { msg: err.message }), true)
  }
}

/**
 * 一键刷新（顶部主按钮）：账号额度 + 探测状态 + 上游模型目录，一次全刷。
 *
 * **只读**：不 admit、不 DELETE、不动任何 session 句柄。已付费的一小时
 * 不受影响（后端 /api/accounts/refresh 里逐条注释了这条硬约束）。
 *
 * 全程局部更新：账号表分区外壳与展开状态、代理卡片、模型卡片都原地更新，
 * 不整页重建 —— 刷新前后用户视线所在的滚动位置和折叠状态都不变。
 */
async function oneClickRefresh(btn) {
  const restore = withButtonLoading(btn, t('common.refreshing'))
  try {
    const r = await api('/api/accounts/refresh', { method: 'POST' })
    state.accounts = r.accounts || state.accounts
    applyModelNames(r)
    if (Array.isArray(r.upstreamModelIds)) state.upstreamModelIds = r.upstreamModelIds
    if (Array.isArray(r.upstreamModels)) state.upstreamModels = r.upstreamModels
    const results = r.results || []
    const failed = results.filter((x) => !x.ok)
    const banned = failed.filter((x) => String(x.code || '').includes('banned'))
    const soft = failed.length - banned.length
    const parts = []
    parts.push(t('account.refreshOk', { n: results.length - failed.length }))
    if (banned.length) parts.push(t('account.refreshBanned', { n: banned.length }))
    if (soft.length) parts.push(t('account.refreshAbnormal', { n: soft.length }))
    parts.push(t('account.refreshModels', { n: (r.upstreamModelIds || []).length }))
    toast(parts.join(' · ') + t('account.refreshReadOnly'), failed.length > 0)
    applyAccountsSections(state.accounts)
    await applyOverviewAndModelCards()
    refreshModelSettingsCard().catch(() => {})
  } catch (err) {
    toast(err.message, true)
  } finally {
    restore()
  }
}

/** 全部账号探测（沿用原有逻辑 + 局部刷新） */
async function probeAllAccounts(btn = null) {
  // 按钮由调用方显式传入（两个入口：页头「探测刷新」与账号卡「探测刷新」）。
  // 不要去猜 activeElement：局部刷新后节点会被替换，猜到的往往是另一个按钮。
  const restore = withButtonLoading(btn, t('account.probing'))
  try {
    const r = await api('/api/accounts/probe', { method: 'POST' })
    state.accounts = r.accounts
    applyModelNames(r)
    const failed = (r.results || []).filter((x) => !x.ok)
    toast(failed.length
      ? t('account.probeDoneFail', { n: failed.length })
      : t('account.probeDone'), !!failed.length)
    if (applyAccountsSections(r.accounts)) {
      refreshSnapshotExtras({ accounts: r.accounts })
    } else render()
  } catch (err) {
    toast(err.message, true)
  } finally {
    restore()
  }
}

/**
 * 概览里**账号无关**的区块定点刷新：统计卡 + 负载均衡条 + 账号池计数 +
 * 代理卡（空闲释放推荐值按账号池实时算）。全部原地更新，不碰账号分区。
 */
async function applyOverviewAndModelCards() {
  try {
    const data = await api('/api/overview')
    state.accounts = data.accounts
    applyModelNames(data)
    refreshSnapshotExtras(data)
  } catch { /* 拿不到就沿用当前快照 */ }
  try { await renderProxySettings() } catch { /* 代理卡未挂载 */ }
}

/** 等待中的登录流程卡片 */
async function renderFlowsCard(view) {
  try {
    state.flows = (await api('/api/accounts/login')).data
  } catch { return }
  const activeFlows = state.flows.filter((f) => f.status === 'pending')
  if (!activeFlows.length) return
  view.append(el('div', { class: 'card', style: 'margin-top:12px' }, [
    el('h3', { style: 'margin:0 0 8px' }, t('account.pendingLogins')),
    ...activeFlows.map((f) => el('div', { class: 'row spread', style: 'padding:8px 0;border-bottom:1px solid var(--border)' }, [
      el('span', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:6px' }, [icon('globe', 14), t('account.startedAt', { time: new Date(f.createdAt).toLocaleString() })]),
      el('button', { onclick: () => openLoginFlow(f) }, [icon('globe', 14), t('account.openLoginLink')]),
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
  // 「空闲释放推荐值」要按账号池实时算（活跃模型/账号比），而 /api/proxy 只回
  // 代理信息、不含 session.model。这里单独拉一次 overview 填充 state.accounts。
  // 独立 try：overview 挂了也不能把上面的 settings 一起拖垮（否则整页回落到默认值）。
  try {
    const overview = await api('/api/overview')
    if (Array.isArray(overview.accounts)) state.accounts = overview.accounts
  } catch {
    // 拉不到就沿用已有的 state.accounts（可能为空 → 推荐值退回默认 600s）
  }

  const signatureEnabled = settings.freeToolSignatureEnabled !== false
  const toggleAttrs = {
    id: 'free-tool-signature',
    type: 'checkbox',
    class: 'switch-input',
    onchange: saveFreeToolSignatureSetting,
  }
  if (signatureEnabled) toggleAttrs.checked = ''
  if (state.me.role !== 'admin') toggleAttrs.disabled = ''
  // 工具被拒时，仅在明确开启纯文本回退后才去掉 tools 重试。
  const stripTools = settings.stripToolsOnSchemaRejection === true
  const stripAttrs = {
    id: 'strip-tools-on-reject',
    type: 'checkbox',
    class: 'switch-input',
    onchange: saveStripToolsSetting,
  }
  if (stripTools) stripAttrs.checked = ''
  if (state.me.role !== 'admin') stripAttrs.disabled = ''
  view.append(el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('system.freeQuotaPolicy')),
      el('span', { class: 'muted' }, t('system.toolSignatureHint')),
    ]),
    el('label', { class: 'switch', for: 'free-tool-signature' }, [
      el('input', toggleAttrs),
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      el('span', { class: 'switch-status' }, signatureEnabled ? t('common.on') : t('common.off')),
    ]),
  ]))
  view.append(el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('system.toolFallback')),
      el('span', { class: 'muted' }, t('system.toolFallbackHint')),
    ]),
    el('label', { class: 'switch', for: 'strip-tools-on-reject' }, [
      el('input', stripAttrs),
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      el('span', { class: 'switch-status' }, stripTools ? t('common.on') : t('common.off')),
    ]),
  ]))

  // 上游请求链路：legacy（自拼）/ official（照抄官方抓包）
  const channel = settings.upstreamChannel === 'official' ? 'official' : 'legacy'
  view.append(el('div', { class: 'card settings-band', style: 'margin-top:12px' }, [
    el('div', {}, [
      el('h3', { style: 'margin:0 0 2px' }, t('system.upstreamChannel')),
      el('span', { class: 'muted' }, t('system.upstreamChannelHint')),
    ]),
    el('div', { class: 'row' }, [
      el('select', {
        id: 'upstream-channel',
        style: 'width:320px',
        onchange: saveUpstreamChannelSetting,
        ...(state.me.role === 'admin' ? {} : { disabled: '' }),
      }, [
        // legacy 已废弃：保留选项但禁用，让用户看得见"曾经有过、现在不能用"，
        // 而不是凭空消失造成困惑。
        el('option', { value: 'legacy', disabled: '' }, t('system.upstreamChannelLegacy')),
        el('option', { value: 'official', ...(channel === 'official' ? { selected: '' } : {}) }, t('system.upstreamChannelOfficial')),
      ]),
    ]),
  ]))

  const concurrency = settings.accountMaxConcurrency ?? 2
  const schedMode = settings.accountSchedulingMode === 'spread' ? 'spread' : 'sticky'
  const overflowWaitMs = settings.accountOverflowWaitMs ?? 15000
  view.append(el('div', { class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('system.scheduling')),
        el('span', { class: 'muted' }, t('system.schedulingHint')),
      ]),
    ]),
    el('div', { class: 'row', style: 'margin-top:12px;gap:24px;flex-wrap:wrap' }, [
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, t('system.schedulingMode')),
        el('div', { class: 'row' }, [
          el('select', {
            id: 'scheduling-mode',
            style: 'width:210px',
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }, [
            el('option', { value: 'sticky', ...(schedMode === 'sticky' ? { selected: '' } : {}) }, t('system.modeSticky')),
            el('option', { value: 'spread', ...(schedMode === 'spread' ? { selected: '' } : {}) }, t('system.modeSpread')),
          ]),
        ]),
      ]),
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, t('system.accountConcurrency')),
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
        el('label', { style: 'margin:0 0 4px' }, t('system.overflowWait')),
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
        ? el('div', { style: 'align-self:flex-end' }, el('button', { class: 'primary', onclick: saveLoadBalanceSettings }, t('common.saveApply')))
        : null,
    ]),
    el('div', { class: 'muted', id: 'scheduling-hint', style: 'margin-top:8px' }, schedulingHint(schedMode, concurrency, overflowWaitMs) + (state.me.role !== 'admin' ? t('system.adminOnly') : '')),
  ]))

  const idleReleaseSec = settings.idleReleaseSec ?? 600
  const maxNewSessions = settings.maxNewSessionsPerRequest ?? 2
  const lowBalanceThreshold = settings.lowBalanceThreshold ?? 15
  state.lowBalanceThreshold = lowBalanceThreshold
  const advice = idleReleaseAdvice(state.accounts)
  view.append(el('div', { class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('system.quotaProtection')),
        el('span', { class: 'muted' }, t('system.twoLedgers')),
      ]),
    ]),
    el('div', { class: 'muted', style: 'margin-top:6px;line-height:1.6' }, [
      el('b', {}, t('system.admitBuysHour')),
      t('system.admitBody1'),
      el('b', {}, t('system.admitMarginalZero')),
      t('system.admitBody2'),
      el('b', {}, t('system.admitNoIdleRelease')),
      t('system.admitBody3'),
    ]),
    el('div', { class: 'muted', style: 'margin-top:6px;line-height:1.6' }, [
      t('system.refundAsymmetric'),
      el('b', {}, t('system.refundUnits')),
      t('system.refundUnitsBody'),
      el('b', {}, t('system.refundFreebucks')),
      t('system.refundFreebucksBody'),
      el('b', {}, t('system.refundFreebucksFirst')),
      t('system.refundConclusion'),
    ]),
    el('div', { class: 'muted', style: 'margin-top:6px' }, t('system.refundSources')),
    el('div', { class: 'row', style: 'margin-top:12px;gap:24px;flex-wrap:wrap' }, [
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, t('system.idleRelease')),
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
        el('label', { style: 'margin:0 0 4px' }, t('system.lowBalanceThreshold')),
        el('div', { class: 'row' }, [
          el('input', {
            id: 'low-balance-threshold',
            type: 'number',
            min: 0,
            max: 10000,
            style: 'width:90px',
            value: lowBalanceThreshold,
            ...(state.me.role === 'admin' ? {} : { disabled: '' }),
          }),
        ]),
      ]),
      el('div', {}, [
        el('label', { style: 'margin:0 0 4px' }, t('system.maxNewSessions')),
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
            ? el('button', { class: 'primary', onclick: saveQuotaProtectionSettings }, t('common.saveApply'))
            : null,
        ]),
      ]),
    ]),
    el('div', { class: 'muted', id: 'idle-release-hint', style: 'margin-top:8px' },
      idleReleaseSec > 0
        ? t('system.idleReleaseHintOn', { sec: idleReleaseSec, max: maxNewSessions || t('common.unlimited') })
        : t('system.idleReleaseHintOff', { max: maxNewSessions || t('common.unlimited') })),
    el('div', { id: 'idle-release-advice', style: 'margin-top:10px;padding:10px;border-radius:8px;background:rgba(255,196,0,.08);border:1px solid rgba(255,196,0,.25)' }, [
      el('div', { style: 'font-weight:600;margin-bottom:4px' }, t('system.adviceTitle')),
      el('div', { class: 'muted', id: 'idle-release-advice-text' }, advice.why),
      el('div', { class: 'advice-actions' }, [
        state.me.role === 'admin' && advice.sec !== idleReleaseSec
          ? el('button', { class: 'primary', style: 'margin-top:8px', onclick: () => applyIdleReleaseAdvice(advice.sec) }, t('system.adviceApply', { sec: advice.sec }))
          : el('div', { class: 'muted', style: 'margin-top:6px' }, advice.sec === idleReleaseSec ? t('system.adviceInSync') : t('system.adviceAdminHint')),
      ]),
    ]),
  ]))

  const card = el('div', { id: 'proxy-card', class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, t('proxy.cardTitle')),
        el('span', { class: 'muted' }, t('proxy.cardHint')),
      ]),
      el('button', { class: 'primary', onclick: saveProxyPool }, [icon('globe', 14), t('common.saveApply')]),
    ]),
    el('textarea', {
      id: 'proxy-pool',
      rows: 3,
      class: 'mono',
      style: 'margin-top:8px',
      placeholder: t('proxy.poolPlaceholder'),
    }, (data.proxies || []).join('\n')),
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      el('input', {
        id: 'proxy-test-url',
        placeholder: t('proxy.testPlaceholder'),
        class: 'mono',
        style: 'flex:1',
      }),
      el('button', { onclick: () => runProxyTest($('#proxy-test-url').value.trim() || null) }, [icon('zap', 14), t('common.test')]),
      el('button', { class: 'muted', onclick: () => runProxyTest(null) }, t('proxy.testConfigured')),
    ]),
    el('div', { id: 'proxy-test-result', style: 'margin-top:8px' }),
    data.effective && data.effective.length
      ? el('div', { class: 'muted', style: 'margin-top:8px' }, t('proxy.effectiveList', { list: data.effective.map(shortProxy).join('、') }))
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
    toast(
      enabled
        ? t('system.toolSignatureOn')
        : t('system.toolSignatureOff'),
    )
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

/** 工具被拒时剥离 tools 重试开关（见 /api/settings.stripToolsOnSchemaRejection）。 */
/** 上游请求链路（legacy / official）切换。 */
async function saveUpstreamChannelSetting(event) {
  const sel = event.currentTarget
  const value = sel.value === 'official' ? 'official' : 'legacy'
  sel.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ upstreamChannel: value }),
    })
    toast(value === 'official' ? t('system.upstreamChannelOfficial') : t('system.upstreamChannelLegacy'))
    try {
      const s = await api('/api/settings')
      sel.value = s.upstreamChannel === 'official' ? 'official' : 'legacy'
    } catch { /* 回读失败也保持可交互 */ }
  } catch (err) {
    sel.value = value === 'official' ? 'legacy' : 'official'
    toast(err.message, true)
  }
  sel.disabled = false
}

async function saveStripToolsSetting(event) {
  const input = event.currentTarget
  const enabled = input.checked
  input.disabled = true
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ stripToolsOnSchemaRejection: enabled }),
    })
    toast(enabled ? t('system.toolFallbackOn') : t('system.toolFallbackOff'))
    try {
      const s = await api('/api/settings')
      const actual = s.stripToolsOnSchemaRejection === true
      input.checked = actual
      updateSwitchLabel(input)
    } catch { /* 忽略回读失败，仍保持可交互 */ }
  } catch (err) {
    input.checked = !enabled
    toast(err.message, true)
  }
  input.disabled = false
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
    toast(enabled ? t('system.blockPremiumOn') : t('system.blockPremiumOff'))
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
  if (statusEl) statusEl.textContent = input.checked ? t('common.on') : t('common.off')
}

/**
 * 调度模式说明文案（前端即时预览，保存后由服务端返回的实际值再刷新一次）。
 * 这段文字是用户理解"为什么只开了一个号"的关键，措辞要直白。
 */
/**
 * 「空闲自动释放」推荐值：按当前账号池的真实模型分布算，而不是拍脑袋给个数。
 *
 * 为什么这个值需要权衡（2026-09-14 一手实测后改口径，见 docs/freebucks-strategy.html）：
 *   - **一次 admit = 买断一小时**（当场扣满整小时单价）。所以**付费时段内闲置不花钱**，
 *     释放反而是把已买的钱丢掉——钱这个维度**不再支持"越早越好"**；
 *   - 但一个账号同时只能有一条 session，且 session **绑定模型**。释放之后再来的请求
 *     要**重新 admit**（又买一小时）。所以真正的权衡只剩**槽位**：什么时候把这个
 *     账号让给别的模型；
 *   - 因此：模型集中在少数账号（同一条热会话被反复复用）时，释放晚一点无所谓；
 *     模型种类接近账号数（几乎每个账号都在被不同模型来回抢）时，更要及时释放，
 *     否则换模型要干等，而等待本身不产生价值、还会让后续请求排队。
 *   注：本推荐值现在是**付费时段结束之后**的空闲释放时长（时段内一律不释放）。
 *
 * 返回 { sec, why }；sec 已夹在 60..600（1 分钟~10 分钟）这个保守区间内。
 */
function idleReleaseAdvice(accounts) {
  const pool = accounts.length
  if (!pool) {
    return { sec: 60, why: t('system.adviceNoAccounts') }
  }
  const liveModels = new Set(
    accounts.map((a) => a.session && a.session.live && a.session.model).filter(Boolean),
  )
  const distinct = liveModels.size
  const ratio = distinct / pool
  let sec
  let why
  if (distinct === 0) {
    sec = 60
    why = t('system.adviceNoSessions', { pool })
  } else if (ratio >= 0.8) {
    sec = 60
    why = t('system.adviceTight', { pool, distinct })
  } else if (ratio <= 0.5) {
    sec = 300
    why = t('system.adviceRelaxed', { pool, distinct })
  } else {
    sec = 120
    why = t('system.adviceBalanced', { pool, distinct })
  }
  return { sec, why }
}
/** 重算并刷新推荐值区块（保存设置后调用，不整页重建）。 */
function renderIdleReleaseAdvice() {
  const row = $('#idle-release-advice .advice-actions')
  const text = $('#idle-release-advice-text')
  if (!row || !text) return
  const advice = idleReleaseAdvice(state.accounts)
  text.textContent = advice.why
  row.textContent = ''
  const cur = parseInt($('#idle-release-sec')?.value, 10)
  if (state.me && state.me.role === 'admin' && advice.sec !== cur) {
    row.append(
      el('button', { class: 'primary', style: 'margin-top:8px', onclick: () => applyIdleReleaseAdvice(advice.sec) },
        t('system.adviceApply', { sec: advice.sec })),
    )
  } else if (advice.sec === cur) {
    row.append(el('div', { class: 'muted', style: 'margin-top:6px' }, t('system.adviceInSync')))
  }
}

/** 一键采用推荐值（连同当前的单请求新会话上限一起提交）。 */
async function applyIdleReleaseAdvice(sec) {
  const budget = $('#max-new-sessions')
  const b = budget ? Math.max(0, Math.min(16, parseInt(budget.value, 10) || 0)) : 2
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ idleReleaseSec: sec, maxNewSessionsPerRequest: b }),
    })
    const input = $('#idle-release-sec')
    if (input) input.value = sec
    toast(t('system.adviceApplied', { sec, max: b || t('common.unlimited') }))
    const hint = $('#idle-release-hint')
    if (hint) {
      hint.textContent = sec > 0
        ? t('system.idleReleaseHintOn', { sec, max: b || t('common.unlimited') })
        : t('system.idleReleaseHintOff', { max: b || t('common.unlimited') })
    }
    renderIdleReleaseAdvice()
  } catch (err) {
    toast(err.message, true)
  }
}

function schedulingHint(mode, concurrency, overflowWaitMs) {
  const cap = t('system.schedCap', { n: concurrency })
  if (mode === 'spread') {
    return t('system.schedSpread', { cap, wait: overflowWaitMs })
  }
  return t('system.schedSticky', { cap })
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
        ? t('system.schedSavedSpread', { n: realConc })
        : t('system.schedSavedSticky', { n: realConc }),
    )
    const hint = $('#scheduling-hint')
    if (hint) {
      hint.textContent =
        schedulingHint(realMode, realConc, realWait) +
        (state.me.role !== 'admin' ? t('system.adminOnly') : '')
    }
  } catch (err) {
    toast(err.message, true)
  }
}

/** 保存「额度保护」设置：空闲自动释放秒数 + 单请求新会话预算（立即生效） */
async function saveQuotaProtectionSettings() {
  const idle = $('#idle-release-sec')
  const budget = $('#max-new-sessions')
  const lowBal = $('#low-balance-threshold')
  if (!idle || !budget) return
  try {
    const v = Math.max(0, Math.min(86400, parseInt(idle.value, 10) || 0))
    const b = Math.max(0, Math.min(16, parseInt(budget.value, 10) || 0))
    const lb = lowBal ? Math.max(0, Math.min(10000, parseInt(lowBal.value, 10) || 0)) : 15
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        idleReleaseSec: v,
        maxNewSessionsPerRequest: b,
        lowBalanceThreshold: lb,
      }),
    })
    state.lowBalanceThreshold = lb
    toast(v > 0
      ? t('system.quotaSavedOn', { sec: v, max: b || t('common.unlimited') })
      : t('system.quotaSavedOff', { max: b || t('common.unlimited') }))
    // 阈值变了要重画账号分区（低额度分组可能刚被打开/关闭）
    try { await refreshAccountsCard() } catch { /* 表未挂载时忽略 */ }
    const hint = $('#idle-release-hint')
    if (hint) {
      hint.textContent = v > 0
        ? t('system.idleReleaseHintOn', { sec: v, max: b || t('common.unlimited') })
        : t('system.idleReleaseHintOff', { max: b || t('common.unlimited') })
    }
    renderIdleReleaseAdvice()
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
    toast(r.note || t('toast.saved'))
    // 局部刷新「当前生效代理」文字，不重建页面
    try {
      const pdata = await api('/api/proxy')
      const eff = pdata.effective || []
      // 按「生效代理」这一固定语义锚点找节点：文案本身已随语种变化
      const effNode = [...document.querySelectorAll('#proxy-card .muted')].find(
        (n) => n.textContent.includes(t('proxy.effectivePrefix')),
      )
      if (effNode) {
        effNode.textContent = eff.length
          ? t('proxy.effectiveList', { list: eff.map(shortProxy).join(t('common.listSep')) })
          : t('proxy.notConfiguredDirect')
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
  box.append(el('span', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:6px' }, [el('span', { class: 'spinner' }), t('proxy.testing')]))
  try {
    const r = await api('/api/proxy/test', {
      method: 'POST',
      body: JSON.stringify(proxy ? { proxy } : {}),
    })
    box.innerHTML = ''
    if (!r.results.length) {
      box.append(el('div', { class: 'muted' }, r.note || t('proxy.notConfiguredDirect')))
      return
    }
    for (const res of r.results) {
      const head = res.ok
        ? el('span', { class: 'badge ok' }, [icon('check', 11), t('proxy.usable')])
        : el('span', { class: 'badge err' }, [icon('x', 11), t('proxy.unusable')])
      const lines = [
        el('div', {}, [
          head,
          el('code', { class: 'mono muted', style: 'margin-left:8px;font-size:12px' }, res.proxy),
        ]),
      ]
      if (res.ok) {
        lines.push(el('div', { class: 'muted' }, [
          t('proxy.egressIp', { ip: res.ip || '?' }),
          res.country ? t('proxy.countryParen', { country: res.country }) : '',
          t('proxy.latencyMs', { ms: res.latencyMs }),
          t('proxy.upstreamStatus', { status: res.codebuffStatus ?? '?' }),
        ].join('')))
      } else {
        lines.push(el('div', { class: 'muted', style: 'color:var(--red)' }, t('proxy.testFailedRow', { msg: res.error || t('proxy.connectFailed'), ms: res.latencyMs })))
        if (res.hint) lines.push(el('div', { class: 'muted', style: 'margin-top:4px' }, res.hint))
      }
      box.append(el('div', { style: 'padding:8px 0;border-bottom:1px solid var(--border)' }, lines))
    }
  } catch (err) {
    box.innerHTML = ''
    box.append(el('div', { class: 'muted', style: 'color:var(--red)' }, t('proxy.testFailed', { msg: err.message })))
  }
}

function fmtMs(ms) {
  if (ms == null) return t('common.none')
  const m = Math.floor(ms / 60000)
  return t('dur.minutes', { n: m })
}

/**
 * 时长（毫秒）→ 人类可读：<1 分钟显示秒，<1 小时显示 m/s，否则 h/m。
 * 调度时长经常只有几十秒（短批量），fmtMs 一律显示 "0 分钟" 会看不出差别。
 */
function fmtDurationMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '0'
  const s = Math.floor(n / 1000)
  if (s < 60) return t('dur.seconds', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('dur.minutesSeconds', { m, s: s % 60 })
  const h = Math.floor(m / 60)
  return t('dur.hoursMinutesShort', { h, m: m % 60 })
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
      ? t('account.round', { dur: fmtDurationMs(a.currentSchedulingMs) })
      : a.lastScheduledAt
        ? t('account.last', { time: fmtTime(a.lastScheduledAt) })
        : t('account.notScheduled')
  const title = [
    t('account.importedAt', { at: a.importedAt ? new Date(a.importedAt).toLocaleString() : t('common.unknown') }),
    t('account.credentialUpdatedAt', { at: a.credentialUpdatedAt ? new Date(a.credentialUpdatedAt).toLocaleString() : t('account.neverUpdated') }),
    t('account.totalScheduled', { dur: fmtDurationMs(a.scheduledMs) }),
    a.schedulingSince
      ? t('account.roundSince', { at: new Date(a.schedulingSince).toLocaleString() })
      : null,
  ].filter(Boolean).join('\n')
  return el('td', { class: 'mono acct-time', style: 'font-size:11px', title }, [
    el('div', {}, t('account.importedShort', { at: imported })),
    el('div', { class: 'muted' }, updated ? t('account.updatedShort', { at: updated }) : t('account.updatedShort', { at: t('common.none') })),
    el('div', { class: a.currentSchedulingMs > 0 ? '' : 'muted' }, t('account.scheduledShort', { dur: total })),
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
  /**
   * 「账号真实可用」的判据 = **上游目录里有没有这一行**。
   *
   * 用户质疑得对：表里有 15 条内置 + 53 条自定义，而上游目录只有 13 条。
   * 那些上游根本没有的条目**调用必然失败**，却在列表里与可用模型长得一模一样
   * —— 纯粹是误导。所以每一行都必须能一眼看出它在不在上游目录里。
   *
   * 匹配按**可读名**（与 /v1/models 同源，口径 `displayName || key`）比对；
   * 目录 key（m-xxx）作兜底，因为旧自定义条目可能只存了 key。
   */
  const upstreamIdSet = new Set(
    (upstream.models || []).map((m) => m.id || m.catalogId || m.key).filter(Boolean),
  )
  const upstreamKeySet = new Set((upstream.models || []).map((m) => m.key).filter(Boolean))
  const isLiveUpstream = (m) =>
    upstreamIdSet.has(m.id) || (m.key && upstreamKeySet.has(m.key))

  const rows = [...known.values()]
  /**
   * ⚠️ staleCount **必须在 rows 声明之后**算。
   *
   * 第一版把它写在 `const rows` 之前，而它要读 `rows` —— 命中 TDZ
   * （`can't access lexical declaration 'rows' before initialization`），
   * 整个模型管理页直接白屏。判据函数本身不碰 rows，可以前置；
   * 但任何**消费** rows 的派生值都必须排在它后面。
   */
  const staleCount = rows.filter((m) => !isLiveUpstream(m)).length
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
        el('h3', { style: 'margin:0 0 2px' }, t('model.management')),
        el('span', { class: 'muted' }, t('model.syncHint')),
      ]),
      isAdmin
        ? el('div', { class: 'row' }, [
            el('button', { class: 'primary', onclick: syncUpstreamModels }, [icon('refresh', 14), t('model.syncUpstream')]),
          ])
        : null,
    ]),
    el('div', { class: 'row', style: 'margin-top:8px;align-items:center;gap:8px' }, [
      el('label', { class: 'switch', for: 'block-premium' }, [
        el('input', blockToggleAttrs),
        el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
        el('span', { class: 'switch-status' }, blockPremium ? t('common.on') : t('common.off')),
      ]),
      el('span', { class: 'muted', style: 'font-size:12px' }, t('model.blockPremium')),
    ]),
    upstream.accessTier
      ? el('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' },
          t('model.upstreamCatalog', { n: upstream.models.length, tier: upstream.accessTier }))
      : null,
    /**
     * 对账条：**先说清"表里哪些其实调不了"**，再说别的。
     *
     * 旧界面把 15 条内置 + 53 条自定义与上游 13 条平铺在同一张表里，
     * 没有任何一处告诉用户"这 55 个你的账号用不了"——
     * 用户只能一个个试，试到失败才知道。这里在表头上直接给总数与处置入口。
     */
    upstream.models?.length
      ? el('div', {
          class: 'row',
          style: 'margin-top:8px;gap:8px;align-items:center;flex-wrap:wrap',
        }, [
          el('span', { class: 'badge ok' }, t('model.liveCount', { n: upstream.models.length })),
          staleCount > 0
            ? el('span', { class: 'badge warn' }, t('model.staleCount', { n: staleCount }))
            : null,
          el('span', { class: 'muted', style: 'font-size:12px' }, t('model.staleHint')),
          isAdmin && staleCount > 0
            ? el('button', { class: 'icon danger', onclick: pruneStaleModels, title: t('model.pruneTitle') },
                [icon('trash', 12), t('model.prune', { n: staleCount })])
            : null,
        ])
      : null,
    el('div', { class: 'table-wrap', style: 'margin-top:10px;max-height:280px;overflow:auto' }, [
      el('table', { style: 'font-size:12px' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, t('model.id')),
          el('th', {}, t('model.displayName')),
          el('th', {}, t('model.liveHeader')),
          el('th', {}, t('model.pool')),
          el('th', {}, t('model.quotaHeader')),
          el('th', {}, t('model.agentBase2')),
          el('th', {}, t('model.fallbackAgentBase3')),
          el('th', {}, t('model.source')),
          isAdmin ? el('th', {}, t('common.actions')) : null,
        ])),
        el('tbody', {}, rows.map((m) => el('tr', {
          'data-key': m.key || m.id,
          // 上游目录里没有的行整体淡化：它在列表里只是占位，调用必然失败。
          // 视觉上必须与可用模型区分开，否则用户仍会一个个去试。
          style: isLiveUpstream(m) ? null : 'opacity:.45',
        }, [
          // 首列是**对外模型名**（口径 `displayName || key`，与 /v1/models 的 id 同源）；
          // 目录 key（m-00032eaeec）退到 title 里 —— 排障时仍要能对上上游日志，
          // 但不该再出现在页面上（用户要求）。见
          // .agents/notes/implemented/bug-fix/2026-10-03-readable-model-id-unification.md
          el('td', {
            style: 'font-family:var(--mono);font-size:11px',
            title: m.key && m.key !== m.id ? t('model.idHint') + `: ${m.key}` : null,
          }, m.id),
          el('td', {}, m.display_name || m.displayName || '—'),
          /**
           * 「账号可用」列：上游目录里有 = 能调用；没有 = 调了必失败。
           * 悬停给出处置建议（隐藏或移除），让"为什么用不了"有答案。
           */
          el('td', {}, isLiveUpstream(m)
            ? el('span', { class: 'badge ok', title: t('model.liveYesTitle') }, t('model.liveYes'))
            : el('span', { class: 'badge warn', title: t('model.liveNoTitle') }, t('model.liveNo'))),
          el('td', {}, el('span', { class: 'badge', class: poolBadgeClass(m.pool) }, poolLabel(m.pool))),
          el('td', {}, fmtModelPrice(m)),
          el('td', { style: 'font-family:var(--mono);font-size:11px' }, m.agentId || m.agent_id || t('common.none')),
          el('td', { style: 'font-family:var(--mono);font-size:11px' }, m.fallbackAgentId || m.fallback_agent_id || t('common.none')),
          el('td', {}, m.source === 'upstream'
            ? el('span', { class: 'badge ok' }, t('model.sourceUpstream'))
            : el('span', { class: 'badge' }, t('model.sourceBuiltin'))),
          isAdmin
            ? el('td', {}, el('button', {
                class: 'icon danger',
                title: t('model.deleteTitle'),
                // 删除/隐藏提交目录 key 而非展示 id：hidden 表与调度同口径（key），
                // 用可读名提交会隐藏不掉（白名单仍按 key 放行）。
                onclick: () => removeCustomModel(m.key || m.id, m.id),
              }, icon('trash', 13)))
            : null,
        ]))),
      ]),
    ]),
    el('div', { style: 'margin-top:14px' }, [
      el('label', { class: 'muted' }, t('model.customLabel')),
      el('div', { id: 'custom-models-editor', style: 'margin-top:6px' }, buildCustomModelRows(data.models || [])),
      el('div', { class: 'row', style: 'margin-top:8px' }, [
        isAdmin
          ? el('button', { onclick: () => addCustomModelRow() }, [icon('plus', 13), t('model.add')])
          : null,
        el('span', { class: 'muted', style: 'font-size:12px' }, t('model.overrideHint')),
      ]),
    ]),
    ...(isAdmin && (data.hidden || []).length
      ? [el('div', { id: 'hidden-models-area', style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--border)' }, [
          el('label', { class: 'muted' }, t('model.hiddenArea', { n: data.hidden.length })),
          el('div', { class: 'hidden-badges row', style: 'margin-top:6px;gap:6px;flex-wrap:wrap' }, (data.hidden || []).map((id) =>
            el('span', { class: 'badge', style: 'display:inline-flex;align-items:center;gap:6px' }, [
              // hidden 列表存的是**服务端口径**（目录 key / catalog id）；
              // 显示走统一映射，别把 m-00032eaeec 再弹回给用户。
              el('code', { style: 'font-family:var(--mono);font-size:11px', title: id }, modelNameFor(id)),
              el('button', {
                class: 'icon', title: t('model.restoreTitle'),
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
    toast(t('model.fetchFail', { msg: err.message }), true)
    return
  }
  /**
   * ⚠️ 「上游暂无可用模型」的触发条件必须是**目录抓取失败**，不是列表为空。
   *
   * 此前判的是 `models.length === 0`，而列表来自会话回执的 rateLimitsByModel
   * （今日给了额度的子集，实测只有 6 个键）—— 额度耗尽/当日额度为 0 时它天然
   * 为空，于是「同步」永远弹这一句，实际模型一个都没少。
   * 后端现在在目录抓取失败时会带 `catalogError: true`。
   */
  if (upstream.catalogError) {
    toast(
      t('model.catalogFail', {
        msg:
          upstream.notProbed
            ? t('playground.notProbed')
            : upstream.note || t('model.noneUpstream'),
      }),
      true,
    )
    return
  }
  if (!upstream.models?.length) {
    toast(t('model.noneUpstream'), true)
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
      // ⚠️ 后端现在给的 um.id 已经是**可读模型名**（目录行 displayName，
      // 如 "DeepSeek V4.1 Flash"），不再是目录 key。
      // catalogId 只是 legacy 反查的兼容字段，**上游新增模型没有 legacyDigests**
      // （实测 Ling 3.1 Flash / Laguna S 2.1 都没有），此时它为空 ——
      // 绝不能因为 catalogId 为空就丢掉整行，否则新模型永远同步不进来。
      // 取值顺序反过来：优先 um.id（目录真值），catalogId 仅作兜底。
      const id = um.id || um.catalogId || um.key
      if (!id) continue
      if (catalogSet.has(id)) continue // catalog 已有，不用写自定义
      const existing = curById.get(id) || {}
      merged.push({
        id,
        displayName: existing.displayName || um.displayName || um.id || '',
        // 收费模型（premium）走热 session 复用调度，别按 daily 平摊到多账号
        pool: existing.pool || (um.premium ? 'premium' : um.pool || 'daily'),
        agentId: existing.agentId || um.agentId || '',
        fallbackAgentId: existing.fallbackAgentId || um.fallbackAgentId || '',
      })
    }
    const r = await api('/api/models/custom', {
      method: 'POST',
      body: JSON.stringify({ models: merged }),
    })
    // save() 会把写回的自定义条目自动解除 hidden——被隐藏的内置模型同步后自然拉回
    /**
     * ⚠️ 同步结果必须是**对齐报告**，不能只报"写了几条自定义"。
     *
     * 用户原话：点刷新应当是「同步上游」，而列表里那些**账号用不了的**
     * （内置/手动添加、上游目录里根本不存在的）留着就是误导 ——
     * 旧文案只说「自定义 {n} 条」，数字越大用户越以为同步成功，
     * 实际那 53 条里绝大部分上游压根没有，调用必然失败。
     *
     * 所以这里按「上游真实目录」为基准做三向对账并如实报数：
     *   - aligned：上游有、列表也有 → 能调用
     *   - added：  上游有、列表原本没有 → 本次补进来的
     *   - stale：  列表有、上游目录里没有 → 账号调用不了（提示可一键清理）
     */
    const upstreamIds = new Set(
      (upstream.models || []).map((m) => m.id || m.catalogId || m.key).filter(Boolean),
    )
    const listIds = new Set([
      ...(cur.catalog || []).map((m) => m.id),
      ...merged.map((m) => m.id),
    ])
    let aligned = 0
    for (const id of upstreamIds) if (listIds.has(id)) aligned += 1
    const stale = [...listIds].filter((id) => !upstreamIds.has(id)).length
    await showSyncReport({ aligned, added: upstreamIds.size - aligned, stale, total: upstreamIds.size })
    refreshModelSettingsCard()
  } catch (err) {
    toast(t('model.syncFail', { msg: err.message }), true)
  }
}

/**
 * 同步后的**对齐报告弹窗**。
 *
 * 为什么不用 toast：toast 一闪而过，而「哪些模型其实调不了」是用户必须
 * 能看清、能据此操作的结论（旧实现把它塞进一行 toast，用户根本来不及读）。
 * 这里用模态，把三向对账的数字与处置动作一起给全：
 * 只有 stale > 0 时才显示「清理不可用模型」按钮 —— 没有脏数据时
 * 多一个按钮就是噪音。
 */
function showSyncReport({ aligned, added, stale, total }) {
  return new Promise((resolve) => {
    const close = () => {
      document.querySelector('#sync-report-backdrop')?.remove()
      resolve()
    }
    const backdrop = el('div', {
      id: 'sync-report-backdrop',
      class: 'modal-backdrop',
      onclick: (e) => {
        if (e.target?.id === 'sync-report-backdrop') close()
      },
    }, [
      el('div', { class: 'modal', style: 'max-width:420px' }, [
        el('h3', { style: 'margin:0 0 10px' }, t('model.syncReportTitle')),
        el('div', { class: 'row', style: 'gap:10px;margin-bottom:8px' }, [
          el('span', { class: 'badge ok' }, t('model.syncReportAligned', { n: total })),
          added > 0 ? el('span', { class: 'badge' }, t('model.syncReportAdded', { n: added })) : null,
          stale > 0 ? el('span', { class: 'badge warn' }, t('model.syncReportStale', { n: stale })) : null,
        ]),
        el('p', { class: 'muted', style: 'margin:0 0 4px;font-size:12px;line-height:1.6' },
          t('model.syncReportBody')),
        stale > 0
          ? el('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px;line-height:1.6' },
              t('model.syncReportStaleHint', { n: stale }))
          : null,
        el('div', { class: 'row', style: 'margin-top:14px;justify-content:flex-end;gap:8px' }, [
          stale > 0
            ? el('button', { class: 'danger', onclick: async () => { close(); await pruneStaleModels() } },
                t('model.syncReportPrune', { n: stale }))
            : null,
          el('button', { class: 'primary', onclick: close }, t('common.ok')),
        ]),
      ]),
    ])
    document.body.append(backdrop)
  })
}

/**
 * 一键清理「不在上游目录里」的模型（内置=隐藏、自定义=彻底移除）。
 *
 * 幂等且可恢复：内置模型走 hidden（可在「已删除的模型」区点回来），
 * 手动添加的走彻底移除（上游没有它，留着只能误导）。
 */
async function pruneStaleModels() {
  try {
    const [up, cur] = await Promise.all([
      api('/api/models/upstream'),
      api('/api/models/custom'),
    ])
    const upstreamIds = new Set(
      (up.models || []).map((m) => m.id || m.catalogId || m.key).filter(Boolean),
    )
    const builtinIds = new Set((cur.catalog || []).map((m) => m.id))
    const staleBuiltin = []
    const staleCustom = []
    for (const m of cur.catalog || []) {
      if (!upstreamIds.has(m.id)) staleBuiltin.push(m.key || m.id)
    }
    for (const m of cur.models || []) {
      if (!upstreamIds.has(m.id) && !builtinIds.has(m.id)) staleCustom.push(m.id)
    }
    for (const id of staleBuiltin) {
      await api('/api/models/custom/hide', { method: 'POST', body: JSON.stringify({ id }) })
    }
    for (const id of staleCustom) {
      await api('/api/models/custom/remove', { method: 'POST', body: JSON.stringify({ id }) })
    }
    toast(t('model.pruned', { n: staleBuiltin.length + staleCustom.length }))
    refreshModelSettingsCard()
  } catch (err) {
    toast(t('model.pruneFail', { msg: err.message }), true)
  }
}

/** 删除表格里的模型（内置/catalog/上游模型）：加入 hidden 隐藏，可恢复；
 * 重新「同步上游」会按最新上游拉回，不会永久丢失。
 * （用户手动添加的自定义模型在下方编辑器里删，那个是彻底移除。） */
/**
 * 隐藏一个模型（内置的也能隐藏，加入 hidden 列表）。
 *
 * ⚠️ 两个参数分开：`key` 是**服务端口径**（目录 key / catalog id，提交给 hide 接口，
 * 与调度白名单同源），`label` 是**给人看的口径**（确认框与 toast 里显示）。
 * 只用展示名提交会隐藏不掉（白名单仍按 key 放行），只显示 key 又会把
 * `m-00032eaeec` 弹回给用户 —— 两处都得对。
 */
async function removeCustomModel(key, label) {
  const shown = label || key
  if (!confirm(t('model.hideConfirm', { id: shown }))) return
  // 乐观 UI：点击瞬间先从表格移除该行、插入恢复区（不等待任何网络请求）。
  // 行按 data-key 匹配（首列显示的是可读名，拿它比 key 永远找不到行）。
  const row = [...document.querySelectorAll('#models-card tbody tr')].find(
    (r) => r.dataset.key === key,
  )
  if (row) row.remove()
  const card = $('#models-card')
  if (card) addRestoreBadge(card, key, shown)
  try {
    await api('/api/models/custom/hide', {
      method: 'POST',
      body: JSON.stringify({ id: key }),
    })
    toast(t('model.hidden', { id: shown }))
  } catch (err) {
    // 失败：把行加回表格（用本地重建），并撤销恢复区，反馈错误
    toast(err.message, true)
    refreshModelSettingsCard()
  }
}

/** 彻底移除一个用户手动添加的自定义模型（回退内置目录，不会在同步时回来）。 */
async function removeCustomOnlyModel(id) {
  if (!confirm(t('model.removeConfirm', { id }))) return
  try {
    const r = await api('/api/models/custom/remove', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
    toast(t('model.removed', { id }))
    refreshModelSettingsCard()
  } catch (err) {
    toast(err.message, true)
  }
}

/** 恢复被删除（隐藏）的模型 */
async function restoreCustomModel(id) {
  // 乐观：先从恢复区移除徽章，再后台请求
  const badge = [...document.querySelectorAll('#models-card .badge')].find(
    (b) => b.querySelector(`.icon[title="${t('model.restoreTitle')}"]`) && b.textContent.includes(id),
  )
  if (badge) badge.remove()
  try {
    await api('/api/models/custom/unhide', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
    toast(t('model.restored', { id }))
    // 立即重建模型表卡（无需等重拉上游——本地已知恢复）
    refreshModelSettingsCard()
  } catch (err) {
    toast(err.message, true)
    refreshModelSettingsCard()
  }
}

/** 在模型卡里追加一个"已删除模型"恢复徽章（没有恢复区则先创建） */
/**
 * 在「已删除的模型」区插入一个可恢复徽章。
 * `key` 是服务端口径（提交给 unhide），`label` 是展示口径（可读模型名）；
 * hidden 列表里存的永远是 key（与调度白名单同源），页面显示的是 label。
 */
function addRestoreBadge(card, key, label) {
  let area = card.querySelector('#hidden-models-area')
  if (!area) {
    area = el('div', { id: 'hidden-models-area', style: 'margin-top:14px;padding-top:12px;border-top:1px solid var(--border)' }, [
      el('label', { class: 'muted' }, t('model.hiddenAreaShort')),
      el('div', { class: 'hidden-badges row', style: 'margin-top:6px;gap:6px;flex-wrap:wrap' }, []),
    ])
    card.append(area)
  }
  const labelEl = area.querySelector('.muted')
  if (labelEl) {
    const n = area.querySelectorAll('.badge').length
    labelEl.textContent = t('model.hiddenArea', { n })
  }
  area.querySelector('.hidden-badges').append(el('span', { class: 'badge', style: 'display:inline-flex;align-items:center;gap:6px' }, [
    el('code', { style: 'font-family:var(--mono);font-size:11px', title: key }, label || key),
    el('button', { class: 'icon', title: t('model.restoreTitle'), onclick: () => restoreCustomModel(key) }, icon('refresh', 12)),
  ]))
}

/** 渲染自定义模型编辑行（可视化表单，不填 JSON） */
function buildCustomModelRows(models) {
  const wrap = el('div', { class: 'cm-rows' })
  if (!models.length) {
    wrap.append(el('div', { class: 'muted', style: 'padding:8px 0;font-size:12px' }, t('model.emptyCustom')))
    return wrap
  }
  for (const m of models) wrap.append(customModelRow(m))
  return wrap
}

function customModelRow(m = {}) {
  const id = el('input', {
    class: 'mono',
    placeholder: t('model.idPlaceholder'),
    value: m.id || '',
    'data-f': 'id',
    style: 'flex:2;min-width:120px',
  })
  const name = el('input', {
    placeholder: t('model.displayNamePlaceholder'),
    value: m.displayName || m.display_name || '',
    'data-f': 'displayName',
    style: 'flex:1.2;min-width:90px',
  })
  const pool = el('select', {
    'data-f': 'pool',
    style: 'flex:1;min-width:90px',
  }, ['', 'daily', 'premium', 'referral', 'limited_offer'].map((p) =>
    el('option', { value: p, selected: (m.pool || '') === p }, p ? poolLabel(p) : t('model.poolDefault'))))
  const agent = el('input', {
    class: 'mono',
    placeholder: t('model.agentPlaceholder'),
    value: m.agentId || m.agent_id || '',
    'data-f': 'agentId',
    style: 'flex:2;min-width:140px',
  })
  const fbAgent = el('input', {
    class: 'mono',
    placeholder: t('model.fallbackAgentPlaceholder'),
    value: m.fallbackAgentId || m.fallback_agent_id || '',
    'data-f': 'fallbackAgentId',
    style: 'flex:2;min-width:140px',
  })
  const del = el('button', {
    class: 'icon danger',
    title: t('model.deleteTitle'),
    onclick: () => {
      const id = row.querySelector('[data-f="id"]')?.value?.trim()
      row.remove()
      const editor = $('#custom-models-editor')
      if (editor && !editor.querySelector('.cm-row')) {
        editor.append(el('div', { class: 'muted', style: 'padding:8px 0;font-size:12px' }, t('model.emptyCustom')))
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
    toast(t('model.saveFail', { msg: err.message }), true)
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

/** 池类型显示名（走 i18n；GLM 5.3 是模型名，两个语种同文） */
const POOL_LABELS = {
  premium: 'model.poolPremium',
  daily: 'model.poolDaily',
  referral: 'model.poolReferral',
  limited_offer: 'model.poolLimitedOffer',
  glm_v53_flash: 'model.poolGlmV53Flash',
}
function poolLabel(pool) {
  if (!pool) return t('common.none')
  const key = POOL_LABELS[pool]
  return key ? t(key) : pool
}

/**
 * Freebucks 计量展示（上游 2026-09 改版）。
 *
 * **口径 = 买断一小时**：admit 时按「模型单价（Freebucks/小时）」预扣整小时，
 * 这一小时内可**无限复用**。提前 DELETE 只回 freebucksRefundPending，实测 2 分钟
 * 内未到账；而 session_units 那本账是当场按比例退的。所以释放时机按「付费时段内
 * 不释放」处理（见 docs/freebucks-strategy.html）。
 * 这里不再说"今天用了几次会话"，而是直接回答「这个号还能用多久」：
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
    t('quota.balanceAmount', { amount: fmtNum(fb.balance) }),
    balanceMin != null
      ? t('quota.availablePrice', { dur: fmtDuration(balanceMin), model: currentModel, price: fmtNum(price) })
      : null,
    fb.daily
      ? t('quota.dailyPoolLeft', { left: fmtNum(fb.daily.remaining), limit: fmtNum(fb.daily.limit) }) +
        (dailyMin != null ? t('quota.approx', { dur: fmtDuration(dailyMin) }) : '') +
        t('quota.resetAtParen', { at: reset ? reset.toLocaleString() : t('quota.pacificMidnight') })
      : null,
    t('quota.billingExpiresAt'),
    t('quota.reusableNotCredited'),
    fb.wallet && fb.wallet.balance ? t('quota.walletAmount', { amount: fmtNum(fb.wallet.balance) }) : null,
    fb.quotaExempt ? t('quota.exempt') : null,
    lastRefund && lastRefund.refund != null
      ? t('quota.lastRefund', {
          refund: fmtNum(lastRefund.refund),
          expected: lastRefund.expected != null ? fmtNum(lastRefund.expected) : t('common.none'),
        })
      : null,
  ].filter(Boolean).join('\n')
  const low = price != null && !fb.quotaExempt && Number(fb.balance) < price
  return el('div', { class: 'mono', style: 'font-size:12px', title: tip }, [
    el('span', { class: low ? 'badge err' : 'badge ok' }, t('quota.balanceShort', { amount: fmtNum(fb.balance) })),
    price != null ? el('span', { class: 'muted' }, t('quota.priceShort', { price: fmtNum(price) })) : null,
    balanceMin != null
      ? el('span', { class: 'muted' }, t('quota.approxShort', { dur: fmtDuration(balanceMin) }))
      : null,
    fb.daily
      ? el('div', { class: 'muted', style: 'font-size:11px' },
          t('quota.todayLeftShort', { left: fmtNum(fb.daily.remaining), limit: fmtNum(fb.daily.limit) }) +
          (dailyMin != null ? t('quota.approxParen', { dur: fmtDuration(dailyMin) }) : ''))
      : null,
  ])
}

/** 把分钟数渲染成人读时长：<1 分钟给秒，否则给「X 分」「X 小时 Y 分」。 */
function fmtDuration(minutes) {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m <= 0) return t('dur.minutes', { n: 0 })
  if (m < 1) return t('dur.seconds', { n: Math.max(1, Math.round(m * 60)) })
  if (m < 60) return t('dur.minutes', { n: Math.round(m) })
  const h = Math.floor(m / 60)
  const rest = Math.round(m - h * 60)
  return rest ? t('dur.hoursMinutes', { h, m: rest }) : t('dur.hours', { h })
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
    return el('span', { class: 'muted', title: t('quota.noDataTip') }, t('common.none'))
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
    // 悬停提示首行给人看的名字在前、服务端标识在后：排障时仍要能对上上游日志。
    const name = modelNameFor(model)
    const tip = [
      name === model ? model : t('quota.modelWithKey', { name, key: model }),
      hasPrice
        ? t('quota.priceTip', { price: fmtNum(price) })
        : t('quota.noPriceTip'),
      minutes != null
        ? t('quota.poolLeftTip', { left: fmtNum(poolLeft), dur: fmtDuration(minutes) })
        : null,
      Number.isFinite(q.limit)
        ? t('quota.requestQuotaTip', { used: fmtNum(q.recentCount), limit: q.limit, pool: q.poolLabel || t('quota.dailyPool') })
        : null,
      q.resetAt ? t('quota.resetLine', { at: fmtReset(q.resetAt, q.resetTimeZone), in: fmtCountdown(q.resetAt) }) : null,
    ].filter(Boolean).join('\n')
    const label = hasPrice
      ? (price > 0 ? t('quota.pricePerHour', { price: fmtNum(price) }) : t('quota.free'))
      : '—'
    // 池空时不要再输出「≈0 分钟」这种噪音；直接说明池子已空更清楚。
    const exhausted = poolLeft != null && poolLeft <= 0 && hasPrice && price > 0
    chips.push(el('span', {
      class: `badge ${cls}`,
      style: 'margin:2px 4px 2px 0',
      title: tip,
    }, [
      // ⚠️ 这里以前是 `shortModel(model)` —— 对目录 key（m-00032eaeec）来说
      // "去 provider 前缀"是无效操作（它压根没有 `/`），于是裸 key 直接上屏。
      // 用户截图里那串 `m-00032eaeec 10 FB/h` 就是这么来的。改走统一的可读名。
      el('span', { class: 'muted' }, `${name} `),
      label,
      exhausted
        ? el('span', { class: 'muted' }, t('quota.poolEmpty'))
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
      t('quota.resetLine', { at: fmtReset(reset, resetTz), in: fmtCountdown(reset) }),
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
    hasPrice
      ? t('quota.priceTipBilling', { price: fmtNum(price) })
      : t('quota.noPriceShort'),
    m.limit != null ? t('quota.requestQuotaTip', { used: fmtNum(m.recentCount), limit: m.limit, pool: poolLabel(m.pool) }) : null,
    m.resetAt ? t('quota.resetLine', { at: fmtReset(m.resetAt, m.resetTimeZone), in: fmtCountdown(m.resetAt) }) : null,
  ].filter(Boolean).join('\n')
  if (!hasPrice) {
    return m.limit != null
      ? el('span', { class: 'badge ' + quotaBadgeClass(m), title: tip }, '—')
      : el('span', { class: 'muted', title: tip }, '—')
  }
  const cls = price <= 0 ? 'ok' : (price >= 50 ? 'err' : price >= 25 ? 'warn' : 'ok')
  return el('span', { class: `badge ${cls}`, title: tip },
    price > 0 ? t('quota.pricePerHour', { price: fmtNum(price) }) : t('quota.free'))
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
      return t('quota.resetLocalWithUpstream', { local, upstream: `${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${tzShort(timeZone)}` })
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
  if (ms <= 0) return t('quota.resetSoon')
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return t('dur.daysHoursAfter', { d, h: h % 24 })
  }
  return t('dur.hoursMinutesAfter', { h, m })
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

/**
 * 展示用的模型名：优先后端解析好的可读名（modelDisplayName），
 * 其次把目录 key（m-00032eaeec）换成显示名，最后才回落到原值。
 *
 * ⚠️ 上游回执侧（session.model / rateLimitsByModel / prices）用的全是
 * **目录 key**，直接显示就是 `m-00032eaeec` —— 用户看不出是哪个模型。
 * 涉及**请求/寻址**的地方绝不能用这个函数（那里要的是 key 本身）。
 * 桥接依据见
 * .agents/notes/implemented/bug-fix/2026-10-02-catalog-key-display-name-bridge.md
 * @param {{ session?: { model?: string }, modelDisplayName?: string } | null} a 账号行
 * @returns {string}
 */
function modelLabel(a) {
  const sess = a?.session
  const key = sess?.model
  if (!key) return '—'
  // 后端已解析的可读名优先（session.modelDisplayName），再用本地映射兜底，
  // 最后才落到短 key —— 与额度 chip 走**同一个**解析函数，避免两处口径分叉。
  return sess?.modelDisplayName || modelNameFor(key)
}

/** 目录 key → 显示名（用模型列表里已有的条目做本地兜底）。 */
function displayNameFor(key) {
  const hit = (state.models || []).find((m) => m.id === key)
  return hit?.display_name || hit?.displayName || null
}

/**
 * 把后端下发的「目录 key → 可读名」表并入本地缓存。
 *
 * 为什么是**合并**而不是替换：/api/overview 与 /api/accounts/refresh 各自只带
 * 当前那次快照里出现过的模型，直接替换会让上一次拿到的名字丢失，界面在两次
 * 刷新之间闪回裸 key。合并则只增不减，映射只会越来越全。
 * @param {{ modelNames?: Record<string, string>, upstreamModels?: Array<{key: string, displayName?: string|null}> }|null} payload
 */
function applyModelNames(payload) {
  if (!payload) return
  const incoming = payload.modelNames
  if (incoming && typeof incoming === 'object') {
    Object.assign(state.modelNames, incoming)
  }
  for (const row of payload.upstreamModels || []) {
    if (row && typeof row.key === 'string' && row.displayName) {
      state.modelNames[row.key] = row.displayName
    }
  }
}

/**
 * 上游给了额度的模型 —— 换算成 `/v1/models` 里实际会出现的 id。
 *
 * ⚠️ 注释里别写 `**` + `/v1/...`：`**` 紧邻斜杠会提前闭合块注释（这正是
 * 刚才写这行时踩到的语法错误）。
 *
 * 后端两个字段口径不同：`upstreamModelIds` 是目录 key（m-00032eaeec，判据真值），
 * `upstreamModels` 是带 catalogId/displayName 的三件套。而 /v1/models 的 id 由
 * `displayName || key` 决定（见 src/model.js 的 catalogDisplayName）。下拉按
 * `m.id` 比对打 ✅，所以这里必须做同样的换算，否则一个 ✅ 也标不出来。
 * @returns {Set<string>}
 */
function upstreamReadableIds() {
  const keys = state.upstreamModelIds || []
  const byKey = new Map((state.upstreamModels || []).map((r) => [r?.key, r]))
  const out = new Set()
  for (const key of keys) {
    const row = byKey.get(key)
    /**
     * ⚠️ 必须与后端的名称口径**逐字一致**：`displayName || key`。
     *
     * 此前这里写的是 `catalogId || displayName`，而**后端 `/api/models/upstream`
     * 的 `id` 用的是 `displayName`**（`catalogId` 只是 legacy 反查的并列字段，
     * 值其实是另一个东西 —— 实测 id='MiMo 2.6 Flash' 而 catalogId='mimo/mimo-v2.5'）。
     * 两边算出不同的 id → 测试对话下拉的 ✅ 一个也标不出来。
     *
     * 与 `src/model.js` 的 `catalogDisplayName()` 同源：displayName 优先，
     * 缺失才回退 key（不凭空编名字）。
     */
    out.add((row && (row.displayName || row.key)) || key)
  }
  /**
   * 目录驱动口径：后端 `/api/models` 的每条自带 `rate_limit`（有额度的才有），
   * 直接按它补充 ✅ 集合 —— 不必依赖 `upstreamModelIds` 那张单独的表。
   * （该表以前来自 session 回执的 rateLimitsByModel，只有 6 个键，用它标注
   * 会大面积漏标；清单现在以目录行为准。）
   */
  for (const m of state.catalogModels || []) {
    if (m && m.rate_limit && m.rate_limit.limit !== 0) out.add(m.id)
  }
  return out
}

/**
 * 额度 chip / 悬停提示里的模型标识 → 人能看懂的名字。
 *
 * 上游回执（rateLimitsByModel / freebucks.prices / session.model）给的全是
 * **目录 key**（m-00032eaeec），直接渲染出来用户根本认不出是哪个模型。
 * 取值顺序：后端随总览下发的映射 > 模型列表里的 display_name > 去掉 provider
 * 前缀的可读 id > 原值。**绝不返回空**——取不到名字就显示原 key，不隐藏信息。
 * @param {string} model
 * @returns {string}
 */
function modelNameFor(model) {
  if (!model) return ''
  const key = String(model)
  const mapped = state.modelNames && state.modelNames[key]
  if (mapped) return mapped
  const local = displayNameFor(key)
  if (local) return local
  // 已经是可读 id（deepseek/deepseek-v4-flash）时，至少去掉 provider 前缀
  return shortModel(key)
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
  const label = a.session?.model ? t('account.sessionWithModel', { model: modelLabel(a) }) : t('account.session')
  const tip = t('account.closeSessionConfirm', { email: a.email, label })
  if (!confirm(tip)) return
  const restore = withButtonLoading(btn)
  try {
    const r = await api(`/api/accounts/${encodeURIComponent(a.key)}/session`, {
      method: 'POST',
      body: JSON.stringify({ waitInFlightMs: 10000 }),
    })
    if (r.ok) {
      const extra = r.refund != null ? t('account.refundSuffix', { n: fmtNum(r.refund) }) : ''
      const cut = r.interrupted ? t('account.interrupted') : ''
      toast(t('account.sessionClosed', { email: a.email, extra, cut }))
    } else {
      toast(t('account.sessionCloseFailed', { msg: r.error || t('account.upstreamRejected') }), true)
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
  toast(t('account.cooldownCleared'))
  refreshAccountsCard()
}

async function removeAccount(email) {
  if (!confirm(t('account.deleteConfirm', { email }))) return
  await api(`/api/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' })
  toast(t('account.deleted'))
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
    el('h3', {}, t('account.credentialTitle', { email: account.email })),
    el('p', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:6px' }, [el('span', { class: 'spinner' }), t('common.loading')]),
  ])
  backdrop.append(body)
  document.body.append(backdrop)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove() })

  let res
  try {
    res = await api(`/api/accounts/${encodeURIComponent(account.key)}/credential`)
  } catch (err) {
    body.innerHTML = ''
    body.append(el('h3', {}, t('account.readFailed')), el('p', { class: 'muted' }, err.message))
    return
  }
  const cred = res.credential
  const json = JSON.stringify(cred, null, 2)
  const filename = `${cred.email || 'account'}-credential.json`

  body.innerHTML = ''
  body.append(
    el('h3', {}, t('account.credentialTitle', { email: cred.email })),
    el('p', { class: 'muted' }, t('account.credentialHint')),
    el('textarea', {
      id: 'cred-view',
      rows: 12,
      readonly: '',
      style: 'margin-top:8px',
    }),
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'primary', onclick: async () => {
        await navigator.clipboard.writeText(json).catch(() => {})
        toast(t('account.credentialCopied'))
      } }, [icon('copy', 14), t('account.copyJson')]),
      el('button', { onclick: () => downloadTextFile(filename, json) }, [icon('download', 14), t('account.downloadJson')]),
      el('button', { onclick: () => backdrop.remove() }, t('common.close')),
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
    el('h3', {}, t('account.addTitle')),
    el('p', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:6px' }, [el('span', { class: 'spinner' }), t('account.requestingLoginUrl')]),
  ])
  backdrop.append(body)
  document.body.append(backdrop)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove() })

  api('/api/accounts/login', { method: 'POST' }).then(({ flow }) => {
    body.innerHTML = ''
    body.append(
      el('h3', {}, t('account.addTitle')),
      el('p', { class: 'muted' }, t('account.openInBrowser')),
      el('div', { class: 'flow-url' }, flow.loginUrl),
      el('div', { class: 'row' }, [
        el('a', { style: 'display:inline-block', href: flow.loginUrl, target: '_blank', rel: 'noopener' }, el('button', { class: 'primary' }, [icon('globe', 14), t('account.openLink')])),
        el('span', { class: 'muted' }, t('account.autoRefresh')),
      ]),
      el('p', { id: 'flow-status', style: 'margin-top:12px', class: 'muted' }, t('account.waitingCallback')),
      el('button', { style: 'margin-top:8px', onclick: () => { api(`/api/accounts/login/${flow.id}/cancel`, { method: 'POST' }).catch(() => {}); backdrop.remove() } }, t('common.cancel')),
    )
    pollFlow(flow.id, body, backdrop)
  }).catch((err) => {
    /**
     * 三行信息，各司其职：
     *   1. 标题（`account.loginStartFailed`）
     *   2. `err.message` —— 含底层原始错误码（如 ECONNREFUSED），肉眼可见
     *   3. 按 `err.code` 给的可操作引导（而不是让用户对着 AbortError 猜）
     */
    body.innerHTML = ''
    const hint =
      err.code === 'upstream_timeout'
        ? t('account.loginHintTimeout')
        : err.code === 'upstream_network'
          ? t('account.loginHintNetwork')
          : null
    body.append(
      el('h3', {}, t('account.loginStartFailed')),
      el('p', { class: 'muted' }, err.message),
      // 原始错误码单独成行，便于复制排查（err.cause 来自后端 cause 字段）
      ...(err.cause ? [el('p', { class: 'muted' }, `cause: ${err.cause}`)] : []),
      ...(hint ? [el('p', { class: 'muted' }, hint)] : []),
    )
  })
}

async function pollFlow(id, body, backdrop) {
  try {
    const { flow } = await api(`/api/accounts/login/${id}`)
    const statusEl = body.querySelector('#flow-status')
    if (flow.status === 'done') {
      if (statusEl) {
        statusEl.textContent = ''
        statusEl.append(el('span', { class: 'badge ok' }, t('account.loginSuccess', { email: flow.user?.email || '', id: flow.user?.id ? t('account.loginIdSuffix', { id: flow.user.id }) : '' })))
      }
      toast(t('account.addedProbing', { email: flow.user?.email }))
      setTimeout(() => { backdrop.remove(); api('/api/accounts/probe', { method: 'POST' }).catch(() => {}).then(refreshOverviewAfterAccountChange) }, 1200)
      return
    }
    if (flow.status === 'expired' || flow.status === 'cancelled') {
      if (statusEl) statusEl.textContent = flow.error || t('account.loginCancelled')
      return
    }
    if (statusEl) statusEl.textContent = t('account.waitingCallbackPolling')
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
    el('h3', {}, t('account.import')),
    el('p', { class: 'muted' }, t('account.importJsonHint')),
    el('textarea', { id: 'import-json', rows: 8, placeholder: '{\n  "email": "you@example.com",\n  "authToken": "...",\n  "proxy": "http://127.0.0.1:7890"\n}' }),
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'primary', onclick: async () => {
        try {
          const json = $('#import-json').value
          await api('/api/accounts/import', { method: 'POST', body: JSON.stringify({ json }) })
          toast(t('account.importedProbing'))
          backdrop.remove()
          try { await api('/api/accounts/probe', { method: 'POST' }) } catch { /* ignore */ }
          refreshOverviewAfterAccountChange()
        } catch (err) { toast(err.message, true) }
      } }, [icon('box', 14), t('account.import')]),
      el('button', { onclick: () => backdrop.remove() }, t('common.cancel')),
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
    el('h2', { style: 'margin:0' }, t('user.management')),
    // 局部刷新必须是"原地更新"：早先直接 renderUsers(view) 会把 view 整个清空重渲染，
    // 用户看到的是"又新出一条栏目"（而它并不是真的刷新）。
    el('button', { class: 'muted', onclick: () => refreshUsersTable(view) }, [icon('refresh', 13), t('user.softRefresh')]),
  ]))
  state.users = (await api('/api/users')).data

  const table = el('div', { class: 'table-wrap', id: 'users-table' }, [
    el('table', {}, [
      el('thead', {}, el('tr', {}, [t('user.username'), t('user.role'), t('user.apiKey'), t('common.actions')].map((h) => el('th', {}, h)))),
      el('tbody', {}, state.users.map((u, i) => {
        return el('tr', { class: 'row-in', style: `animation-delay:${i * 40}ms` }, [
          el('td', {}, [
            u.username,
            u.username === state.me.username ? el('span', { class: 'muted', style: 'margin-left:4px' }, t('user.selfBadge')) : null,
          ]),
          el('td', {}, u.role === 'admin' ? el('span', { class: 'badge admin' }, 'admin') : el('span', { class: 'badge' }, 'user')),
          el('td', {}, el('div', { class: 'row' }, [
            el('code', { class: 'mono muted', style: 'font-size:12px' }, maskKey(u.apiKey)),
            el('button', { class: 'icon', title: t('user.copyFullKey'), onclick: async () => { await navigator.clipboard.writeText(u.apiKey).catch(() => {}); toast(t('user.keyCopied')) } }, icon('copy', 13)),
            el('button', { onclick: async () => {
              if (!confirm(t('user.resetKeyConfirm', { name: u.username }))) return
              const r = await api(`/api/users/${encodeURIComponent(u.username)}/reset-key`, { method: 'POST' })
              toast(t('user.newKey', { key: r.apiKey }))
              renderUsers(view)
            } }, t('common.reset')),
          ])),
          el('td', {}, el('div', { class: 'row' }, [
            el('button', { class: 'muted', onclick: () => openUserModal(u, view) }, t('user.changePassword')),
            u.username !== state.me.username
              ? el('button', { class: 'danger', onclick: async () => {
                  if (!confirm(t('user.deleteConfirm', { name: u.username }))) return
                  await api(`/api/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' })
                  renderUsers(view)
                } }, t('common.delete'))
              : null,
          ])),
        ])
      })),
    ]),
  ])
  view.append(el('div', { class: 'card', style: 'padding:0;overflow:hidden;margin-bottom:16px' }, table))

  const form = el('div', { class: 'card', id: 'users-new-card' }, [
    el('h3', { style: 'margin:0 0 8px' }, t('user.newUser')),
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(180px,1fr))' }, [
      el('div', {}, [el('label', {}, t('user.username')), el('input', { id: 'nu-user', placeholder: 'alice' })]),
      el('div', {}, [el('label', {}, t('user.initialPassword')), el('input', { id: 'nu-pass', placeholder: t('user.passwordPlaceholder') })]),
      el('div', {}, [el('label', {}, t('user.role')), el('select', { id: 'nu-role' }, [el('option', { value: 'user' }, 'user'), el('option', { value: 'admin' }, 'admin')])]),
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
        toast(t('user.created', { name: r.user.username, key: r.user.apiKey }))
        renderUsers(view)
      } catch (err) { toast(err.message, true) }
    } }, [icon('plus', 14), t('user.create')]),
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
    el('h3', {}, t('user.changePasswordTitle', { name: u.username })),
    el('label', {}, t('user.newPassword')),
    el('input', { id: 'pw-new', type: 'password' }),
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'primary', onclick: async () => {
        try {
          await api(`/api/users/${encodeURIComponent(u.username)}/password`, {
            method: 'POST',
            body: JSON.stringify({ password: $('#pw-new').value }),
          })
          toast(t('user.passwordUpdated'))
          backdrop.remove()
        } catch (err) { toast(err.message, true) }
      } }, [icon('check', 14), t('common.save')]),
      el('button', { onclick: () => backdrop.remove() }, t('common.cancel')),
    ]),
  ])
  backdrop.append(body)
  document.body.append(backdrop)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove() })
}

/* ---------------- playground ---------------- */
/**
 * 测试对话的模型下拉：**全量可用模型**，并且分级标注。
 *
 * 以前只留 `available !== false`，而 available 曾错误地由上游 accessTier 决定，
 * 于是 accessTier=limited 时整张表只剩 1 个模型（用户反馈的"只有一个模型"）。
 * 现在：
 *   - 目录条目一律可用（available 只表示'能不能请求'，见 src/model.js）；
 *   - 上游此刻真给了额度的模型（upstreamModelIds）标 ✅ 并排在最前；
 *   - 被「模型管理」隐藏的（hidden）压根不会出现在 /api/models 里；
 *   - 被一键屏蔽收费模型开关排除的 premium 模型也不在列表里。
 * 拿不到上游目录时**不隐藏任何模型**：宁可多列，也不让用户以为只剩一个。
 */
async function loadPlaygroundModels() {
  let models = []
  // 上游给了额度的模型：用**可读 id** 建集合（/api/models 的 id 现在是
  // catalogId / displayName / key 三选一，拿目录 key 直接比会全部漏标）。
  let upstreamIds = upstreamReadableIds()
  let note = ''
  try {
    const list = await api('/api/models')
    models = Array.isArray(list.data) ? list.data : []
    /**
     * 目录驱动：把本轮模型列表留档，`upstreamReadableIds()` 据此按
     * `rate_limit` 标 ✅（不再依赖只有 6 个键的 rateLimitsByModel）。
     */
    state.catalogModels = models
    if (Array.isArray(list.upstreamModelIds)) {
      state.upstreamModelIds = list.upstreamModelIds
    }
    if (Array.isArray(list.upstreamModels)) {
      state.upstreamModels = list.upstreamModels
    }
    upstreamIds = upstreamReadableIds()
    /**
     * ⚠️ notProbed 与"目录为空"是两回事：前者是**还没探测**（服务不自动探测，
     * docs/reverse/20 §20.3），出路是点「一键刷新」；后者才是真的没模型。
     * 混为一谈会让用户以为账号有问题。
     */
    if (!models.length) {
      note = list?.notProbed
        ? t('playground.notProbed')
        : t('playground.catalogEmpty')
    }
  } catch (err) {
    note = t('playground.catalogLoadFail', { msg: err.message })
  }
  // 排序：上游确有额度的在前（可直接用），其余按 id 稳定排序
  const scored = models.map((m) => ({ ...m, hasQuota: upstreamIds.has(m.id) }))
  scored.sort((a, b) => (Number(b.hasQuota) - Number(a.hasQuota)) || String(a.id).localeCompare(String(b.id)))
  return { models: scored, note, upstreamCount: upstreamIds.size }
}

async function renderPlayground(view) {
  view.innerHTML = ''
  const { models, note, upstreamCount } = await loadPlaygroundModels()

  view.append(el('div', { class: 'row spread', style: 'margin-bottom:16px' }, [
    el('h2', { style: 'margin:0' }, t('playground.title')),
    el('span', { class: 'muted' }, t('playground.subtitle')),
  ]))
  const defaultModel = models.find((m) => m.id === 'deepseek/deepseek-v4-flash') || models[0]
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr))' }, [
      el('div', {}, [
        el('label', {}, t('playground.modelSelect', { n: models.length, extra: upstreamCount ? t('playground.modelQuotaSuffix', { n: upstreamCount }) : '' })),
        el('select', { id: 'pg-model' }, models.map((m) => el('option', {
          value: m.id,
          selected: defaultModel && m.id === defaultModel.id,
        }, `${m.hasQuota ? '✅ ' : ''}${m.id}`))),
        el('div', { class: 'row', style: 'margin-top:6px;gap:8px;align-items:center' }, [
          el('button', { class: 'muted', style: 'padding:4px 10px;font-size:12px', onclick: (e) => reloadPlaygroundModels(e.currentTarget) },
            [icon('refresh', 12), t('playground.reloadModels')]),
          el('span', { class: 'muted', style: 'font-size:11px' }, t('playground.checkMark')),
        ]),
        note ? el('div', { class: 'muted', style: 'margin-top:4px;font-size:11px' }, note) : null,
      ]),
      el('div', {}, [
        el('label', {}, t('playground.apiKey')),
        el('input', { id: 'pg-key', value: state.me.apiKey, class: 'mono' }),
      ]),
    ]),
    el('label', {}, t('playground.message')),
    el('textarea', { id: 'pg-msg', rows: 4, placeholder: t('playground.messagePlaceholder') }),
    el('div', { class: 'row', style: 'margin-top:12px' }, [
      el('button', { class: 'primary', onclick: sendChat }, [icon('chat', 14), t('playground.send')]),
    ]),
    el('div', { class: 'chat-log', id: 'pg-log', style: 'margin-top:12px' }, ''),
  ])
  view.append(card)
}

/** 就地重建模型下拉（只替换 select 的选项，不清空已输入的消息/日志）。 */
async function reloadPlaygroundModels(btn) {
  const restore = withButtonLoading(btn)
  try {
    const { models, upstreamCount } = await loadPlaygroundModels()
    const sel = $('#pg-model')
    if (!sel) return
    const prev = sel.value
    const defaultModel = models.find((m) => m.id === 'deepseek/deepseek-v4-flash') || models[0]
    sel.replaceChildren(...models.map((m) => el('option', { value: m.id },
      `${m.hasQuota ? '✅ ' : ''}${m.id}`)))
    sel.value = models.some((m) => m.id === prev) ? prev : (defaultModel ? defaultModel.id : '')
    toast(t('playground.modelsReloaded', { n: models.length, extra: upstreamCount ? t('playground.modelsReloadedSuffix', { n: upstreamCount }) : '' }))
  } catch (err) {
    toast(err.message, true)
  } finally {
    restore()
  }
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
      log.append(el('div', { class: 'assistant', style: 'color:var(--red)' }, t('playground.errorPrefix') + msg))
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
    log.append(el('div', { style: 'color:var(--red)' }, t('playground.errorPrefix') + err.message))
  }
}

/* ---------------- me ---------------- */
async function renderMe(view) {
  view.innerHTML = ''
  const me = state.me
  const card = el('div', { class: 'card', style: 'max-width:720px' }, [
    el('div', { class: 'row spread', style: 'margin-bottom:16px' }, [
      el('h2', { style: 'margin:0' }, t('user.info')),
      el('span', { class: 'muted' }, me.role === 'admin' ? el('span', { class: 'badge admin' }, 'admin') : me.role),
    ]),
    // 定义列表
    el('div', { class: 'kv-list' }, [
      el('div', { class: 'kv' }, [el('span', { class: 'k muted' }, t('user.username')), el('span', { class: 'v' }, me.username)]),
      el('div', { class: 'kv' }, [el('span', { class: 'k muted' }, t('user.role')), el('span', { class: 'v' }, me.role === 'admin' ? t('user.roleAdmin') : t('user.roleUser'))]),
      el('div', { class: 'kv' }, [el('span', { class: 'k muted' }, t('user.scheduling')), el('span', { class: 'v' }, t('user.schedulingValue'))]),
    ]),
    // API Key 独立代码块
    el('label', { style: 'margin-top:20px' }, t('user.apiKeyBearer')),
    el('div', { class: 'key-block' }, [
      el('code', { class: 'mono', id: 'me-key', style: 'font-size:12px;word-break:break-all;flex:1;min-width:0' }, me.apiKey),
      el('button', { class: 'icon', title: t('common.copy'), onclick: async () => { await navigator.clipboard.writeText(me.apiKey).catch(() => {}); toast(t('common.copied')) } }, icon('copy', 14)),
    ]),
    el('p', { class: 'muted', style: 'margin-top:16px' }, t('user.downstreamHint')),
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
  // 语种必须在**首次 render 之前**定好：否则先渲染中文再切语言会闪一下。
  initLocale()
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
