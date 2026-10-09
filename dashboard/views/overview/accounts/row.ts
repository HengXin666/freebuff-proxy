import { t } from '../../../locale/index.ts'
import { el, icon } from '../../../lib/dom.ts'
import { need } from '../../../lib/boot/hooks.ts'
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

/**
 * 每个账号的[调度]开关(管理员可点, 普通用户只读展示).
 *
 * 关掉的账号不进候选, 不被选号, 不 admit; 已买断的会话句柄保留不动,
 * 所以关开关不会把钱丢掉(那一小时照旧可用到自然过期).
 * @param {any} a 账号行
 * @returns {any} 开关元素
 */
function schedulingCell(a: any) {
  const on = a.schedulingEnabled !== false
  const tip = on ? t('account.schedulingOnTip') : t('account.schedulingOffTip')
  return el('label', {
    class: 'switch acct-switch',
    title: tip,
  }, [
    el('input', {
      type: 'checkbox',
      class: 'switch-input',
      'data-key': a.key,
      'aria-label': tip,
      ...(on ? { checked: '' } : {}),
      ...(state.me.role === 'admin' ? {} : { disabled: '' }),
      onchange: (e: any) => need('setAccountScheduling')(a.key, e.currentTarget.checked, e.currentTarget),
    }),
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
  ])
}

/**
 * 会话列的第 2/3 行: 已买断时段的标注 + 买过几条/复用几次.
 *
 * 单独成函数的是这两行: 它们回答"这条会话还能白用多久, 我们省在哪儿",
 * 与会话主体(模型 + 剩余时间)是两种信息.
 * @param {any} a 账号行
 * @param {boolean} paidBound 是否仍在已买断的一小时内
 * @param {number} admits 新建会话数
 * @param {number} reuses 复用次数
 * @returns {any[]} 若干 DOM 节点(无内容时为占位空串)
 */
function sessionMetaRows(a: any, paidBound: any, admits: any, reuses: any) {
  const reuseRate = admits + reuses > 0 ? Math.round((reuses / (admits + reuses)) * 100) : null
  const countsTip =
    t('account.countsTip', { admits, reuses }) +
    (reuseRate != null ? t('account.countsRate', { rate: reuseRate }) : '') +
    t('account.countsTipTail')
  return [
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
  ]
}

/**
 - 额度列: 本次刷新被跳过时先标一行[上次快照], 再显示额度本身.
 -
 - 标注存在的理由: 在途回复期间的刷新不会真的问上游(问了要顶掉活跃会话),
 - 界面若只是显示旧数字, 用户看到的就是"两次刷新两个版本"且毫无解释.
 - @param {any} a 账号行
 - @returns {any[]} 该单元格的节点
 */
function quotaCell(a: any) {
  return [
    a.probeSkipped
      ? el('div', {
          class: 'badge warn',
          style: 'font-size:10px;margin-bottom:2px',
          title: t('account.probeSkipped') + ' - ' + fmtTime(a.probeSkipped.at),
        }, t('account.probeSkippedBadge'))
      : '',
    fmtQuota(a.quota, a.freebucks),
  ]
}

/**
 * 账号列(邮箱 + 同邮箱标注 + 用户 ID + 最近使用).
 *
 * 单独成函数的理由: 同邮箱多身份的标注把这一格撑到十几行, 而 buildAccountRow
 * 已经贴着单函数 80 行的上限.
 * @param {any} a 账号行(runtimes.list() 的一项)
 * @param {number} sameEmailCount 同邮箱在池内出现的次数
 * @returns {any} td 节点
 */
function accountCell(a: any, sameEmailCount: any) {
  return el('td', {}, [
    a.email,
    /**
     * 同邮箱的另一个身份必须标出来.
     *
     * key 用 Freebuff 用户 id, 所以同一邮箱用 GitHub / Google 各登录一次就是
     * 两个独立账号(GitHub / Google 同邮箱不互斥, 见 src/auth-store/files.ts).
     * 不标出来时用户看到两行一模一样邮箱, 以为"账号重复了"或"被谁覆盖了".
     */
    sameEmailCount > 1
      ? el('span', {
          class: 'badge warn',
          style: 'margin-left:6px',
          title: t('account.sameEmailTip'),
        }, t('account.sameEmail'))
      : '',
    a.id && a.id !== a.email ? el('div', { class: 'muted', style: 'font-size:11px' }, `ID ${a.id}`) : '',
    a.lastUsed ? el('span', { class: 'badge ok', style: 'margin-left:6px' }, t('account.lastUsed')) : '',
  ])
}

/**
 - 账号表的一行.
 - @param {any} a 账号行(runtimes.list() 的一项)
 - @param {any} i 行序号(入场动画错峰用)
 - @param {number} sameEmailCount 同邮箱在池内出现的次数(>1 时挂[同邮箱]徽章)
 - @returns {any} tr 节点
 */
export function buildAccountRow(a: any, i: any, sameEmailCount = 0) {
  const cd = a.cooldownUntil ? new Date(a.cooldownUntil).toLocaleString() : null
  // Session 列同时回答两件事:(1) 这条会话还能白用多久;(2) 这个号
  // 到现在为止买过几条 / 复用了几次----后者是"我们在省钱"的直接证据,
  const admits = Number(a.admitCount) || 0
  const reuses = Number(a.reuseCount) || 0
  /**
   - [这一小时已买给模型 X]必须显示出来(issue #24).
   *
   *
   - 后端已给 session.inPaidWindow,这里据此加一行标注,把"还能用多久,
   - 只能用哪个模型,什么时候能换"讲清楚.
   */

  const paidBound = a.session?.live && a.session?.inPaidWindow === true
  const sess = el('div', {}, [
    // 这里显示的是给人看的模型名:a.session.model 是目录 key
    // (m-00032eaeec),必须换成可读名(MiMo 2.6 Flash).
    el('div', {}, a.session?.live
      ? `${modelLabel(a)} · ${fmtMs(a.session.remainingMs)}`
      : (a.session?.status === 'none' ? t('account.noActiveSession') : (a.session?.status || '—'))),
    ...sessionMetaRows(a, paidBound, admits, reuses),
    /**
     - 上游的会话清单(跨部署可见).
     *
     - 数据来自 GET /session 回执的 desktopPurchases----每次 admit/一键刷新
     - 都会随回执更新,所以刷新即可看到别的部署建的会话.
     *
     */
    ...renderUpstreamInventory(a),
  ])
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
    accountCell(a, sameEmailCount),
    el('td', {}, statusBadge),
    el('td', {}, schedulingCell(a)),
    el('td', { class: 'mono', style: 'font-size:12px' }, sess),
    el('td', { class: 'mono' }, `${a.inFlight || 0}/${a.concurrency || 1}`),
    accountTimeCell(a),
    el('td', {}, quotaCell(a)),
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
