import { t } from '../../../i18n.js'
import { api } from '../../../lib/api.js'
import { $, el } from '../../../lib/dom.js'
import { need } from '../../../lib/hooks.js'
import { fmtNum } from '../../../lib/format/quota.js'
import { applyModelNames, modelNameFor } from '../../../lib/format/models.js'
import { toast, withButtonLoading } from '../../../lib/ui.js'
import { state } from '../../../lib/state.js'
import { renderStatCards } from '../index.js'
import { applyAccountsSections } from './sections.js'
import { probeReason, buildAccountRow } from './row.js'

/**
 - 账号表局部刷新(不重建整个页面).
 - 默认不弹 toast:它常被操作成功后调用,一起弹会把"操作结果"顶掉
 - (实测点[关闭会话]后用户只看到"账号状态已刷新").要提示就由调用方自己弹.
 */
export async function refreshAccountsCard({ silent = true } = {}) {
  const wrap = $('#accounts-sections')
  if (!wrap) return need('render')()
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
    // 定点更新:复用现有分区外壳(保住展开状态/滚动位置),只换行.
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
 - 概览页 snapshot 型区块的定点刷新:统计卡,负载均衡条,账号池计数.
 - 都不重建页面,不动其它卡片.
 */
export function refreshSnapshotExtras(data) {
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
        style: `flex:${pct};background:${need('colorFor')(a.email)}`,
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
 - overview 局部刷新:只更新[账号池标题计数 + 统计卡 + 账号表],不重建页面布局.
 - 用于删除/导入账号,全部重连等会改变账号池结构,但页面骨架不变的操作.
 */
export async function refreshOverviewAfterAccountChange() {
  try {
    const data = await api('/api/overview')
    state.accounts = data.accounts
    applyModelNames(data)
    // 与 refreshAccountsCard 共用同一套定点更新(同一个 id 容器),
    // 绝不再用 $('.table-wrap') 去选"第一个分区的表",也不整块重建
    // (整块重建会重置分区的展开/折叠状态).
    applyAccountsSections(data.accounts)
    refreshSnapshotExtras(data)
  } catch (err) {
    toast(err.message, true)
  }
}

/** 单账号检测:只读拉取该账号状态/额度,判断可用/封禁/凭证失效 */
export async function probeAccount(a, btn) {
  const restore = withButtonLoading(btn)
  try {
    const r = await api(`/api/accounts/${encodeURIComponent(a.key)}/probe`, { method: 'POST' })
    // 先并入模型名映射:下面那行 toast 会打印每个模型的已用/上限,
    // 而它的键是目录 key —— 不先并表就又会把 m-00032eaeec 弹给用户.
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
 - 一键刷新(顶部主按钮):账号额度 + 探测状态 + 上游模型目录,一次全刷.
 *
 - 只读:不 admit,不 DELETE,不动任何 session 句柄.已付费的一小时
 - 不受影响(后端 /api/accounts/refresh 里逐条注释了这条硬约束).
 *
 - 全程局部更新:账号表分区外壳与展开状态,代理卡片,模型卡片都原地更新,
 - 不整页重建 —— 刷新前后用户视线所在的滚动位置和折叠状态都不变.
 */
export async function oneClickRefresh(btn) {
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
    need('refreshModelSettingsCard')().catch(() => {})
  } catch (err) {
    toast(err.message, true)
  } finally {
    restore()
  }
}

/** 全部账号探测(沿用原有逻辑 + 局部刷新) */
export async function probeAllAccounts(btn = null) {
  // 按钮由调用方显式传入(两个入口:页头[探测刷新]与账号卡[探测刷新]).
  // 不要去猜 activeElement:局部刷新后节点会被替换,猜到的往往是另一个按钮.
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
    } else need('render')()
  } catch (err) {
    toast(err.message, true)
  } finally {
    restore()
  }
}

/**
 - 概览里账号无关的区块定点刷新:统计卡 + 负载均衡条 + 账号池计数 +
 - 代理卡(空闲释放推荐值按账号池实时算).全部原地更新,不碰账号分区.
 */
export async function applyOverviewAndModelCards() {
  try {
    const data = await api('/api/overview')
    state.accounts = data.accounts
    applyModelNames(data)
    refreshSnapshotExtras(data)
  } catch { /* 拿不到就沿用当前快照 */ }
  try { await need('renderProxySettings')() } catch { /* 代理卡未挂载 */ }
}
