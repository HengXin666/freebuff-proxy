/**
 * 目录新鲜度判据, 以及跨代次/跨进程该带哪个模型标识.
 *
 * handle 是[单次目录抓取的票据]: 服务端每次抓取全量轮换它(key / displayName /
 * legacyDigests 稳定, handle 不稳定 ---- docs/reverse/19 §19.3). 目录响应因此自带
 * refreshAt, 它存在的唯一理由就是告诉客户端"这份句柄到期了, 该重抓".
 *
 * 旧行为把 refreshAt 解析进字段却没人读 ---- 目录一旦到手就永不按它过期, 直到别的
 * 入口(控制台[同步上游模型])强制刷新. 真机证据(2026-10-05, 远程 2.3.0):
 * 服务 17:19 抓的目录是 version e82926, 上游当前已是 e82927, 于是主服务把服务端
 * 指派的 key 解析成上一代句柄; bun 子进程每次都重抓(拿到 e82927), 拿着上一代句柄
 * 在它那份表里找 -> 29/29 model not found in catalog -> 降级 legacy -> 上游 428
 * waiting_room_required. 两侧目录原本都健康, 差异只来自"抓取时刻不同".
 *
 * 由此定下两条: ① 过期的目录必须重抓; ② 跨进程边界带 key(稳定身份), 不带 handle
 * (票据) ---- 谁重抓谁解析.
 *
 * 见 .agents/notes/implemented/bug-fix/2026-10-06-catalog-handle-generation.md
 */
import { isModelHandle } from '../protocol/constants.ts'

/**
 * 目录是否已过服务端给的刷新时刻.
 *
 * 回执缺 refreshAt(老版本 / 夹具)时永远不算过期 ---- 判据只能来自服务端明文,
 * 不猜一个本地 TTL.
 *
 * @param {{ ready?: any, refreshAt?: any }} holder 目录持有者
 * @param {number} [now] 当前时间戳(毫秒), 便于断言
 * @returns {boolean} 已过期则为真
 */
export function catalogExpired(holder: any, now = Date.now()) {
  if (!holder || holder.ready !== true) return false
  return Number.isFinite(holder.refreshAt) && now >= holder.refreshAt
}

/**
 * 主动把过了 refreshAt 的目录重抓一次.
 *
 * 抓取是 best-effort(见 protocol/fetch.ts), 失败保留旧目录继续用 ---- 宁可带着
 * 旧句柄走 legacy 路径, 也不因为一次抓取失败让整条链路停摆.
 *
 * @param {any} holder 目录持有者
 * @param {number} [now] 当前时间戳(毫秒)
 * @returns {Promise<boolean>} 是否真的重抓了(未过期或抓取失败为 false)
 */
export async function refreshIfExpired(holder: any, now = Date.now()) {
  if (!catalogExpired(holder, now)) return false
  if (typeof holder?.fetch !== 'function') return false
  try {
    await holder.fetch({ force: true })
  } catch {
    return false
  }
  return true
}

/**
 * 该句柄是否就是本目录这一次抓取签发的那一个.
 *
 * 单看 fbm1. 前缀不够 ---- 上一代签发的句柄同样带前缀, 而它在本目录里查无此行.
 *
 * @param {{ handles?: any }} holder 目录持有者
 * @param {string} handle 待判定标识
 * @returns {boolean} 属于本次抓取则为真
 */
export function handleInCatalog(holder: any, handle: any) {
  if (!isModelHandle(handle)) return false
  const values = holder?.handles?.values?.()
  if (!values) return false
  for (const h of values) {
    if (h === handle) return true
  }
  return false
}

/**
 * 由句柄反查稳定身份(目录 key). 查不到返回 null.
 *
 * 判据来自目录行原文(同一行同时带 key 与 handle), 不额外维护一张反向表.
 *
 * @param {{ rows?: any, ready?: any }} holder 目录持有者
 * @param {string} handle 目录句柄
 * @returns {string|null} 目录 key; 不属于本目录时 null
 */
export function keyForHandle(holder: any, handle: any) {
  if (!isModelHandle(handle) || holder?.ready !== true) return null
  for (const row of holder.rows?.() || []) {
    if (row?.handle === handle && typeof row.key === 'string') return row.key
  }
  return null
}

/**
 * 选一个能代表"同一个模型"的上线标识.
 *
 * assigned 是服务端会话回执里指派的 model, 它可能是 m-xxx(key) 也可能是上一代
 * 签发的句柄 ---- 后者在本目录里查无此行, 直接发出去只会被上游拒. 此时按
 * fallback(请求侧的模型标识)重新解析, 让本目录能定位到同一行.
 *
 * prefer='key': 跨进程边界用(对面会自己重抓, 只有稳定身份不会错位).
 * prefer='handle': 本进程直发上游用(chat 的 model 必须是句柄).
 *
 * @param {any} holder 目录持有者
 * @param {string} assigned 服务端指派的 model
 * @param {string} fallback 请求侧模型标识
 * @param {{ prefer?: 'key'|'handle' }} [opts] 期望的输出形态
 * @returns {{ model: string, reason: string, staleHandle?: string }} 上线标识与判定原因
 */
export function resolveWireModel(holder: any, assigned: any, fallback: any, opts: any = {}) {
  const prefer = opts.prefer === 'key' ? 'key' : 'handle'
  const name = typeof assigned === 'string' && assigned ? assigned : fallback
  if (typeof name !== 'string' || !name) return { model: name, reason: 'no_model' }
  if (!holder || holder.ready !== true || typeof holder.handleFor !== 'function') {
    return { model: name, reason: 'catalog_not_ready' }
  }
  // ① 稳定身份路径: 非句柄一律先归一到目录 key.
  const asKey = () => {
    if (isModelHandle(name)) return keyForHandle(holder, name)
    return typeof holder.keyOf === 'function' ? holder.keyOf(name) : null
  }
  if (prefer === 'key') {
    const key = asKey()
    if (key) return { model: key, reason: 'key' }
    return { model: name, reason: 'key_unresolved' }
  }
  // ② 本进程直发路径: 必须是本目录这一次抓取的句柄.
  const current = holder.handleFor(name)
  if (isModelHandle(current) && handleInCatalog(holder, current)) {
    return { model: current, reason: 'handle_current' }
  }
  const fromFallback = fallback ? holder.handleFor(fallback) : null
  if (isModelHandle(fromFallback) && handleInCatalog(holder, fromFallback)) {
    return {
      model: fromFallback,
      reason: 'handle_reissued',
      ...(isModelHandle(current) ? { staleHandle: current } : {}),
    }
  }
  // ③ 上一代句柄且请求侧也解析不出: 退回稳定身份. 发一个本目录查无此行的句柄
  // 上游只会拒; 稳定身份至少能让上游按同一行理解.
  if (isModelHandle(current)) {
    const key = keyForHandle(holder, current) || asKey()
    if (key) return { model: key, reason: 'handle_stale_fallback_key', staleHandle: current }
    return { model: current, reason: 'handle_foreign', staleHandle: current }
  }
  const key = asKey()
  if (key) return { model: key, reason: 'handle_unresolved_fallback_key' }
  return { model: current, reason: 'handle_unresolved' }
}
