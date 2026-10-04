import { t } from '../../../i18n.js'
import { el, icon } from '../../../lib/dom.js'
import { need } from '../../../lib/hooks.js'
import { state } from '../../../lib/state.js'
import { buildAccountsTable } from './sections.js'
import { refreshAccountsCard, oneClickRefresh, probeAllAccounts } from './refresh.js'

/** 账号表卡片(含每账号[检测]按钮) */
export async function renderAccountsCard(data) {
  const card = el('div', { class: 'card', style: 'margin-top:12px' })
  if (!data.accounts.length) {
    card.append(
      el('p', { style: 'margin:0 0 10px' }, t('account.emptyNoFreebuff')),
      state.me.role === 'admin'
        ? el('button', { class: 'primary', onclick: () => need('openAddAccount')() }, [icon('plus', 14), t('overview.addFirstAccount')])
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
        style: `flex:${pct};background:${need('colorFor')(a.email)}`,
        title: t('overview.shareBarTip', { email: a.email, pct, req: a.requests, total: totalReq }),
      }))
    }
    card.append(bar)
  }

  // 账号分区容器必须自带 id:局部刷新要按它整体替换.
  // 早先这里直接 append 一个没 id 的 div,刷新时用 $('.table-wrap') 选到的却是
  // 第一个分区里的表,把它替换成"整张新表",于是新表被塞进第一个 <details>
  // 里,旧分区原样留着——用户看到的就是[多出一条栏目,旧的没被删掉].
  card.append(el('div', { id: 'accounts-sections' }, buildAccountsTable(data.accounts)))
  return card
}
