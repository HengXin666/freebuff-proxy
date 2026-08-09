/* Freebuff Proxy 控制台 — 零依赖原生 JS SPA */
'use strict'

const state = { me: null, accounts: [], users: [], models: [], flows: [], proxies: [] }

const $ = (sel) => document.querySelector(sel)
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'html') node.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null) node.setAttribute(k, v)
  }
  for (const c of [].concat(children)) {
    if (c == null) continue
    node.append(c.nodeType ? c : document.createTextNode(String(c)))
  }
  return node
}

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

let toastTimer = null
function toast(msg, isErr = false) {
  const t = $('#toast')
  t.textContent = msg
  t.style.borderColor = isErr ? 'var(--red)' : 'var(--border)'
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200)
}

/* ---------------- render ---------------- */
async function render() {
  const app = $('#app')
  if (!state.me) {
    app.innerHTML = ''
    app.append(renderLogin())
    return
  }
  app.innerHTML = ''
  app.append(renderHeader())
  app.append(renderNav())
  const route = (location.hash || '#overview').slice(1) || 'overview'
  const view = document.createElement('div')
  app.append(view)
  if (route === 'users' && state.me.role === 'admin') await renderUsers(view)
  else if (route === 'playground') await renderPlayground(view)
  else if (route === 'me') await renderMe(view)
  else await renderOverview(view)
}

function renderLogin() {
  const wrap = el('div', { class: 'login-wrap' }, [
    el('h1', {}, '⚡ Freebuff Proxy'),
    el('div', { class: 'card' }, [
      el('label', {}, '用户名'),
      el('input', { id: 'login-user', autocomplete: 'username', placeholder: 'admin' }),
      el('label', {}, '密码'),
      el('input', { id: 'login-pass', type: 'password', autocomplete: 'current-password' }),
      el('div', { style: 'margin-top:16px' }),
      el('button', { class: 'primary', style: 'width:100%', onclick: doLogin }, '登 录'),
    ]),
    el('div', { class: 'hint' }, '首次部署的管理员账号/密码会打印在 docker compose logs 里'),
  ])
  return wrap
}

async function doLogin() {
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
    toast(err.message, true)
  }
}

function renderHeader() {
  return el('header', {}, [
    el('h1', {}, '⚡ Freebuff Proxy'),
    el('div', { class: 'spacer' }),
    el('span', { class: 'muted' }, `👤 ${state.me.username} ${state.me.role === 'admin' ? el('span', { class: 'badge admin' }, 'admin') : ''}`),
    el('button', { onclick: logout }, '退出'),
  ])
}

function renderNav() {
  const items = [['overview', '总览'], ['playground', '测试对话']]
  if (state.me.role === 'admin') items.push(['users', '用户管理'])
  items.push(['me', '我的'])
  const route = (location.hash || '#overview').slice(1) || 'overview'
  return el('nav', {}, items.map(([key, label]) =>
    el('button', {
      class: key === route ? 'active' : '',
      onclick: () => { location.hash = key },
    }, label),
  ))
}

function logout() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {})
  state.me = null
  location.hash = ''
  render()
}

