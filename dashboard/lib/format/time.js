import { t } from '../../i18n.js'
import { el } from '../dom.js'
import { state } from '../state.js'


export function fmtMs(ms) {
  if (ms == null) return t('common.none')
  const m = Math.floor(ms / 60000)
  return t('dur.minutes', { n: m })
}

/**
 - 时长(毫秒)→ 人类可读:<1 分钟显示秒,<1 小时显示 m/s,否则 h/m.
 - 调度时长经常只有几十秒(短批量),fmtMs 一律显示 "0 分钟" 会看不出差别.
 */
export function fmtDurationMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '0'
  const s = Math.floor(n / 1000)
  if (s < 60) return t('dur.seconds', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('dur.minutesSeconds', { m, s: s % 60 })
  const h = Math.floor(m / 60)
  return t('dur.hoursMinutesShort', { h, m: m % 60 })
}

/** 时间戳 → 短格式(月-日 时:分),无值时 '—'. */
export function fmtTime(iso) {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 - 账号时间轴单元格:导入 / 更新 / 调度累计(+ 本轮实时).
 - 全部来自持久化账本(/data/account-state.json),重启/换容器都不丢.
 - 悬停显示完整本地时间,避免列太宽.
 */
export function accountTimeCell(a) {
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

/** 把分钟数渲染成人读时长:<1 分钟给秒,否则给[X 分][X 小时 Y 分]. */
export function fmtDuration(minutes) {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m <= 0) return t('dur.minutes', { n: 0 })
  if (m < 1) return t('dur.seconds', { n: Math.max(1, Math.round(m * 60)) })
  if (m < 60) return t('dur.minutes', { n: Math.round(m) })
  const h = Math.floor(m / 60)
  const rest = Math.round(m - h * 60)
  return rest ? t('dur.hoursMinutes', { h, m: rest }) : t('dur.hours', { h })
}

/** 距离重置还有多久(倒计时). */
export function fmtCountdown(iso) {
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

/** IANA 时区名 → 简短标识(America/Los_Angeles → LA). */
export function tzShort(timeZone) {
  const m = String(timeZone).split('/')
  return m[m.length - 1] || timeZone
}

/** 浏览器是否支持该 IANA 时区(RangeError 时回退本地时区). */
export function canUseTz(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export function firstReset(byModel) {
  const q = Object.values(byModel || {})[0]
  return q?.resetAt || null
}

export function firstResetTz(byModel) {
  const q = Object.values(byModel || {})[0]
  return q?.resetTimeZone || null
}

/**
 - 重置时刻展示:
 - - 主显示:浏览器本地时区的具体时刻(用户最直观)
 - - 附注:上游 resetTimeZone 的对应时刻 + 倒计时(明确"还有多久")
 - resetAt 是绝对 UTC 时刻,本地/LA 只是不同视角,绝无"不准"——差异来自时区换算.
 */
export function fmtReset(iso, timeZone) {
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
