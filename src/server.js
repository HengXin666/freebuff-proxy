import http from 'node:http'
import path from 'node:path'
import { createProxyHandler } from './proxy.js'
import { createProxyFetch } from './upstream/client.js'
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
 * @param {import('./web/model-store.js').ModelStore} [deps.modelStore] 前端「模型管理」自定义模型
 * @param {() => void} [deps.restart] 前端「重启服务」回调（admin 触发）
 */
export function startServer(deps) {
  const { config } = deps
  const proxy = createProxyHandler(deps)
  const web = createWebApi(deps)

  // 运行时 catalog 自动同步（对齐 trefeon Registry.Refresh：启动立即一次 + 每 6h，
  // 失败保留旧缓存）。不阻塞启动；失败静默回落内置 catalog。
  //
  // 缓存路径必须落在 dataDir（Docker 挂载卷 /data）：旧版写死源码目录旁的
  // <repo>/data，容器里就是只读的 /app/data → mkdir EACCES，同步永远失败
  // （issue #9）。这里先把路径切到 <dataDir>/ 并重读缓存，再启动同步循环。
  try {
    import('./model.js')
      .then(async (m) => {
        // 缓存缺失（首次启动 / 挂载卷为空）时先落一份内置 catalog：写不进就
        // 只告警，绝不影响启动与代理可用性。
        try {
          const cache = m.applyCatalogCache?.(config.server.dataDir)
          if (cache?.path && cache.models?.length) {
            const { writeCatalogCache } = await import('./catalog/runtime-sync.mjs')
            writeCatalogCache(cache.path, {
              version: 1,
              syncedAt: new Date().toISOString(),
              source: 'builtin:src/catalog/freebuff-catalog.json',
              models: cache.models,
            })
          }
        } catch (err) {
          logger.warn('catalog cache seed skipped', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
        m.startCatalogSync?.({
          log: (msg) => logger.info(msg),
          // catalog 拉 GitHub 源也走配置的代理（含全局池），避免旁路直连。
          fetchImpl: createProxyFetch(config).fetch,
        })
      })
      .catch((err) => {
        logger.warn('catalog auto-sync disabled', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
  } catch (err) {
    logger.warn('catalog auto-sync disabled', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

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