/* ---------------- overview ---------------- */
async function renderOverview(view) {
  view.innerHTML = ''
  let data
  try { data = await api('/api/overview') } catch (err) { view.append(el('div', { class: 'card' }, err.message)); return }
  state.accounts = data.accounts

  const head = el('div', { class: 'row spread' }, [
    el('div', {}, [
      el('h2', { style: 'margin:0 0 4px' }, `账号池（${data.accountCount}）`),
      el('span', { class: 'muted' }, `上游 ${data.upstream.apiBase} · 模型 ${data.models} · 数据目录 ${data.dataDir}`),
    ]),
    el('div', { class: 'row' }, [
      el('button', { class: 'muted', onclick: async () => {
        toast('正在探测上游…')
        try {
          const r = await api('/api/accounts/probe', { method: 'POST' })
          state.accounts = r.accounts
          const failed = (r.results || []).filter((x) => !x.ok)
          toast(failed.length ? `探测完成，${failed.length} 个失败` : '探测完成（只读，不占额度）', !!failed.length)
        } catch (err) { toast(err.message, true) }
        render()
      } }, '探测刷新'),
      state.me.role === 'admin'
        ? el('div', { class: 'row' }, [
            el('button', { onclick: () => openImportModal() }, '导入账号'),
            el('button', { class: 'primary', onclick: () => openAddAccount() }, '+ 添加账号'),
          ])
        : null,
    ]),
  ])
  view.append(head)

  if (!data.accounts.length) {
    view.append(el('div', { class: 'card', style: 'margin-top:12px' }, [
      el('p', {}, '还没有 Freebuff 账号。'),
      state.me.role === 'admin'
        ? el('button', { class: 'primary', onclick: () => openAddAccount() }, '立即添加第一个账号')
        : el('p', { class: 'muted' }, '请联系管理员添加账号。'),
    ]))
  } else {
    // 负载均衡概览：各账号请求占比
    const totalReq = data.accounts.reduce((n, a) => n + (a.requests || 0), 0)
    if (totalReq > 0) {
      const bar = el('div', { style: 'display:flex;height:6px;border-radius:3px;overflow:hidden;margin:10px 0 2px' })
      for (const a of data.accounts) {
        if (!a.requests) continue
        const pct = Math.round((a.requests / totalReq) * 100)
        bar.append(el('div', {
          style: `width:${pct}%;background:${colorFor(a.email)}`,
          title: `${a.email} ${pct}%（${a.requests}/${totalReq}）`,
        }))
      }
      view.append(el('div', { class: 'card', style: 'margin-top:12px' }, [
        el('div', { class: 'row spread' }, [
          el('div', {}, [
            el('span', { class: 'muted' }, `负载均衡 · 共 ${totalReq} 次选号 `),
            el('span', { class: 'muted' }, '（会话级：不同会话按哈希摊开，同一会话固定账号；配额感知仅限额模型生效）'),
          ]),
          el('button', { class: 'muted', onclick: () => render() }, '刷新'),
        ]),
        bar,
      ]))
    }

    const table = el('table', {}, [
      el('thead', {}, el('tr', {}, ['账号', '状态', 'Session', '额度（今日）', '请求', '冷却', '操作'].map((t) => el('th', {}, t)))),
      el('tbody', {}, data.accounts.map((a) => {
        const cd = a.cooldownUntil ? new Date(a.cooldownUntil).toLocaleString() : null
        const sess = a.session?.live
          ? `${a.session.model} · ${fmtMs(a.session.remainingMs)}`
          : (a.session?.status === 'none' ? '无活跃' : (a.session?.status || '—'))
        return el('tr', {}, [
          el('td', {}, [
            a.email,
            a.id && a.id !== a.email
              ? el('div', { class: 'muted', style: 'font-size:11px' }, `ID ${a.id}`)
              : '',
            a.lastUsed ? el('span', { class: 'badge ok', style: 'margin-left:6px' }, '最近使用') : '',
          ]),
          el('td', {}, a.available
            ? el('span', { class: 'badge ok' }, '可用')
            : el('span', { class: 'badge err' }, cd ? `冷却至 ${cd}` : '冷却中')),
          el('td', { class: 'mono' }, sess),
          el('td', {}, fmtQuota(a.quota)),
          el('td', { class: 'mono' }, `${a.requests || 0} 次`),
          el('td', {}, cd ? el('span', { class: 'badge warn' }, a.cooldownCode || 'cooldown') : '—'),
          el('td', {}, state.me.role === 'admin' ? el('div', { class: 'row' }, [
            el('button', { class: 'muted', onclick: () => clearCooldown(a.key) }, '解除冷却'),
            el('button', { class: 'danger', onclick: () => removeAccount(a.key, a.email) }, '删除'),
          ]) : '—'),
        ])
      })),
    ])
    view.append(el('div', { class: 'card', style: 'margin-top:12px;overflow:auto' }, table))
  }

  // 代理设置（全局池，前端管理）
  await renderProxySettings(view)

  // login flows
  if (state.me.role === 'admin') {
    state.flows = (await api('/api/accounts/login')).data
    const activeFlows = state.flows.filter((f) => f.status === 'pending')
    if (activeFlows.length) {
      view.append(el('div', { class: 'card', style: 'margin-top:12px' }, [
        el('h3', { style: 'margin:0 0 8px' }, '等待中的登录'),
        ...activeFlows.map((f) => el('div', { class: 'row spread', style: 'padding:6px 0;border-bottom:1px solid var(--border)' }, [
          el('span', { class: 'muted' }, `发起于 ${new Date(f.createdAt).toLocaleString()}`),
          el('button', { onclick: () => openLoginFlow(f) }, '打开登录链接'),
        ])),
      ]))
    }
  }
}

