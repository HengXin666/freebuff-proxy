/**
 * 上游探测: refresh(带/不带持有心跳)与轮询计时器.
 *
 * 官方两种 GET 形态的唯一差别就是几个头:
 *   heartbeat=true  = 持有心跳(每 45s 一次保活)
 *   默认            = 普通探测(能拿回额度/单价)
 * 见 orchestrator.js:207945-207957.
 */
import { UpstreamError } from '../../upstream/client.ts'
import { logger } from '../../util/log.ts'
import { accountLevelSessionStatus } from '../inventory.ts'

/**
 * 探测/刷新一次上游会话(带锁).
 *
 * 上游同一个号同一时间只能有一个客户端在线: 轮询 GET 若撞上在途
 * chat 会干扰/顶掉活跃会话(428 waiting_room_required), 因此跳过.
 * @param {any} this 会话实例
 * @param {{ heartbeat?: boolean }} [opts] heartbeat=true 走持有心跳形态
 * @returns {Promise<any>} 更新后的本地会话句柄
 */
export async function refresh(this: any, opts: any = {}): Promise<any> {
  return this.withLock(async () => {
    if (this._inFlight > 0) return this.session
    // 官方 CLI 每个 GET 都带自生成的 cli claim
    // (含 x-freebuff-multi-session / -purchase-continuity / -heartbeat),
    // 即使当时没有活跃会话; 没有会话时用本进程复用的那个.
    // 见 .agents/notes/implemented/bug-fix/2026-10-01-cli-get-session-path.md
    const reqOpts = {
      // 裸 UUID(desktop 形态); 没有会话时用本进程复用的那个
      instanceId: this.session?.instanceId || this.instanceId,
      compact: true,
      // 持有心跳形态(官方保活): 轮询走它
      heartbeat: opts.heartbeat === true,
    }
    try {
      const body = await this.upstream.freebuffSession('GET', reqOpts)
      const accountLevel = accountLevelSessionStatus(body?.status)
      if (accountLevel) {
        /**
         * 上游对账号级故障的 GET 回执也是 200 + {status:'banned'} 形态
         * (见 upstream/client.js 里 403 的 country_blocked/banned 直通).
         * 账号级错误回执只当探测结果, 不做 _apply:
         *   1) _apply 会把 session 覆盖成 {status:'banned', instanceId: undefined},
         *      抹掉活着的 instanceId, 那条已付费一小时的会话从此无法寻址
         *      (既 DELETE 不掉也追不回钱, 退款的唯一凭据就是它);
         *   2) 会记成 lastProbe.ok = true;
         *   3) 会把健康判定退化成"还有没有本地会话".
         * 这里保留会话现场, 落 lastProbe 并抛出, 调用方据此区分 ban / 风控 / IP 上限.
         * 决策与端到端判据见 .agents/notes/implemented/feature/2026-09-15-console-readonly-refresh.md.
         */
        this._setLastProbe({
          ok: false,
          code: accountLevel,
          status: null,
          message: body?.message || null,
        })
        this._clearPoll()
        throw new UpstreamError(
          `freebuff session probe: ${accountLevel}` +
            (body?.message ? ` -- ${body.message}` : ''),
          { status: 403, code: accountLevel, body },
        )
      }
      this._apply(body)
      this._setLastProbe({ ok: true })
      if (this.hasLiveSlot()) this._armPoll()
      else this._clearPoll()
      return this.session
    } catch (err: any) {
      this._setLastProbe({
        ok: false,
        code: err?.code || (err instanceof Error ? err.name : null),
        status: err?.status ?? null,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  })
}

/**
 * 记录最近一次探测结果(成功清空错误码).
 * @param {any} this 会话实例
 * @param {{ ok: boolean, code?: any, status?: any, message?: any }} patch 探测结果
 * @returns {void}
 */
export function _setLastProbe(this: any, patch: any): void {
  const now = new Date().toISOString()
  if (patch.ok) {
    this.lastProbe = { ok: true, at: now, code: null, status: null, message: null }
  } else {
    this.lastProbe = {
      ok: false,
      at: now,
      code: patch.code ?? null,
      status: patch.status ?? null,
      message: patch.message ?? null,
    }
  }
  this._notifyStateChange()
}

/**
 * 发一次持有心跳(官方形态): GET /session + instance-id + -heartbeat: 1.
 *
 * 官方在 admission 后立刻发一次, 之后每 45s 一次. 失败只记日志, 不影响调用方.
 *
 * 决策见 .agents/notes/implemented/bug-fix/2026-10-04-hold-heartbeat-and-cold-start-normalize.md.
 * @param {any} this 会话实例
 * @param {string} instanceId 目标会话实例 id
 * @returns {void}
 */
export function _sendHoldHeartbeat(this: any, instanceId: string): void {
  if (!instanceId) return
  Promise.resolve()
    .then(() =>
      this.upstream.freebuffSession('GET', {
        instanceId,
        heartbeat: true,
      }),
    )
    .then((body: any) => {
      logger.info('hold heartbeat sent', {
        instanceId,
        status: body?.status ?? null,
      })
    })
    .catch((err: unknown) => {
      logger.warn('hold heartbeat failed (non-fatal)', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

/**
 * 起会话轮询(轮询即持有心跳, 官方 45s 一次, 我们按 pollIntervalSec 跑).
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _armPoll(this: any): void {
  this._clearPoll()
  const ms = Math.max(5_000, (this.config.session.pollIntervalSec || 30) * 1000)
  this._pollTimer = setInterval(() => {
    this.refresh({ heartbeat: true }).catch((err: unknown) => {
      logger.warn('session poll failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, ms)
  /**
   * 轮询不得独自撑住事件循环.
   *
   * 本仓其它会自己起计时的地方一律 unref(空闲释放 / 释放重试 / 有界等待), 只有
   * 这一处漏了 ---- 而它是 setInterval, 带 ref 时进程永不退出. 平时被
   * "释放路径最后一定会走到 _clearPoll()" 掩盖着; 一旦有条路径提前返回(例如
   * 付费时段内不释放), 这条 interval 就留下来把进程钉死: 表现为测试跑完全部
   * 用例, 打完 smoke ok 却不退出(实测 headless 跑 240s 超时, 而用例本身全绿).
   *
   * 心跳本身是 best-effort(失败只记 warn), 没有理由要求进程为它活着.
   * 见 .agents/notes/implemented/bug-fix/2026-10-06-session-poll-timer-unref.md
   */
  if (this._pollTimer.unref) this._pollTimer.unref()
}

/**
 * 停会话轮询.
 * @returns {void}
 * @param {any} this 会话实例
 */
export function _clearPoll(this: any): void {
  if (this._pollTimer) {
    clearInterval(this._pollTimer)
    this._pollTimer = null
  }
}
