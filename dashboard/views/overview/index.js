import { t } from '../../locale/index.js'
import { api } from '../../lib/api.js'
import { el, icon } from '../../lib/dom.js'
import { applyModelNames } from '../../lib/format/models.js'
import { state } from '../../lib/state.js'
import { endProgress, startProgress } from '../../lib/ui.js'
import { need } from '../../lib/hooks.js'
import { renderAccountsCard } from './accounts/index.js'
import { oneClickRefresh, probeAllAccounts } from './accounts/refresh.js'

export async function renderOverview(view) {
  view.innerHTML = ''
  // 骨架屏(首帧)
  view.append(skeletonOverview())
  startProgress()
  try {
    // 低额度分组阈值必须先于账号表拿到:账号表在 renderProxySettings 之前渲染,
    // 而阈值是在那里才读 /api/settings 的.若不在这里先取一次,首屏会恒定
    // 用默认 15 分组(用户改过阈值却看不到效果)----与推荐值那次是同一类数据依赖坑.
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
    await need('renderProxySettings')(view)
    await need('renderModelSettings')(view)
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
      el('h2', { style: 'margin:0 0 4px' }, t('overview.poolTitle', { n: data.accountCount })),
      el('span', { class: 'muted' }, t('overview.poolSubtitle', {
        apiBase: data.upstream.apiBase,
        models: data.models,
        dataDir: data.dataDir,
      })),
    ]),
    el('div', { class: 'row' }, [
      // 主操作 = 一键刷新:额度 + 账号状态 + 上游模型目录,一次全刷(只读).
      el('button', { class: 'primary', onclick: (e) => oneClickRefresh(e.currentTarget) },
        [icon('refresh', 14), t('overview.oneClickRefresh')]),
      el('button', { onclick: (e) => probeAllAccounts(e.currentTarget), title: t('overview.probeOnlyTip') },
        [icon('activity', 14), t('overview.probeRefresh')]),
      state.me.role === 'admin'
        ? el('div', { class: 'row' }, [
            el('button', { onclick: () => need('openImportModal')() }, [icon('box', 14), t('account.import')]),
            el('button', { class: 'primary', onclick: () => need('openAddAccount')() }, [icon('plus', 14), t('overview.addAccount')]),
          ])
        : null,
    ]),
  ])
}

/** 统计卡片 */
export function renderStatCards(data) {
  const total = data.accounts.length
  // 可用 = 无账号级冷却 且 未封禁.以前只看 available,会把已封禁的号
  // 算进"可用账号"里(banned 冷却 24h 到期后 available 又会变回 true).
  const banned = data.accounts.filter((a) => a.banned === true || a.bannedAt).length
  const available = data.accounts.filter((a) => a.available && !(a.banned === true || a.bannedAt)).length
  const cooldown = data.accounts.filter((a) => a.cooldownUntil && !a.banned).length
  const inFlight = data.accounts.reduce((n, a) => n + (a.inFlight || 0), 0)
  // 全局闸门占用:inFlight 贴着 limit 不动就是槽位泄漏(服务会"看着在跑
  // 却不接单").排队数 >0 说明已经在限流.
  const slots = data.slots || null
  const gateValue = slots ? `${slots.inFlight}/${slots.limit}` : String(inFlight)
  const gateFull = slots ? slots.inFlight >= slots.limit : false
  // 会话复用率 = "我们在省钱"的全局证据:一次 admit 就买断一小时,所以每次
  // 复用都是零边际成本的.复用率 = 复用次数 /(复用 + 新买).
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
      // 复用率越高 = 越少重复买整小时.hover 给出原始次数,便于核对.
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
      el('button', { onclick: () => need('openLoginFlow')(f) }, [icon('globe', 14), t('account.openLoginLink')]),
    ])),
  ]))
}
