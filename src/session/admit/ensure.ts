/**
 * ensureSession: 热会话复用 / 平滑切换 / 冷路径 admit 的编排.
 *
 * "等待在途请求"与"付费时段内拒换模型"两个判断各自成函数, 主体只剩顺序.
 *
 * 见 .agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md
 */
import { UpstreamError } from '../../upstream/client.ts'
import { logger } from '../../util/log.ts'

/**
 * Ensure an active free session bound to model.
 * @param {any} this 会话实例
 * @param {string} model 上游 freebuff 模型标识
 * @returns {Promise<any>} 本地会话句柄
 */
export async function ensureSession(this: any, model: string): Promise<any> {
  if (!model) {
    throw new UpstreamError('model is required to admit a freebuff session', {
      status: 400,
      code: 'model_required',
    })
  }
  return this.withLock(async () => {
    if (this.isUsableForModel(model)) {
      // 热路径: 这条会话的整小时已经买过了, 复用它不产生任何新扣费.
      this.reuseCount += 1
      return this.session
    }
    await awaitSwitchWindow(this, model)
    // 等待期间可能已被其他路径重建/续期, 重新检查(同样是复用已有会话)
    if (this.isUsableForModel(model)) {
      this.reuseCount += 1
      return this.session
    }
    if (this.hasLiveSlot() && !this.isUsableForModel(model)) {
      blockPaidWindowModelSwitch(this, model)
      logger.info('releasing session before re-admit', {
        model,
        status: this.session?.status,
        from: this.session?.model,
        to: model,
      })
      await this._releaseUnlocked()
    }
    // 冷路径: 本地已知"没有活跃会话", 直接 admit.
    //
    // 上游同一个账号同一时间只能有一个客户端在线: 本进程的会话状态由
    // session-manager 单点持有(admit/释放/轮询都经 withLock 串行化), 不存在
    // "别人偷偷建了会话而我不知道". 兜底在上游: 模型不符时 admit 会返回
    // model_locked, _admitUnlocked 内部会释放并重试一次.
    return this._admitUnlocked(model)
  })
}

/**
 * 平滑切换的竞态保护: 等 live 会话上的在途请求全部结束再释放重建.
 *
 * 热会话可能正被在途 SSE 流使用(例如排队等待 chat 锁期间, 另一个请求先走到
 * 这里). 此时若直接释放再 re-admit, 会把正在传输的 session 从上游删掉 --
 * 上游连接还在但 session 已消失, 用户端会永久卡住. 用循环而非单次等待:
 * 某次归零的瞬间可能有新请求刚拿到 chat 锁开始在途, 需继续等它.
 *
 * 等待必须有上界: 在途流长时间不结束时, 新请求不能无限干等, 超时放弃本账号并由
 * 上层冷却(一条链卡死会导致所有后续请求全部超时).
 * @param {any} this 会话实例
 * @param {string} model 请求模型
 * @returns {Promise<void>} 进入真正空闲窗口或抛出 account_busy
 */
async function awaitSwitchWindow(self: any, model: string): Promise<void> {
  const switchDeadline = Date.now() + self.switchWaitMs()
  while (
    self.hasLiveSlot() &&
    !self.isUsableForModel(model) &&
    self._inFlight > 0
  ) {
    const left = switchDeadline - Date.now()
    if (left <= 0) {
      logger.warn('session switch timed out waiting for in-flight requests', {
        model,
        from: self.session?.model,
        to: model,
        inFlight: self._inFlight,
        waitMs: self.switchWaitMs(),
      })
      throw new UpstreamError(
        'session switch timed out: in-flight requests did not finish in time',
        { status: 429, code: 'account_busy' },
      )
    }
    logger.info('waiting for in-flight requests before session switch', {
      model,
      from: self.session?.model,
      to: model,
      inFlight: self._inFlight,
    })
    await self._waitForIdle(Math.min(left, 2_000))
  }
}

/**
 * 付费时段内换模型 = 纯亏损, 直接抛 paid_window_model_mismatch.
 *
 * 持有的 slot 已不可用(模型不符 / 已过期 / 即将过期)时本应"先释放再 admit",
 * 但仍在已付费时段内时释放(issue #24). 触发时的会话现场:
 *
 *     18:41:24  session active  expiresAt=19:41:19
 *     18:41:36  releasing session before re-admit(切模型)
 *     18:41:38  slot busy; not cooling  code=purchase_claim_released
 *
 * 即: 已买断的那一小时被主动扔掉, 新模型又没拿到, 账号进入最差状态;
 * DELETE 之后 0s / 45s / 90s 三次重试都接不回来, 直到 expiresAt 到期才恢复.
 *
 * 付费时段内的会话不是"不可用的 slot", 是"正在生效的资产". 抛
 * paid_window_model_mismatch: 上层据此跳过本账号去选下一个(它是健康的,
 * 只是这一个小时内只能服务旧模型).
 *
 * 只拦[模型不符], 不拦[即将过期需要续期]: 后者是同一模型的 re-admit.
 * @param {any} this 会话实例
 * @param {string} model 请求模型
 * @returns {void} 不命中则静默返回; 命中则抛出
 */
function blockPaidWindowModelSwitch(self: any, model: string): void {
  const modelMismatch = Boolean(
    self.session?.model && self.session.model !== model,
  )
  if (!modelMismatch || !self.inPaidWindow()) return
  const left = self.paidWindowRemainingMs()
  logger.warn('model switch inside paid window; keeping the paid session', {
    from: self.session?.model,
    to: model,
    instanceId: self.session?.instanceId,
    expiresAt: self.session?.expiresAt,
    paidWindowLeftMin: left != null ? Math.round(left / 60000) : null,
  })
  throw new UpstreamError(
    'account holds a paid session bound to another model; ' +
      'keeping it (switching inside the paid window voids the hour)',
    {
      status: 409,
      code: 'paid_window_model_mismatch',
      body: {
        boundModel: self.session?.model ?? null,
        instanceId: self.session?.instanceId ?? null,
        expiresAt: self.session?.expiresAt ?? null,
        paidWindowRemainingMs: left,
      },
    },
  )
}
