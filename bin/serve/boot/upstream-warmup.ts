/**
 * 上游相关的启动工作 -- 从 bin/serve.ts 按职责切出.
 *
 *
 * 口径: 纯搬移 + 按职责抽子函数, 不改任何时序与判据.
 */
import { getCliVersion, refreshCliVersion } from '../../../src/upstream/fingerprint/official-fingerprint.ts'
import { reportCliLaunch } from '../../../src/upstream/telemetry/cli-telemetry.ts'
import { logger } from '../../../src/util/log.ts'

/**
 * CLI 版本对齐(默认不动).
 *
 * 启动时的 npm 版本拉取已停用(零自动探测, docs/reverse/20 §20.3):它会在每次
 * 启动自动打 registry.npmjs.org,属于"我们不请自来的外部请求".
 * CLI 版本号用仓库内的已知值(getCliVersion() 的默认值);
 * 要跟进官方发版由维护者显式触发, 或打开设置里的开关(见下). 功能保留, 默认不动.
 * @param {any} settingsStore 控制台设置
 * @returns {void} 只登记异步任务, 不等待
 */
function warmCliVersion(settingsStore: any): void {
  const cliVersionAuto = settingsStore?.get?.().cliVersionAutoRefresh === true
  if (!cliVersionAuto) {
    logger.info('cli fingerprint version kept (auto-refresh disabled)', {
      version: getCliVersion(),
    })
    return
  }
  void refreshCliVersion()
    .then((version) => {
      logger.info('cli fingerprint version aligned', { version })
      // 遥测上报(可选):官方 CLI 起进程就会发 app_launched +
      // fingerprint_generated.我们从不上报 = 服务端眼里一个"只发 chat,
      // 没有任何客户端生命迹象"的连接.这里按真实时序补上.
      // 判据与取舍见
      // .agents/notes/proposed/architecture/2026-09-30-cli-telemetry-reports.md
      if (settingsStore?.get?.().cliTelemetryEnabled === true) {
        void reportCliLaunch({ fingerprintSuccess: true })
          .then((n) => {
            if (n > 0) logger.debug('cli telemetry reported', { records: n })
          })
          .catch(() => {})
      }
      armVersionSweeper(settingsStore)
    })
    .catch(() => {})
}

/**
 * 周期对齐:CLI 版本随官方发版变化,写死一个过时值本身是可用指纹.
 * 每 6h 拉一次 npm latest;版本变了就 warn(一眼看出该跟进官方).
 * unref:定时器绝不挡进程退出.
 * @param {any} settingsStore 控制台设置
 * @returns {void} 只登记定时器, 不等待
 */
function armVersionSweeper(settingsStore: any): void {
  const versionSweeper = setInterval(() => {
    if (settingsStore?.get?.().cliVersionAutoRefresh !== true) return
    const before = getCliVersion()
    void refreshCliVersion()
      .then((next) => {
        if (next && next !== before) {
          logger.warn('cli fingerprint version changed upstream; realigned', {
            from: before,
            to: next,
          })
        }
      })
      .catch(() => {})
  }, 6 * 60 * 60 * 1000)
  if (versionSweeper.unref) versionSweeper.unref()
}

/**
 * 会话句柄扫尾:把上次进程遗留的句柄 DELETE 掉(进程退出后 instanceId 就没了,
 * 不扫就是"无法寻址的计费孤儿",一直占着上游槽位;见
 * docs/design/account-scheduling-and-refund.md §3).
 * @param {any} ctx 应用上下文
 * @returns {void} 只登记异步任务, 不等待
 */
function sweepOrphanSessions(ctx: any): void {
  void ctx.runtimes
    .cleanupOrphanSessions({ budgetMs: 15_000 })
    .then((sweep: any) => {
      if (sweep.cleaned || sweep.failed || sweep.skipped || sweep.deferred) {
        logger.info('leftover session sweep on startup', sweep)
      }
    })
    .catch((err: any) => {
      logger.warn('leftover session sweep failed (continuing)', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

/**
 * 退款追问:待结算的挂起退款必须持续追,不能只等下次重启.
 *
 * 上游要求用同一个 instanceId 重放 DELETE 才给终态回执,且结算窗口可能跨
 * 分钟级;只扫一次 = 进程活着就永远问不到那笔钱(见 docs/design/account-scheduling-and-refund.md §3).
 * 低频(5 分钟),有界(30s 预算),unref(不挡进程退出).
 * @param {any} ctx 应用上下文
 * @returns {void} 只登记定时器, 不等待
 */
function armRefundSweeper(ctx: any): void {
  const refundSweeper = setInterval(() => {
    void ctx.runtimes
      .sweepPendingRefunds({ budgetMs: 30_000 })
      .catch((err: any) => {
        logger.warn('pending refund sweep failed (continuing)', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }, 5 * 60_000)
  if (refundSweeper.unref) refundSweeper.unref()
}

/**
 * 账号就绪日志(启动路径不发任何上游请求).
 *
 * @param {any} ctx 应用上下文
 * @returns {void} 只写日志, 无返回值
 */
function logUpstreamAuthReady(ctx: any): void {
  if (ctx.authEmail) {
    logger.info('upstream auth ready (no upstream request on startup)', {
      account: ctx.authEmail,
      accounts: ctx.runtimes.list().map((a: any) => a.email),
    })
  } else {
    logger.info('no Freebuff accounts yet — add one from the web console', {
      credentialsDir: ctx.runtimes.dir,
    })
  }
}

/**
 * 上游相关的启动工作(一律不 await).
 *
 *
 * @param {any} ctx 应用上下文(含 runtimes)
 * @param {any} settingsStore 控制台设置(cliVersionAutoRefresh / cliTelemetryEnabled)
 * @returns {void} 只登记异步任务,不等待
 */
export function startUpstreamWarmup({ ctx, settingsStore }: any) {
  warmCliVersion(settingsStore)
  sweepOrphanSessions(ctx)
  armRefundSweeper(ctx)
  logUpstreamAuthReady(ctx)
}
