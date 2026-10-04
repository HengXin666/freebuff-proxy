/**
 - HTTP 装配层 —— 把三张面(对外 LLM / 控制台 / 静态资源)接到一个 server 上.
 *
 - 这个文件刻意保持只有装配:路由分流在 ./server/route-table.js,
 - 请求上下文在 ./server/request-context.js,启动副作用在 ./server/startup-tasks.js.
 - 理由是它是全仓最容易膨胀的地方(每加一个路由就想往里塞一段),而它同时是
 - 所有模块的汇聚点 —— 一旦超过 300 行,读它的人得同时装下四五个模块的接口.
 *
 - @see ./server/route-table.js   pathname → 面(含未知路径的处置)
 - @see ./server/startup-tasks.js 启动期副作用(catalog 缓存 seed)
 */
import http from 'node:http'

import { projectRootFromModule } from './config.js'
import { createProxyHandler } from './proxy.js'
import { FACES, faceOf } from './server/route-table.js'
import { withRequestId } from './server/request-context.js'
import { seedCatalogCache } from './server/startup-tasks.js'
import { createWebApi } from './web/api.js'
import { serveStatic } from './web/static.js'
import { logger } from './util/log.js'
import { sendJson } from './util/http.js'
import path from 'node:path'

const dashboardDir = path.join(projectRootFromModule(), 'dashboard')

/**
 - 启动 HTTP 服务器.
 - @param {object} deps 依赖集合(直接透传给 proxy / web 两层)
 - @param {import('./config.js').ProxyConfig} deps.config
 - @param {object} deps.sessions 会话管理器
 - @param {object} deps.upstream 上游客户端
 - @param {string} deps.authToken
 - @param {object} deps.userStore 用户存储
 - @param {object} deps.webSessions 控制台会话
 - @param {object} deps.loginFlows 登录流程管理
 - @param {object} [deps.modelStore] 前端[模型管理]自定义模型
 - @param {() => void} [deps.restart] 前端[重启服务]回调(admin 触发)
 - @returns {Promise<import('node:http').Server>} 已监听的 server
 */
export function startServer(deps) {
  const { config } = deps
  const proxy = createProxyHandler(deps)
  const web = createWebApi(deps)

  seedCatalogCache(config)

  const server = http.createServer((req, res) => {
    withRequestId(req, res, dispatch).catch((err) => {
      logger.error('unhandled request error', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        url: req.url,
      })
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, 500, {
        error: { message: 'Internal proxy error', type: 'proxy_error' },
      })
    })
  })

  /**
   - 把一次请求交给所属的面.
   - @param {import('node:http').IncomingMessage} req 下游请求
   - @param {import('node:http').ServerResponse} res 下游响应
   - @returns {Promise<void>} 处理完成
   */
  async function dispatch(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const face = faceOf(url.pathname)
    if (face === FACES.proxy) return proxy.handle(req, res)
    if (face === FACES.console) return web.handle(req, res, url)
    serveStatic(req, res, url, dashboardDir)
  }

  // 上游超时 + 余量:请求超时必须比上游宽松,否则代理会在收到上游回执前自行掐断
  // (客户端看到 408,而上游其实成功并已经扣了钱).
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
