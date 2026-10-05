/**
 * 上游探测: refresh(带/不带持有心跳)与轮询计时器.
 *
 * 从 session-manager.js 的 refresh / _setLastProbe / _sendHoldHeartbeat /
 * _armPoll / _clearPoll 切出.
 *
 * 官方两种 GET 形态的唯一差别就是几个头:
 *   heartbeat=true  = 持有心跳(每 45s 一次保活)
 *   默认            = 普通探测(能拿回额度/单价)
 * 见 orchestrator.js:207945-207957.
 */
import { UpstreamError } from '../../upstream/client.js'
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
    // 2026-10-01 真机对比修正: 官方 CLI 每个 GET 都带自生成的 cli claim
    // (含 x-freebuff-multi-session / -purchase-continuity / -heartbeat),
    // 即使当时没有活跃会话. 我们此前只在"已有会话"时才带 instanceId,
    // 没有会话就裸发 -- 抓包对比一栏就看出少了整整 5 个头.
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
         * 上游对账号级故障的 GET 回执也是 200 + {status:'banned'} 这种
         * 形态(见 upstream/client.js 里 403 的 country_blocked/banned 直通).
         * 以前这里无条件 this._apply(body), 于是控制台点一次[刷新]就会:
         *   1) 把 session 覆盖成 {status:'banned', instanceId: undefined} --
         *      活着的 instanceId 被抹掉, 那条已付费一小时的会话从此无法寻址,
         *      既 DELETE 不掉(腾不出上游槽位)也追不回钱(退款的唯一凭据就是它);
         *   2) 记成 lastProbe.ok = true -- 探测明明失败了却显示成功;
         *   3) 把健康判定从"账号是否封禁"退化成"还有没有本地会话".
         * 所以账号级错误回执只当探测结果: 保留会话现场, 不入 _apply,
         * 落 lastProbe 原因后抛出(调用方据此区分 ban / 风控 / IP 上限).
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
 * 记录最近一次探测结果(成功清空原因码).
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
 * 官方在 admission 后立刻发一次, 之后每 45s 一次; 我们此前一次都没发
 * (makeSessionViaBun 丢弃 opts). 失败只记日志, 绝不影响调用方(可用性优先).
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