/* ---------------- proxy settings ---------------- */
async function renderProxySettings(view) {
  let data = null
  try {
    data = await api('/api/proxy')
  } catch {
    data = { proxies: [], effective: [], accounts: [] }
  }
  state.proxies = data.proxies || []

  const card = el('div', { class: 'card', style: 'margin-top:12px' }, [
    el('div', { class: 'row spread' }, [
      el('div', {}, [
        el('h3', { style: 'margin:0 0 2px' }, '代理设置（全局代理池）'),
        el('span', { class: 'muted' }, '填一个或多个代理，保存立即生效；账号出口由系统内部分配（同一账号固定同一出口），无需逐个配置'),
      ]),
      el('button', { class: 'primary', onclick: saveProxyPool }, '保存并生效'),
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
      el('button', { onclick: () => runProxyTest($('#proxy-test-url').value.trim() || null) }, '测 试'),
      el('button', { class: 'muted', onclick: () => runProxyTest(null) }, '测试已配置'),
    ]),
    el('div', { id: 'proxy-test-result', style: 'margin-top:8px' }),
    data.effective && data.effective.length
      ? el('div', { class: 'muted', style: 'margin-top:8px' }, `当前生效代理：${data.effective.map(shortProxy).join('、')}`)
      : null,
  ])
  view.append(card)
}

async function saveProxyPool() {
  const textarea = $('#proxy-pool')
  if (!textarea) return
  const proxies = textarea.value.split('\n').map((x) => x.trim()).filter(Boolean)
  try {
    const r = await api('/api/proxy', { method: 'POST', body: JSON.stringify({ proxies }) })
    toast(r.note || '已保存')
    render()
  } catch (err) {
    toast(err.message, true)
  }
}

async function runProxyTest(proxy) {
  const box = $('#proxy-test-result')
  if (!box) return
  box.innerHTML = ''
  box.append(el('span', { class: 'muted' }, '测试中…（最多 ~12s/个）'))
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
        ? el('span', { class: 'badge ok' }, '✅ 可用')
        : el('span', { class: 'badge err' }, '❌ 不可用')
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

/** 每个模型的每日免费 session 额度：已用/上限，以及重置时间 */
function fmtQuota(quota) {
  if (!quota || !quota.byModel || !Object.keys(quota.byModel).length) {
    return el('span', { class: 'muted', title: '尚无额度数据：账号首次 admit（发起对话/创建 session）后上游才会返回限额；可先点「探测刷新」查看 session 状态' }, '—')
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
      title: `${model} · ${used}/${q.limit} 次/日 · 重置 ${fmtReset(q.resetAt)}`,
    }, `${shortModel(model)} ${used}/${q.limit}`))
  }
  const reset = quota.rateLimit?.resetAt || firstReset(quota.byModel)
  return el('div', {}, [
    el('div', {}, chips),
    reset ? el('div', { class: 'muted', style: 'margin-top:2px' }, `重置 ${fmtReset(reset)}`) : null,
  ])
}

function firstReset(byModel) {
  const q = Object.values(byModel || {})[0]
  return q?.resetAt || null
}

function fmtReset(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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
  render()
}

