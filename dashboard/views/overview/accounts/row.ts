import { t } from '../../../locale/index.ts'
import { el, icon } from '../../../lib/dom.ts'
import { need } from '../../../lib/hooks.ts'
import { modelLabel, modelNameFor } from '../../../lib/format/models.ts'
import { fmtFreebucks, fmtQuota } from '../../../lib/format/quota.ts'
import { accountTimeCell, fmtMs, fmtTime } from '../../../lib/format/time.ts'
import { state } from '../../../lib/state.ts'

/**
 - 渲染上游的会话清单(session.inventory)---- 跨部署可见的那份.
 *
 - 数据源:上游 GET /session 回执的 desktopPurchases(每次 admit / 一键刷新
 - 随回执刷新).槽位 slotLimit:1,被别处占着时请求会撞 purchase_capacity,
 - 而本地账本会说"没有会话" ---- 这行就是用来消除那个困惑的.
 *
 - 标注[本机]:把每个占用者的 holderInstanceId 与本地会话的 instanceId 比,
 - 相同即本机建的(这样用户一眼看出"占着槽位的是不是我自己").
 - @param {any} a 账号行(runtimes.list() 的一项)
 - @returns {any[]} 若干 DOM 节点
 */
export function renderUpstreamInventory(a: any) {
  const inv = a?.session?.inventory
  const purchases = Array.isArray(inv?.purchases) ? inv.purchases : []
  if (!purchases.length) return []
  const mine = a?.session?.instanceId || null
  const now = Date.now()
  const live = purchases.filter(
    (p: any) => !p.expiresAt || Date.parse(p.expiresAt) > now,
  )
  if (!live.length) return []
  const nodes = [
    el('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' },
      t('account.upstreamInventory', { n: live.length })),
  ]
  for (const p of live) {
    const isMine = mine && p.holderInstanceId === mine
    // 模型名走统一映射(目录 key → 可读名),不再把 m-xxx 弹给用户
    const name = modelNameFor(p.model) || p.model || '?'
    nodes.push(
      el('div', {
        class: 'muted',
        style: 'font-size:11px',
        title: t('account.upstreamInventoryTip', {
          holder: p.holderInstanceId || '—',
          until: p.expiresAt ? fmtTime(p.expiresAt) : '—',
        }),
      }, [
        el('span', { class: isMine ? 'badge ok' : 'badge warn' },
          isMine ? t('account.inventoryMine') : t('account.inventoryOther')),
        ' ',
        `${name} · ${p.expiresAt ? fmtMs(Date.parse(p.expiresAt) - now) : '—'}`,
      ]),
    )
  }
  return nodes
}

