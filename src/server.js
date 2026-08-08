import http from 'node:http'
import path from 'node:path'
import { createProxyHandler } from './proxy.js'
import { createWebApi } from './web/api.js'
import { serveStatic } from './web/static.js'
import { logger } from './util/log.js'
import { sendJson } from './util/http.js'
import { projectRootFromModule } from './config.js'

const dashboardDir = path.join(projectRootFromModule(), 'dashboard')

/**
 * @param {object} deps
 * @param {import('./config.js').ProxyConfig} deps.config
 * @param {import('./session-manager.js').SessionManager} deps.sessions
 * @param {ReturnType<import('./upstream/client.js').createUpstreamClient>} deps.upstream
 * @param {string} deps.authToken
 * @param {import('./web/user-store.js').UserStore} deps.userStore
 * @param {import('./web/session-store.js').WebSessionStore} deps.webSessions
 * @param {import('./web/login-flows.js').LoginFlowManager} deps.loginFlows
 */
export function startServer(deps) {
  const { config } = deps
  const proxy = createProxyHandler(deps)
  const web = createWebApi(deps)

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error('unhandled request error', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        url: req.url,
      })
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            message: 'Internal proxy error',
            type: 'proxy_error',
          },
        })
      } else {
        res.destroy()
      }
    })
  })

  async function handle(req, res) {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    )
    const pathname = url.pathname

    if (
      pathname === '/healthz' ||
      pathname === '/health' ||
      pathname.startsWith('/v1/')
    ) {
      await proxy.handle(req, res)
      return
    }
    if (pathname.startsWith('/api/')) {
      await web.handle(req, res, url)
      return
    }
    // dashboard (/) and anything else
    serveStatic(req, res, url, dashboardDir)
  }

  server.requestTimeout = (config.limits.upstreamTimeoutSec + 30) * 1000
  server.headersTimeout = (config.limits.upstreamTimeoutSec + 60) * 1000

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.server.port, config.server.host, () => {
      const addr = server.address()
      logger.info('freebuff-proxy listening', {
        host: config.server.host,
        port: typeof addr === 'object' && addr ? addr.port : config.server.port,
        dataDir: config.server.dataDir,
      })
      resolve(server)
    })
  })
}
