/**
 * admission 的各步骤实现: 探测 claim, 回落后 POST, 以及回执的四种终态处置.
 *
 * 从 session-manager.js 的 _admitUnlocked 切出(原函数 366 行). 编排留在
 * ./turn.ts, 这里只放"拿到回执之后怎么办"的每一支.
 *
 * 官方行为依据(2026-10-01 真机抓包 + orchestrator.js 208130-208176):
 * 建会话路径是 GET /session(带 cli claim) -> POST /session/admission,
 * countryBlockReason 只是说明性字段, 槽位被占要带 takeover id 接管,
 * purchase_claim_released 要换全新 instanceId 重试一次.
 */
import { isTerminalCountryBlock } from '../../upstream/client.ts'
import { newRawInstanceId } from '../../upstream/official-fingerprint.ts'
import { logger } from '../../util/log.ts'

/**
 * 把"待结束的会话"结清再 admission(官方行为, 2026-10-04 逆向后补).
 *
 * 官方 orchestrator.js:208130-208136: 同一条 instanceId 上有未结清的会话时,
 * 先把它结束掉再 admission. 否则上游会认为该账号的槽位仍被占
 * (purchase_capacity) -- 而本地账本却显示 status: none(因为 _apply 早把它
 * 覆盖成 none 了), 面板与上游各说各话, 正是用户看到的"明明没会话却说槽位被占".
 *
 * 实测(2026-10-04 远程 12:52:18): 账号直连上游 status: none, balance 15,
 * 但远程 admission 一直 purchase_capacity. 只在确实处于待结束状态时做,
 * 正常路径零开销.
 * @param {any} this 会话实例
 * @param {string} model 请求模型
 * @returns {Promise<void>} 结清或无事发生即返回
 */
