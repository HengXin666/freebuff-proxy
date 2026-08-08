#!/usr/bin/env node
import process from 'node:process'
import { loadConfig } from '../src/config.js'
import { buildAppContext } from '../src/app-context.js'
import { startServer } from '../src/server.js'
import { configureLogger, logger } from '../src/util/log.js'

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

  if (
    (config.server.apiKeys || []).length === 0 &&
    !isLoopbackHost(config.server.host)
  ) {
    console.error(
      'Refuse to serve: server.api_keys is empty while binding a non-loopback host.\n' +
        'Set server.api_keys or bind 127.0.0.1 / localhost / ::1.',
    )
    process.exitCode = 1
    return
  }

  const ctx = buildAppContext(config)
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

  const server = await startServer(ctx)
  const shutdown = async (signal) => {
    logger.info('shutting down', { signal })
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
