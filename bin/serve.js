#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { buildAppContext } from '../src/app-context.js'
import { startServer } from '../src/server.js'
import { configureLogger, logger } from '../src/util/log.js'
import { UserStore } from '../src/web/user-store.js'
import { WebSessionStore } from '../src/web/session-store.js'
import { LoginFlowManager } from '../src/web/login-flows.js'
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

async function main() {
  const config = loadConfig(parseConfigPath(process.argv.slice(2)))
  configureLogger(config.logging)

  const dataDir = config.server.dataDir
  const userStore = new UserStore(path.join(dataDir, 'users.json'))
  const webSessions = new WebSessionStore(
    path.join(dataDir, 'web-sessions.json'),
    (config.web.sessionTtlHours || 24 * 7) * 3600 * 1000,
  )

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

  const server = await startServer({
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
  })

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
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err)
  process.exitCode = 1
})
