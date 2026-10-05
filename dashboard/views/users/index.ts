import { t } from '../../locale/index.ts'
import { api } from '../../lib/api.ts'
import { $, el, icon } from '../../lib/dom.ts'
import { downloadTextFile } from '../../lib/boot/download.ts'
import { modelLabel } from '../../lib/format/models.ts'
import { fmtNum } from '../../lib/format/quota.ts'
import { state } from '../../lib/state.ts'
import { toast, withButtonLoading } from '../../lib/ui.ts'
import { need } from '../../lib/boot/hooks.ts'


/**
 - 主动关闭某账号的上游会话(操作列[]):用户明确要结束这条会话.
 - 上游按会话占用时长结算,早退 DELETE 就是"停止计费";有回复在传输时后端
 - 会先有界等待它结束(不硬掐断),超时仍在途则如实提示"已中断在途回复".
 */
export async function closeAccountSession(a: any, btn: any) {
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
    need('refreshAccountsCard')()
  } catch (err) {
    toast(err.message, true)
  } finally {
    restore()
  }
}

export async function clearCooldown(email: any) {
  await api(`/api/accounts/${encodeURIComponent(email)}/cooldown/clear`, { method: 'POST' })
  toast(t('account.cooldownCleared'))
  need('refreshAccountsCard')()
}

export async function removeAccount(email: any) {
  if (!confirm(t('account.deleteConfirm', { email }))) return
  await api(`/api/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' })
  toast(t('account.deleted'))
  need('refreshOverviewAfterAccountChange')()
}

export async function openCredentialModal(account: any) {
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

export function shortProxy(proxy: any) {
  const m = String(proxy || '').replace(/^https?:\/\//, '').replace(/^\/\//, '')
  return m.split('@').pop() || proxy
}

/* ---------------- add account (login flow) ---------------- */
export function openAddAccount() {
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
     - 三行信息,各司其职:
     - 1. 标题(account.loginStartFailed)
     - 2. err.message ---- 含底层原始错误码(如 ECONNREFUSED),肉眼可见
     - 3. 按 err.code 给的可操作引导(而不是让用户对着 AbortError 猜)
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
      // 原始错误码单独成行,便于复制排查(err.cause 来自后端 cause 字段)
      ...(err.cause ? [el('p', { class: 'muted' }, `cause: ${err.cause}`)] : []),
      ...(hint ? [el('p', { class: 'muted' }, hint)] : []),
    )
  })
}

async function pollFlow(id: any, body: any, backdrop: any) {
  try {
    const { flow } = await api(`/api/accounts/login/${id}`)
    const statusEl = body.querySelector('#flow-status')
    if (flow.status === 'done') {
      if (statusEl) {
        statusEl.textContent = ''
        statusEl.append(el('span', { class: 'badge ok' }, t('account.loginSuccess', { email: flow.user?.email || '', id: flow.user?.id ? t('account.loginIdSuffix', { id: flow.user.id }) : '' })))
      }
      toast(t('account.addedProbing', { email: flow.user?.email }))
      setTimeout(() => { backdrop.remove(); api('/api/accounts/probe', { method: 'POST' }).catch(() => {}).then(need('refreshOverviewAfterAccountChange')) }, 1200)
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

export function openLoginFlow(f: any) {
  window.open(f.loginUrl, '_blank', 'noopener')
}

/* ---------------- import account ---------------- */
export function openImportModal() {
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
          need('refreshOverviewAfterAccountChange')()
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
 - 用户表定点刷新:只更新表格与[新建用户]卡片,标题和页面骨架保持不动.
 - 早先[局部刷新]直接调 renderUsers(view)(先 view.innerHTML = '' 再重建),
 - 那不是刷新而是"重建整页",用户观感就是"又多出一条栏目".
 */
async function refreshUsersTable(view: any) {
  const oldTable = $('#users-table')
  if (!oldTable) return renderUsers(view)
  // 渲染进游离容器再取出新表替换旧表:标题,表单,滚动位置都不动,
  // 也绝不会有旧节点残留(游离容器里的东西不参与文档渲染).
  const holder = document.createElement('div')
  await renderUsers(holder)
  const fresh = holder.querySelector('#users-table')
  if (fresh) oldTable.replaceWith(fresh)
}

export async function renderUsers(view: any) {
  view.innerHTML = ''
  view.append(el('div', { class: 'row spread', style: 'margin-bottom:16px' }, [
    el('h2', { style: 'margin:0' }, t('user.management')),
    // 局部刷新必须是"原地更新":早先直接 renderUsers(view) 会把 view 整个清空重渲染,
    // 用户看到的是"又新出一条栏目"(而它并不是真的刷新).
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

function maskKey(key: any) {
  if (!key) return '—'
  return key.slice(0, 12) + '…' + key.slice(-4)
}

function openUserModal(u: any, view: any) {
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

export function colorFor(email: any) {
  let h = 0
  for (const ch of String(email)) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h}, 60%, 50%)`
}
