/**
 - 人类可读格式化(duration / number / time / countdown) -- 从 bin/pricing.ts 逐字搬出.
 - 上游 resetAt 是 ISO, 别让用户自己算时区.
 */

/**
 - 把分钟数写成[1 小时 5 分]这类人话; 不足 1 分钟显示 <1 分钟.
 - @param {number} minutes 分钟数
 - @returns {string} 人类可读的时长
 */
export function fmtDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '—'
  if (minutes === 0) return '0 分钟'
  if (minutes < 1) return '<1 分钟'
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (!h) return `${m} 分钟`
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

/**
 - 数字: 整数原样, 小数去掉尾随零.
 - @param {number} n 数值
 - @returns {string} 人类可读的数字
 */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')
}

/**
 - 本地时区的可读时间(上游 resetAt 是 ISO, 别让用户自己算时区).
 - @param {string|null} [iso] ISO 时间
 - @returns {string} 本地时区可读时间
 */
export function fmtTime(iso?: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return String(iso)
  const d = new Date(t)
  const pad = (x: number): string => String(x).padStart(2, '0')
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${ymd} ${hm}（本地时区）`
}

/**
 - 距重置时间的倒计时.
 - @param {string|null} [iso] ISO 时间
 - @returns {string} 倒计时文案(无值返回空串)
 */
export function fmtCountdown(iso?: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.floor((t - Date.now()) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h} 小时 ${m} 分后重置` : `${m} 分钟后重置`
}
