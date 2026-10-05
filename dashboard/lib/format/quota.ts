import { t } from '../../locale/index.ts'
import { el } from '../dom.ts'
import { modelNameFor, poolLabel } from './models.ts'
import { firstReset, firstResetTz, fmtCountdown, fmtDuration, fmtReset } from './time.ts'


export function fmtNum(n: any) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return String(Math.round(v * 100) / 100)
}

/**
 - 额度徽章颜色:用尽=红,余量≤2=黄,其余=绿.
 - 注意 recentCount 在按时长结算时是小数(admit 预占,提前释放按实际占用
 - 结算),所以这里保留小数,不用 ceil 抹平----否则 0.1 次会被显示成"已用 1 次".
 */
export function quotaBadgeClass(m: any) {
  const used = Math.max(0, Number(m.recentCount) || 0)
  const limit = Number(m.limit)
  if (!Number.isFinite(limit) || limit <= 0) return ''
  const left = limit - used
  return left <= 0 ? 'err' : left <= 2 ? 'warn' : 'ok'
}

/**
 - Freebucks 计量展示(上游 2026-09 改版).
 *
 - 口径 = 买断一小时:admit 时按[模型单价(Freebucks/小时)]预扣整小时,
 - 这一小时内可无限复用.提前 DELETE 只回 freebucksRefundPending,实测 2 分钟
 - 内未到账;而 session_units 那本账是当场按比例退的.所以释放时机按[付费时段内
 - 不释放]处理(见 docs/freebucks-strategy.html).
 - 这里不再说"今天用了几次会话",而是直接回答[这个号还能用多久]:
 - 余额 N FB . 单价 N/h . ≈可用 M 分钟 . 今日 剩余/上限
 - 金额单位是 Freebucks,时长单位是分钟(<1 分钟显示秒).
 */
export function fmtFreebucks(fb: any, currentModel: any, lastRefund: any) {
  if (!fb) return el('span', { class: 'muted' }, '—')
  const price = currentModel && fb.prices ? fb.prices[currentModel] : null
  const reset = fb.daily?.resetAt ? new Date(fb.daily.resetAt) : null
  /** 余额(或今日池余额)按单价折算的可用时长. */
  const minutes = (amount: any) =>
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

/**
 - 每个模型的每日额度:已用/上限 + 重置时间.
 - 口径是[占用的时长]不是[几次]:上游按 session 时长结算,admit 先预占
 - 1 小时,提前释放按实际占用回填,所以 recentCount 是小数(如 0.4/6 = 用了 24
 - 分钟).这里保留小数(最多两位),不再 ceil 成整数.
 */
export function fmtQuota(quota: any, fb: any) {
  const byModel = quota?.byModel || {}
  if (!Object.keys(byModel).length) {
    return el('span', { class: 'muted', title: t('quota.noDataTip') }, t('common.none'))
  }
  // 计费口径(2026-09):上游按会话实际占用时长结算 Freebucks,每模型单价
  // 由 freebucks.prices 给出(N FB/小时).所以这里显示 FB,不再显示[次数].
  // 诚实边界:上游只提供账号级 daily.spent,没有按模型的消耗明细----
  // 因此每模型能展示的是[单价]+[今日池折算的可用时长],不编造每模型已用量.
  const prices = fb && fb.prices ? fb.prices : null
  const poolLeft = fb && fb.daily ? Number(fb.daily.remaining) : null
  const chips = []
  for (const [model, q0] of Object.entries(byModel)) {
    if (!q0) continue
    const q: any = q0
    const price = prices ? prices[model] : null
    const hasPrice = Number.isFinite(price)
    // 可用时长:今日池余额 ÷ 单价
    const pool = Number.isFinite(poolLeft) ? (poolLeft as number) : null
    const minutes =
      hasPrice && price > 0 && pool != null
        ? (pool / price) * 60
        : null
    // 颜色:池子见底=红;连 1 小时都买不起=黄;其余绿
    const cls = pool != null && pool <= 0
      ? 'err'
      : (hasPrice && pool != null && pool < price ? 'warn' : 'ok')
    // 悬停提示首行给人看的名字在前,服务端标识在后:排障时仍要能对上上游日志.
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
    // 池空时不要再输出[≈0 分钟]这种噪音;直接说明池子已空更清楚.
    const exhausted = poolLeft != null && poolLeft <= 0 && hasPrice && price > 0
    chips.push(el('span', {
      class: `badge ${cls}`,
      style: 'margin:2px 4px 2px 0',
      title: tip,
    }, [
      //  这里以前是 shortModel(model) ---- 对目录 key(m-00032eaeec)来说
      // "去 provider 前缀"是无效操作(它压根没有 /),于是裸 key 直接上屏.
      // 用户截图里那串 m-00032eaeec 10 FB/h 就是这么来的.改走统一的可读名.
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
 - 模型管理表的[额度]列:显示 Freebucks 单价(FB/小时),不再显示次数.
 - 上游按会话实际占用时长结算,单价才是决定"这个模型多贵"的量;旧的
 - 已用/上限 次数口径已不再对应用户实际关心的消耗.限额仍保留在悬停提示里.
 */
export function fmtModelPrice(m: any) {
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
