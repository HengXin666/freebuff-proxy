#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { loadConfig } from '../src/config.js'
import { buildAppContext } from '../src/app-context.js'
import { startServer } from '../src/server.js'
import { configureLogger, logger } from '../src/util/log.js'
import { UserStore } from '../src/web/user-store.js'
import { WebSessionStore } from '../src/web/session-store.js'
import { LoginFlowManager } from '../src/web/login-flows.js'
import { ProxyStore } from '../src/web/proxy-store.js'
import { SettingsStore } from '../src/web/settings-store.js'
import { listAccounts } from '../src/auth-store.js'

function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host || ''))
}

function parseConfigPath(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') return argv[i + 1]
  }
  return undefined
}

/**
 * 自重启子进程的端口等待：旧进程退出需要一点时间，轮询直到端口可绑定，
 * 避免子进程启动时撞上 EADDRINUSE（裸机/非 Docker 场景）。
 */
function waitForPortFree(host, port, timeoutMs) {
  const target =
    !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tryOnce = () => {
      const socket = net.connect({ host: target, port })
      const done = () => {
        socket.destroy()
        if (Date.now() < deadline) setTimeout(tryOnce, 250)
        else resolve()
      }
      socket.once('connect', done)
      socket.once('error', () => resolve()) // 端口已释放 → 可以接管
    }
    tryOnce()
  })
}

async function main() {
  const config = loadConfig(parseConfigPath(process.argv.slice(2)))
  configureLogger(config.logging)

  // 自重启子进程：等旧进程释放端口后再走正常启动流程
  if (process.env.FREEBUFF_PROXY_RESTART_CHILD === '1') {
    logger.info('restart child starting; waiting for port to free', {
      host: config.server.host,
      port: config.server.port,
    })
    await waitForPortFree(config.server.host, config.server.port, 15_000)
  }

  const dataDir = config.server.dataDir
  const userStore = new UserStore(path.join(dataDir, 'users.json'))
  const webSessions = new WebSessionStore(
    path.join(dataDir, 'web-sessions.json'),
    (config.web.sessionTtlHours || 24 * 7) * 3600 * 1000,
  )
  // 前端「代理设置」管理的全局代理池（优先于 config.yaml 的 upstream.proxies）
  const proxyStore = new ProxyStore(path.join(dataDir, 'proxies.json'))
  const settingsStore = new SettingsStore(path.join(dataDir, 'settings.json'))
  if (proxyStore.list().length) {
    config.upstream.proxies = proxyStore.list()
  }

  // First-run admin bootstrap (or env-driven rotation)
  const admin = userStore.ensureDefaultAdmin(
    config.users.defaultAdminUsername,
    config.users.defaultAdminPassword || null,
  )
  if (admin.created) {
    if (admin.password) {
      logger.info(
        'default admin created — credentials shown once in logs below',
        { username: admin.username },
      )
      // Visible in `docker compose logs` for one-click onboarding
      console.log(
        `\n[freebuff-proxy] 首次启动：已创建管理员账号\n` +
          `  登录地址: http://<host>:${config.server.port}/\n` +
          `  用户名:   ${admin.username}\n` +
          `  密码:     ${admin.password}\n` +
          `请立即登录并修改密码（建议同时设置 ADMIN_PASSWORD 环境变量）。\n`,
      )
    } else {
      logger.info('default admin ensured (password from env)', {
        username: admin.username,
      })
    }
  }

  if (
    (config.server.apiKeys || []).length === 0 &&
    !isLoopbackHost(config.server.host) &&
    userStore.all().length === 0
  ) {
    console.error(
      'Refuse to serve: no server.api_keys and no web users while binding a non-loopback host.\n' +
        'Set server.api_keys, create a web user, or bind 127.0.0.1 / localhost / ::1.',
    )
    process.exitCode = 1
    return
  }

  const ctx = buildAppContext(config)
  if (ctx.authEmail) {
    logger.info('upstream auth ready', {
      account: ctx.authEmail,
      accounts: ctx.runtimes.list().map((a) => a.email),
    })
    try {
      const me = await ctx.upstream.me(['id', 'email'])
      logger.info('upstream identity ok', { id: me.id, email: me.email })
    } catch (err) {
      logger.warn('upstream /api/v1/me check failed (continuing)', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } else {
    logger.info('no Freebuff accounts yet — add one from the web console', {
      credentialsDir: ctx.runtimes.dir,
    })
  }

  const loginFlows = new LoginFlowManager({
    file: path.join(dataDir, 'login-flows.json'),
    credentialsDir: ctx.runtimes.dir,
    config,
  })

  let server = null
  const shutdown = async (signal) => {
    logger.info('shutting down', { signal })
    loginFlows.shutdown()
    try {
      await ctx.runtimes.shutdown()
    } catch (err) {
      logger.warn('session shutdown error', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (server) {
      server.close(() => process.exit(0))
      // 重启场景下立即断开存量连接，让端口尽快释放给子进程
      server.closeAllConnections?.()
    } else {
      process.exit(0)
    }
    setTimeout(() => process.exit(0), 3000).unref()
  }

  /**
   * 前端「重启服务」：spawn 一个 detached 子进程（等待端口释放后接管），
   * 然后当前进程优雅退出。Docker 场景下容器主进程退出会触发 restart 策略
   * 整容器重建；裸机场景由子进程无缝接管。
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

  server = await startServer({
    config,
    runtimes: ctx.runtimes,
    authToken: ctx.authToken,
    authSource: ctx.authSource,
    authEmail: ctx.authEmail,
    upstream: ctx.upstream,
    sessions: ctx.sessions,
    userStore,
    webSessions,
    loginFlows,
    proxyStore,
    settingsStore,
    restart: scheduleRestart,
  })

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err)
  process.exitCode = 1
})
