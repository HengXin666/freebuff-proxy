/**
 * 自动签到调度 ---- 按 25 小时间隔跑一轮签到.
 *
 * 三条纪律(与 src/catalog/runtime-sync.ts 同源):
 *   1. timer.unref(): 定时器不能拦住进程退出 ---- 否则 SIGTERM 之后
 *      进程挂在事件循环里, 容器要等超时才被杀.
 *   2. 开关实时读: 每秒读一次设置太浪费, 但每轮开始时必须重新读,
 *      这样用户关掉开关最多影响下一轮, 不用重启.
 *   3. 失败不抛: 一轮签到失败不该让调度器停摆(下一轮还会再来).
 *
 * 间隔是 25 小时而不是 24: 签到按[太平洋日]重置, 24 小时整会在跨时区/
 * 夏令时边界上出现"同一自然日触发两次"(白花一次钱).
 */
import { logger } from '../../../util/log.ts'
import { runSignInRound } from './run.ts'

/** 检查间隔: 每 10 分钟看一次[到点了没]. 真正的节流判据在 store.autoDue(). */
const TICK_MS = 10 * 60 * 1000

/**
 * 起一个自动签到调度器.
 *
 * @param {any} deps 依赖(runtimes / config / catalogRows / settingsStore / signInStore)
 * @param {any} [opts] 选项(runOnce: 只跑一次不排期, 测试用)
 * @returns {any} 停止句柄
 */
export function startAutoSignIn(deps: any, opts: any = {}) {
  let stopped = false

  /**
   * 跑一轮(会先判开关与间隔).
   * @returns {Promise<void>} 无返回值
   */
  const tick = async () => {
    if (stopped) return
    try {
      const settings = deps.settingsStore?.get?.() || {}
      // 开关默认关闭: 签到要发消息(有成本), 不能替用户默认花钱.
      if (settings.autoSignInEnabled !== true) return
      if (!deps.signInStore?.autoDue?.()) return
      const summary = await runSignInRound({
        runtimes: deps.runtimes,
        config: deps.config,
        catalogCache: deps.catalogRows?.() || { rows: [] },
        settings: {
          officialToolNames: settings.officialToolNames,
          systemPrompt: undefined,
        },
        store: deps.signInStore,
      }, 'auto')
      logger.info('auto sign-in round done', {
        total: summary.total,
        signedIn: summary.signedIn,
        skipped: summary.skipped,
        failed: summary.failed,
      })
    } catch (err) {
      // 单轮失败不停摆: 下一轮还会再来.
      logger.warn('auto sign-in round failed', { error: String(err) })
    }
  }

  const first = tick()
  if (opts.runOnce) return { stop: () => { stopped = true }, done: first }

  const timer = setInterval(() => { void tick() }, TICK_MS)
  // unref: 定时器不得拦住进程退出(见文件头第 1 条).
  timer.unref?.()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    done: first,
  }
}
