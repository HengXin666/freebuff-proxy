/**
 * 服务的生命周期: 优雅关闭与前端[重启服务] -- 从 bin/serve.ts 的 main() 按职责切出.
 *
 * 为什么切出来: 关闭路径有三条真实约束(等上游 DELETE 完成 / 立即断开存量连接
 * 让端口尽早释放 / 3 秒兜底再退出), 它们与启动编排是两件事. 而且它是
 * scheduleRestart 与 SIGINT / SIGTERM 的共同依赖, 单独成文件后两条路径
 * 看到的是同一份实现 ---- 不会出现"信号路径改了一处, 重启路径没改".
 *
 * 口径: 纯搬移, 不改时序与超时; 关闭顺序逐字保留.
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

import { logger } from '../../../src/util/log.ts'

/** shutdown 需要的依赖. */
interface ShutdownDeps {
  /** 当前 http server(尚未监听时为 null). */
  getServer: () => any
  /** 浏览器登录回调管理器. */
  loginFlows: { shutdown: () => void }
  /** 应用上下文(含 runtimes). */
  ctx: any
}

/**
 * 建一对(优雅关闭 + 计划重启)函数, 两者共享同一份 server / loginFlows 引用.
 * @param {() => any} getServer 当前 http server(尚未监听时为 null)
 * @param {{ shutdown: () => void }} loginFlows 浏览器登录回调管理器
 * @param {any} ctx 应用上下文(含 runtimes)
 * @returns {{ shutdown: (signal: any) => Promise<void>, scheduleRestart: () => void }} 关闭与重启
 */
export function createLifecycle({ getServer, loginFlows, ctx }: ShutdownDeps) {
  /**
   * 优雅关闭: 释放会话 -> 关监听 -> 退出; 重启场景下立即断开存量连接.
   * @param {any} signal 触发关闭的信号名(或 'restart')
   * @returns {Promise<void>} 无返回值
   */
  const shutdown = async (signal: any) => {
    logger.info('shutting down', { signal })
    loginFlows.shutdown()
    try {
      // strict:等到每条上游会话真的 DELETE 掉(或退避重试耗尽)再退出.
      // 退出即失去内存里的 instanceId,不严格释放就会留下占着槽位的孤儿;
      // 失败的句柄已落盘 sessions.json,下次启动扫尾继续删.
      const rel = await ctx.runtimes.shutdown({ strict: true })
      if (rel && rel.failed && rel.failed.length) {
        logger.warn('sessions still live at shutdown (handles persisted)', {
          failed: rel.failed.length,
        })
      }
    } catch (err) {
      logger.warn('session shutdown error', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const server = getServer()
    if (server) {
      server.close(() => process.exit(0))
      // 重启场景下立即断开存量连接,让端口尽快释放给子进程
      server.closeAllConnections?.()
    } else {
      process.exit(0)
    }
    setTimeout(() => process.exit(0), 3000).unref()
  }

  /**
   * 前端[重启服务]:spawn 一个 detached 子进程(等待端口释放后接管),
   * 然后当前进程优雅退出.Docker 场景下容器主进程退出会触发 restart 策略
   * 整容器重建;裸机场景由子进程无缝接管.
   * @returns {void} 只登记子进程与关闭, 不等待
   */
  function scheduleRestart() {
    const child = spawn(
      process.execPath,
      process.argv.slice(1),
      {
        detached: true,
        stdio: 'inherit',
        env: { ...process.env, FREEBUFF_PROXY_RESTART_CHILD: '1' },
      },
    )
    child.unref()
    logger.info('restart scheduled via web console', { pid: child.pid })
    shutdown('restart').catch((err) => {
      logger.error('graceful shutdown during restart failed', {
        error: err instanceof Error ? err.stack || err.message : String(err),
      })
      process.exit(1)
    })
  }

  return { shutdown, scheduleRestart }
}
