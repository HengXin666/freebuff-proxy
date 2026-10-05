/**
 * 会话句柄与退款记录的读写归.
 *
 * 这里回答"磁盘上那条记录能不能用": 字段级判据 + 归一, 与 store 的状态机
 * (内存 Map 与数组)无关. 读盘宁缺毋滥: 缺 key/instanceId 的条目一律丢弃并记账
 * (它们无法寻址 DELETE, 留着只会在每次启动时白重放).
 */

/**
 * 待结算退款队列的键:一个账号上同一条 instance 只该有一条记录.
 * @param {any} key 账号 key
 * @param {any} instanceId 会话实例 id
 * @returns {string} 队列键(key 与 instanceId 以 NUL 分隔)
 */
export function refundKey(key: any, instanceId: any) {
  // 用 NUL 分隔(与冷却键同约定):uuid/email 都不含它,不会撞键.
  return key + String.fromCharCode(0) + instanceId
}

/**
 * 把一条磁盘记录收成规范句柄(缺字段一律 null, 绝不沿用脏值).
 * @param {any} s 磁盘上的原始记录
 * @returns {{key: any, instanceId: any, model: any, admittedAt: any, expiresAt: any}} 规范句柄
 */
export function normalize(s: any) {
  return {
    key: s.key,
    instanceId: s.instanceId,
    model: s.model ?? null,
    admittedAt: s.admittedAt ?? null,
    expiresAt: s.expiresAt ?? null,
  }
}

/**
 * 有界等待(毫秒).
 * @param {any} ms 等待时长(毫秒)
 * @returns {Promise<void>} 定时器到期后 resolve
 */
export function sleep(ms: any) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer.unref) timer.unref()
  })
}