export async function clearPendingEnd(this: any, model: string): Promise<void> {
  if (!this._releasePending || !this.session?.instanceId) return
  const stale = this.session.instanceId
  logger.info('admit: clearing a pending session end first', {
    model,
    staleInstanceId: stale,
  })
  await this.upstream
    .freebuffSession('DELETE', { instanceId: stale })
    .catch((err: any) => {
      logger.warn('admit: pending-end DELETE failed; continuing', {
        staleInstanceId: stale,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  this._releasePending = false
}

/**
 * 走官方建会话路径的第一跳: GET + claim.
 *
 * GET 回执也要吸清单(不只在拿到 active 时): status: none 的回执同样带
 * desktopPurchases / desktopSessionCounts -- 而"谁占着槽位"恰恰只在没有自己
 * 会话时才重要(有自己会话就直接复用了).
 * @param {any} this 会话实例
 * @param {string} claimId 本进程复用的 instanceId
 * @returns {Promise<any>} 回执; 失败返回 null
 */
export async function probeClaim(this: any, claimId: string): Promise<any> {
  try {
    const body = await this.upstream.freebuffSession('GET', { instanceId: claimId })
    this._absorbInventory(body)
    return body
  } catch (err: any) {
    logger.warn('GET-claim admit failed; falling back to POST admission', {
      code: err?.code,
      status: err?.status,
      // 没有这两个字段时(网络层异常)必须留 message, 否则日志里
      // 只剩一句"失败"而看不出原因(实测排障时就卡在这里).
      message: err instanceof Error ? err.message : String(err),
      cause: err?.cause ? String(err.cause).slice(0, 200) : undefined,
      claimId,
    })
    return null
  }
}

/**
 * GET 没给出可用会话时改走 POST admission.
 *
 * 官方建会话路径(真机抓包 2026-10-01, 从零开始):
 *   GET /session x3(轮询, 返回 none)
 *   -> POST /session/admission(带 fbm1. 句柄的 x-freebuff-model) -> 200 active
 * 已知占用者时首次 POST 就带 takeover(官方 knownHolder 的用法): 官方在发请求
 * 之前就从 desktopPurchases 读出持有者, 直接带 x-freebuff-takeover-instance-id
 * 接管; 而不是先撞一次 purchase_capacity 再从错误回执里捡 id. 好处是少一次
 * 必然失败的请求, 且跨部署可见.
 * @param {any} this 会话实例
 * @param {string} model 请求模型
 * @param {string} claimId 本进程复用的 instanceId
 * @returns {Promise<any>} 回执; 失败返回 null
 */
export async function postAdmission(
  this: any,
  model: string,
  claimId: string,
): Promise<any> {
  const knownHolder = this.holderFor(model)
  logger.info('GET returned none; POSTing admission with claim', {
    model,
    claimId,
    knownHolder: knownHolder || null,
  })
  try {
    return await this.upstream.freebuffSession('POST', {
      model,
      instanceId: claimId,
      // 只在与自己不同时才接管(自己占着就正常 admission)
      ...(knownHolder && knownHolder !== claimId
        ? { takeoverInstanceId: knownHolder }
        : {}),
    })
  } catch (err: any) {
    logger.warn('POST admission failed', {
      code: err?.code,
      status: err?.status,
      claimId,
    })
    return null
  }
}

/**
 * 拿到 active 回执时的收尾: 记账, 落现场, 起轮询, 立刻发一次持有心跳.
 *
 * 官方 syncHeartbeatTimer 在有会话时立即执行一次 heartbeat(), 之后每 45 秒
 * 一次(常量 FREEBUFF_SESSION_HEARTBEAT_INTERVAL_MS = 45000).
 * 抓包实证: admission(line 8) -> 首个心跳(line 17)间隔 20.5 秒. 而真实事故里
 * 我们在 admission 后 25 秒就被退款 -- 时间尺度吻合, 这是"上游认为这条会话
 * 无人持有"的最强候选. 心跳是 fire-and-forget, 失败不影响 admit 返回值.
 * @param {any} this 会话实例
 * @param {any} body active 回执
 * @param {string} model 请求模型
 * @returns {any} 本地会话句柄
 */
export function activateSession(this: any, body: any, model: string): any {
  this.admitCount += 1
  this._apply(body)
  this._armPoll()
  logger.info('freebuff session active', {
    model: body.model,
    instanceId: body.instanceId,
    expiresAt: body.expiresAt,
    accessTier: body.accessTier,
  })
  this._sendHoldHeartbeat(body.instanceId)
  return this.session
}

/**
 * 回执说出口地区被终态封锁, 但仍给了 instanceId: 会话照常可用.
 *
 * 2026-10-01 真机抓包修正: 官方 CLI 在完全相同的出口(countryCode: JP,
 * countryBlockReason: 'country_not_allowed', verificationReason: 'region_locked')
 * 下, 服务端返回的是 status: "active" -- 会话照常建立, 照常可用. 也就是说
 * countryBlockReason 是说明性字段(告诉客户端为什么模型集变小了), 而不是
 * 拒绝信号. 此前我们把它当拒绝信号 -> 明明拿到了可用会话却主动抛错.
 *
 * 但钱已经花了: 保持这条已付费会话(落现场 + 起轮询), 然后才抛出, 让上层
 * 立即终止选号并把原因交给用户(出路是换代理, 不是换号).
 * @param {any} this 会话实例
 * @param {any} body 回执
 * @param {string} model 请求模型
 * @returns {void} 必定抛出
 */
export function failCountryBlocked(this: any, body: any, model: string): void {
  this.admitCount += 1
  this._apply({ ...body, status: 'active' })
  this._armPoll()
  logger.warn('admitted but egress country blocked; keeping paid session', {
    model: body.model,
    instanceId: body.instanceId,
    expiresAt: body.expiresAt,
    countryCode: body.countryCode ?? null,
    reason: body.countryBlockReason,
  })
  throw this._terminalSessionError(body, model)
}

/**
 * 判据: 这个回执是不是"出口地区被终态封锁"(且没有可用 instanceId).
 * @param {any} body 上游回执
 * @returns {boolean} 命中则为真
 */
export function isTerminalBlock(body: any): boolean {
  return Boolean(
    body?.status !== 'active' &&
      body?.countryBlockReason &&
      isTerminalCountryBlock(body.countryBlockReason) &&
      body.instanceId,
  )
}

/**
 * model_locked: 结束当前会话并重试一次请求的模型.
 * @param {any} this 会话实例
 * @param {any} body model_locked 回执
 * @param {string} model 请求模型
 * @returns {Promise<any>} 本地会话句柄
 */
