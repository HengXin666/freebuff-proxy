import http from 'node:http'
import { createProxyHandler } from './proxy.js'
import { logger } from './util/log.js'
import { sendJson } from './util/http.js'

/**
 * @param {object} deps
 * @param {import('./config.js').ProxyConfig} deps.config
 * @param {import('./session-manager.js').SessionManager} deps.sessions
 * @param {ReturnType<import('./upstream/client.js').createUpstreamClient>} deps.upstream
 * @param {string} deps.authToken
 */
export function startServer(deps) {
  const { config } = deps
  const { handle } = createProxyHandler(deps)

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

  server.requestTimeout = (config.limits.upstreamTimeoutSec + 30) * 1000
  server.headersTimeout = (config.limits.upstreamTimeoutSec + 60) * 1000

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.server.port, config.server.host, () => {
      const addr = server.address()
      logger.info('freebuff-proxy listening', {
        host: config.server.host,
        port: typeof addr === 'object' && addr ? addr.port : config.server.port,
      })
      resolve(server)
    })
  })
}
