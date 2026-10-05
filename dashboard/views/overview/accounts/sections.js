import { t } from '../../../locale/index.js'
import { $, el } from '../../../lib/dom.js'
import { state } from '../../../lib/state.js'
import { buildAccountRow } from './row.js'


/**
 - 账号分区(用户口径):按"这个号现在处于什么处境"分组,默认只展开"正在调度",
 - 其余折叠----避免一屏全是已经被打废的号,把真正在干活的号淹掉.
 *
 - 顺序即优先级:封禁 > 额度不足 > 警告 > 正在调度 > 从未使用.判定按"最坏优先",
 - 一个号只出现在一个分区里(否则"已封禁"还会同时出现在"额度不足"里,看着像有救).
 *
 - label/hint 用 getter 而不是求值好的字面量:这个常量在模块加载时就定型,
 - 若此刻取文案,切换语言后分区标题会一直停在旧语种(要刷新页面才变).
 */
export const ACCOUNT_SECTIONS = [
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
 - [低额度]判定:余额低于阈值(可调,默认 15 FB),但还买得起当前模型.
 - 阈值来源:/api/settings 的 lowBalanceThreshold(0 = 关闭该分组).
 - 用户要这个分组的原因是[一眼看到快跑完的号]----所以它不影响调度,
 - 归到这里的号照常参与选号(这点和[额度不足]完全不同).
 */
export function lowBalanceHit(a) {
  const th = state.lowBalanceThreshold ?? 15
  if (!(th > 0)) return false
  const fb = a.freebucks
  if (!fb || fb.quotaExempt) return false
  // 今日池跑完 = 真的不能用 → 归 exhausted,不算[低额度]
  if (fb.daily && Number(fb.daily.remaining) <= 0 && Number(fb.daily.limit) > 0) return false
  const bal = Number(fb.balance)
  if (!Number.isFinite(bal)) return false
  // 买不起当前模型的不算(那是 exhausted)
  const price = fb.prices && a.session?.model ? fb.prices[a.session.model] : null
  if (price != null && bal < Number(price)) return false
  // [低于它无法使用就不纳入本组]:连最便宜的模型都买不起 = 实质不可用,
  // 归 exhausted.否则余额 0 的号会被标成[低额度],看着像还能救.
  const prices = fb.prices ? Object.values(fb.prices).map(Number).filter((n) => Number.isFinite(n) && n > 0) : []
  if (prices.length && bal < Math.min(...prices)) return false
  if (bal <= 0) return false
  return bal < th
}

/** 把一个账号归类到唯一分区(最坏优先). */
export function classifyAccount(a) {
  const probe = a.lastProbe && a.lastProbe.ok === false ? a.lastProbe : null
  const code = String(probe?.code || a.cooldownCode || '').toLowerCase()
  // 1) 封禁:探测明确 banned,账本记过 bannedAt,或后端已判 banned.
  //    注意 CDN 兜底:country_blocked 是出口风控,不是账号封禁,刻意不归这里.
  if (a.banned === true || a.bannedAt || code.includes('banned')) return 'banned'
  // 2) 额度不足:与后端的两道闸门严格对齐----
  //    ① Freebucks:今日池跑完(daily.remaining <= 0,且 limit > 0 才算真有池子)
  //       或余额买不起当前模型(balance < 单价);
  //    ② session_units:该模型时长额度用尽(recentCount >= limit,小数).
  //    前端先于后端修好过这条,而当时后端只判 ②,于是出现"控制台显示已用尽,
  //    调度器却仍把请求送上去"的错位;两处必须保持一致.
  //     两本账是并行的两道闸门(一笔会话两本账都扣,一手实测见
  //    docs/evidence/ledger-session-units-vs-freebucks.json),所以任一用尽都要归到这里.
  //     付费时段内不算[额度不足]:一次 admit 买断一小时,池子当场扣到 0
  //    之后这个小时仍然完全可用(rem=0 是"已付款"的正常状态,不是"用不了").
  //    少这一条会把正在被正常使用的账号标成[额度不足],并把它从"正在调度"里挤出去.
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
  // ② session_units 用尽(时长闸门):与后端 sessionUnitsFor 对齐,
  //     recentCount 是小数,边界必须用 >=.
  const uRow = a.quota && a.quota.byModel && a.session?.model ? a.quota.byModel[a.session.model] : null
  if (uRow) {
    const uLimit = Number(uRow.limit)
    const uUsed = Number(uRow.recentCount)
    if (Number.isFinite(uLimit) && uLimit > 0 && Number.isFinite(uUsed) && uUsed >= uLimit) {
      return 'exhausted'
    }
  }
  // 2.5) 低额度:余额低于用户设的阈值(默认 15 FB ≈ deepseek-v4-flash 单价),
  //      但还买得起当前模型----所以这不是故障,是[快见底了]的提前预警.
  //      注意必须排在[额度不足]之后:真买不起的号属于 exhausted,不该混进来.
  if (lowBalanceHit(a)) return 'lowbalance'
  // 3) 警告:探测失败(风控/限流/凭证)或正在冷却
  if (probe || a.cooldownUntil) return 'warning'
  // 4) 正在调度:有活跃/在途会话,或被选号过
  if (a.session?.live || a.used || a.requests > 0 || a.inFlight > 0) return 'active'
  // 5) 剩下的就是从未使用
  return 'fresh'
}

/** 账号 → 分区分组(一个号只落在一个分区里,最坏优先). */
export function groupAccounts(accounts) {
  const groups = new Map(ACCOUNT_SECTIONS.map((s) => [s.id, []]))
  for (const a of accounts) {
    const id = classifyAccount(a)
    ;(groups.get(id) || groups.get('fresh')).push(a)
  }
  return groups
}

/**
 - 分区的展开状态:用户的显式操作优先,其次才是章节默认值.
 - 读 state 而不是读 DOM ---- 分区可能因为这一轮没有任何账号而整个消失,
 - 消失期间也必须记住用户摊开过它.
 */
export function sectionOpen(section) {
  const v = state.acctSectionsOpen[section.id]
  return typeof v === 'boolean' ? v : Boolean(section.open)
}

/** 建一个分区外壳(details + summary + 表).新节点按记忆/默认值决定展开. */
export function buildAccountSection(section, rows) {
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
  // 记住用户的手动展开/折叠:这是唯一的状态写入点,刷新不会覆盖它.
  details.addEventListener('toggle', () => {
    state.acctSectionsOpen[section.id] = details.open
  })
  return details
}

export function buildAccountsTable(accounts) {
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
 - 账号分区定点更新(局部刷新的唯一入口).
 *
 - 为什么不能像以前那样 wrap.innerHTML = '' 再整块重建:那等于把整个列表
 - 换成一批全新的 <details>,一切纯 UI 状态随之归零 ---- 用户手动摊开的分区
 - 被折回去,滚动位置跳回顶部,正在看的行闪烁.用户明确要求刷新不得重置
 - 分组的展开/折叠状态.
 *
 - 做法:复用现有的 <details> 外壳(连同它的 open 状态),只替换 <tbody> 的行;
 - 用 append 移动节点来校正分区顺序(移动同一元素不会重置它的展开状态).
 - @returns {boolean} 是否命中容器(false = 容器不存在,调用方需整页回退)
 */
export function applyAccountsSections(accounts) {
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
    // append 对已存在的节点 = 移动到新位置,不重建,不重置展开状态.
    host.append(node)
  }
  for (const node of [...host.querySelectorAll('details.acct-section')]) {
    if (!keep.has(node.dataset.section)) node.remove()
  }
  return true
}