export function buildAccountRow(a: any, i: any) {
  const cd = a.cooldownUntil ? new Date(a.cooldownUntil).toLocaleString() : null
  // Session 列同时回答两件事:(1) 这条会话还能白用多久;(2) 这个号
  // 到现在为止买过几条 / 复用了几次----后者是"我们在省钱"的直接证据,
  // 因为复用发生在已买断的一小时内,边际成本为 0.
  const admits = Number(a.admitCount) || 0
  const reuses = Number(a.reuseCount) || 0
  const reuseRate =
    admits + reuses > 0 ? Math.round((reuses / (admits + reuses)) * 100) : null
  const countsTip =
    t('account.countsTip', { admits, reuses }) +
    (reuseRate != null ? t('account.countsRate', { rate: reuseRate }) : '') +
    t('account.countsTipTail')
  /**
   - [这一小时已买给模型 X]必须显示出来(issue #24).
   *
   - 此前这条会话显示成 MiMo 2.6 Flash . 50 分钟----看着完全正常,但它
   - 只服务这一个模型:此时请求任何别的模型都会被上游拒(实测
   - purchase_claim_released,且 DELETE 之后接不回来),而面板仍写 status=ok.
   - 用户对着"正常"去查一个根本没坏的账号,排障只能翻日志.
   *
   - 后端已给 session.inPaidWindow,这里据此加一行标注,把"还能用多久,
   - 只能用哪个模型,什么时候能换"讲清楚.
   */

  const paidBound = a.session?.live && a.session?.inPaidWindow === true
  const sessNode = el('div', {}, [
    // 这里显示的是给人看的模型名:a.session.model 是目录 key
    // (m-00032eaeec),必须换成可读名(MiMo 2.6 Flash).
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
    /**
     - 上游的会话清单(跨部署可见).
     *
     - 用户诉求:[即便分布式部署,你在本地建的会话,我在远程也能读到].
     - 数据来自上游 GET /session 回执的 desktopPurchases----每次 admit/一键刷新
     - 都会随回执更新,所以刷新即可看到别的部署建的会话.
     *
     - 为什么要显示:槽位 slotLimit:1,被别处占着时请求会撞
     - purchase_capacity,而本地账本显示"没有会话" ---- 用户完全无从判断.
     - 这里如实列出占用者与到期时间,并标出是不是本机建的.
     */
    ...renderUpstreamInventory(a),
  ])
  const sess = sessNode
  // 探测失败原因(country_blocked 强风控 / rate_limited / banned / 凭证无效...)
  const probeFail = a.lastProbe && a.lastProbe.ok === false ? a.lastProbe : null
  const probe = probeFail ? probeReason(probeFail.code, probeFail.message) : null
  /**
   - 状态徽章分三档(用户要求:刷新后至少能区分 ban 和正常):
   - banned(红 . 不可恢复)/ unavailable(黄 . 暂时被拒,冷却到期自愈)/ ok(绿).
   - 判定优先用后端给的 banned/unavailable 字段(与调度器同一套 code),
   - 老版本后端没有这两个字段时按 available 兜底,不会崩.
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
  // 探测失败的具体原因比笼统的"不可用"更有信息量,覆盖之(但 ban 优先级最高).
  if (!banned && probe) {
    statusLabel = probe.label
    statusTip = probe.tip
    statusCls = 'badge err'
  }
  const statusBadge = el('span', { class: statusCls, style: 'display:inline-flex', title: statusTip },
    [statusDot, statusLabel])
  const hasSession = Boolean(a.session?.live)
  const ops = el('div', { class: 'row', style: 'gap:6px' }, [
    el('button', { class: 'icon muted', title: t('account.probeTitle'), onclick: (e: any) => need('probeAccount')(a, e.currentTarget) }, icon('activity', 14)),
    hasSession
      ? el('button', { class: 'icon', title: t('account.closeSessionTitle'), onclick: (e: any) => need('closeAccountSession')(a, e.currentTarget) }, icon('x', 14))
      : null,
    state.me.role === 'admin'
      ? el('button', { class: 'icon muted', title: t('account.clearCooldownTitle'), onclick: () => need('clearCooldown')(a.key) }, icon('zap', 14))
      : null,
    el('button', { class: 'icon muted', title: t('account.credentialButtonTitle'), onclick: () => need('openCredentialModal')(a) }, icon('key', 14)),
    state.me.role === 'admin'
      ? el('button', { class: 'icon danger', title: t('account.deleteTitle'), onclick: () => need('removeAccount')(a.key, a.email) }, icon('trash', 14))
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
    // a.session.model 是目录 key(m-00032eaeec);可读名由后端解析并放在
    // session.modelDisplayName(AccountRuntimes.list() 统一带上).
    //  之前写成 a.modelDisplayName(顶层)---- 字段不在顶层,永远取不到,
    // 于是这一列一直回落成裸 key.拿到不到就回落到 key,绝不显示空.
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
 - 探测失败原因 → 可读文案(强风控国家封锁 / 限流 / 封禁 / 凭证无效等).
 - label 用于徽章短标签,tip 是 tooltip 完整原因.
 */
export function probeReason(code: any, message: any) {
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
   - 401 单独判,且只认真正的鉴权失败.
   *
   - 此前写成 c.includes('unauthorized') || c.includes('invalid') || c.includes('401')
   - ---- 宽匹配把任何含这些子串的 code 都判成[凭证无效],而[凭证无效]
   - 在控制台上的含义是"这个号要重新登录",处置成本最高(要用户去浏览器重登
   - 再导入).真因若是别的,用户就照着错的提示白折腾一遍.
   *
   - 现在:后端已把 session 401 归一成 auth_unauthorized(见
   - upstream/client.js 的 401 分支),这里按精确 code 命中,并把上游原文
   - ("Invalid API key" / "Missing or invalid Authorization header")带进 tip.
   - 拿不到结构化 code 的老后端仍靠上游原文兜底,不退化成"未知原因".
   */
  if (c === 'auth_unauthorized' || /unauthorized|invalid api key|missing or invalid authorization/.test(c + ' ' + msg.toLowerCase())) {
    return { label: t('account.probeInvalidCred'), tip: t('account.probeInvalidCredTip', { msg }) }
  }
  return { label: t('account.probeFailed'), tip: msg }
}
