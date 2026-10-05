/**
 * 428 / 续用有关的两个补充入口: forceReadmit 与 readmitToContinue.
 *
 * 从 session-manager.js 同名方法切出.
 */
import { logger } from '../../util/log.ts'

/**
 * 销毁式重建一条新会话并绑定 model.
 *
 * 禁止用本方法处理 waiting_room_required(428): 它做的两件事都是错的
 *
 *   1. _releaseUnlocked() -- 先 DELETE 掉已经买断的那一小时. 上游对早退
 *      DELETE 不退 Freebucks(只回 freebucksRefundPending).
 *   2. _admitUnlocked() -- 再买一小时. 余额已扣光时这一步必然失败
 *      (skip re-admit: freebucks cannot afford model).
 *
 * 官方真值(orchestrator.js, 官方 desktop 0.0.158 解包):
 *   - 179243  waiting_room_required: { status: 428, endsTheSession: !0 }
 *   - 180126  命中后存进度 -> 重新 admission -> 用同一条消息重跑
 *   - 207147  重新 admission 带 x-freebuff-purchase-continuity: "1"
 *               + 同一个 instanceId(整线程复用) -> 上游认作续用那一小时
 *   - 官方从不先 DELETE
 *
 * 所以 428 的处置是 readmitToContinue(). 本方法仅保留给确实需要换一条新会话的
 * gate(如 session_model_mismatch 要换绑模型).
 * @param {any} this 会话实例
 * @param {string} model 请求模型
 * @returns {Promise<any>} 本地会话句柄
 */
export async function forceReadmit(this: any, model: string): Promise<any> {
  return this.withLock(async () => {
    await this._releaseUnlocked()
    return this._admitUnlocked(model)
  })
}

/**
 * 428 waiting_room_required 的官方对齐处置: 续用当前已买断的会话, 不 DELETE,
 * 不重买.
 *
 * 上游原话就是 "Send your message again to start a new one" -- 它要的是
 * 重发消息, 不是重新购买. 官方客户端据此做的是: 带同一个 instanceId 与
 * purchase-continuity: 1 重新 admission(上游按"续用"处理, 不再计入新的购买),
 * 再重跑同一条消息.
 *
 * 本方法只做"续用"这一跳(re-admit with continuity); chat 重发由调用方在
 * 重试循环里完成(用同一 prompt). 不释放既有会话 ---- 那一小时是实付的.
 * @param {any} this 会话实例
 * @param {string} model 请求模型
 * @returns {Promise<{ continued: boolean, instanceId?: string | null, reason?: string }>}
 */
export async function readmitToContinue(this: any, model: string): Promise<any> {
  return this.withLock(async () => {
    const existing = this.session?.instanceId || this.instanceId || null
    if (!existing) {
      // 本来就没有会话(不是"续用"场景): 交给常规 admit
      logger.info('readmitToContinue: no live instance; falling back to admit', {
        model,
      })
      const s = await this._admitUnlocked(model)
      return { continued: true, instanceId: s?.instanceId ?? null }
    }
    // 复用同一 instanceId 重新 admission.
    //
    // officialSessionHeaders() 在有 instanceId 时自动带上
    // x-freebuff-purchase-continuity: 1(见 official-fingerprint.js), 所以这里
    // 只需把 instanceId 传进去, 不额外造参数.
    const body = await this.upstream.freebuffSession('POST', {
      model,
      instanceId: existing,
    })
    const status = body?.status
    if (status === 'active') {
      this._apply(body)
      this._setLastProbe({ ok: true })
      return { continued: true, instanceId: body?.instanceId || existing }
    }
    // 续用没成: 保留会话现场(不释放), 让上层决定是否换号.
    // 绝不在这里 DELETE -- 那一小时已付款, 丢了就是纯亏.
    logger.warn('readmitToContinue did not return active; keeping session', {
      model,
      status: status ?? null,
      instanceId: existing,
    })
    return { continued: false, instanceId: existing, reason: status || 'not_active' }
  })
}