async function removeAccount(email) {
  if (!confirm(`确认删除账号 ${email}？`)) return
  await api(`/api/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' })
  toast('已删除')
  render()
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
    el('p', { class: 'muted' }, '服务端正在向 Freebuff 申请登录链接…'),
    el('div', { class: 'spinner' }),
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
        el('a', { class: 'primary', style: 'display:inline-block', href: flow.loginUrl, target: '_blank', rel: 'noopener' }, el('button', { class: 'primary' }, '打开链接并登录')),
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
      setTimeout(() => { backdrop.remove(); api('/api/accounts/probe', { method: 'POST' }).catch(() => {}).then(render) }, 1200)
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
          render()
        } catch (err) { toast(err.message, true) }
      } }, '导入'),
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
  state.users = (await api('/api/users')).data
  view.append(el('h2', { style: 'margin:0 0 12px' }, '用户管理'))

  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, ['用户名', '角色', 'API Key', '操作'].map((t) => el('th', {}, t)))),
    el('tbody', {}, state.users.map((u) => {
      return el('tr', {}, [
        el('td', {}, `${u.username} ${u.username === state.me.username ? el('span', { class: 'muted' }, '(我)') : ''}`),
        el('td', {}, u.role === 'admin' ? el('span', { class: 'badge admin' }, 'admin') : el('span', { class: 'badge' }, 'user')),
        el('td', {}, el('div', { class: 'row' }, [
          el('code', { class: 'mono muted', style: 'font-size:12px' }, maskKey(u.apiKey)),
          el('button', { onclick: async () => { await navigator.clipboard.writeText(u.apiKey).catch(() => {}); toast('已复制完整 Key') } }, '复制'),
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
  ])
  view.append(el('div', { class: 'card', style: 'overflow:auto;margin-bottom:16px' }, table))

  // create user
  const form = el('div', { class: 'card' }, [
    el('h3', { style: 'margin:0 0 8px' }, '新建用户'),
    el('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr 1fr' }, [
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
    } }, '创建用户'),
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
      } }, '保存'),
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

  view.append(el('h2', { style: 'margin:0 0 12px' }, '测试对话'))
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr' }, [
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
      el('button', { class: 'primary', onclick: sendChat }, '发送'),
      el('span', { class: 'muted' }, '经 /v1/chat/completions 真实转发（流式）'),
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
  log.append(el('div', { class: 'user' }, '▶ ' + raw.split('\n')[0] + (raw.split('\n').length > 1 ? ' …' : '')))
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
    let out = el('div', { class: 'assistant' }, '')
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
  } catch (err) {
    log.append(el('div', { style: 'color:var(--red)' }, '错误: ' + err.message))
  }
}

/* ---------------- me ---------------- */
async function renderMe(view) {
  view.innerHTML = ''
  const me = state.me
  const card = el('div', { class: 'card', style: 'max-width:560px' }, [
    el('h2', { style: 'margin:0 0 12px' }, '我的信息'),
    el('div', { class: 'row' }, [el('span', { class: 'muted' }, '用户名'), el('span', {}, me.username)]),
    el('div', { class: 'row' }, [el('span', { class: 'muted' }, '角色'), el('span', {}, me.role)]),
    el('div', { class: 'row' }, [
      el('span', { class: 'muted' }, 'API Key'),
      el('code', { class: 'mono' }, me.apiKey),
      el('button', { onclick: async () => { await navigator.clipboard.writeText(me.apiKey).catch(() => {}); toast('已复制') } }, '复制'),
    ]),
    el('div', { class: 'row' }, [
      el('span', { class: 'muted' }, '会话调度'),
      el('span', {}, '热会话优先：同模型请求复用现有会话，故障时自动切换账号'),
    ]),
    el('p', { class: 'muted', style: 'margin-top:14px' }, '下游 Agent 接入：把上面 API Key 作为 Bearer token，base_url 指向本服务，例如'),
    el('pre', { class: 'flow-url' }, 'curl http://127.0.0.1:8787/v1/chat/completions \\\n  -H "Authorization: Bearer ' + (me.apiKey || 'sk-fb-…') + '" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}],"stream":true}\''),
  ])
  view.append(card)
}

/* ---------------- boot ---------------- */
window.addEventListener('hashchange', render)
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const { user } = await api('/api/me')
    state.me = user
  } catch {
    state.me = null
  }
  render()
})
