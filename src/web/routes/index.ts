/**
 * 控制面路由总装.
 *
 * src/web/api.ts 只保留一个薄门面(export { createWebApi }),真正的
 * 实现搬到这里(src/server.ts 只 import web/api.js 一处),
 * 门面能把"拆文件"这件事对外的契约面完全隐藏 ---- 不做的话,拆一次就得
 * 同步改 bin/,test/,文档三处引用.
 *
 * 分派规则(与拆分前的单一 handle 逐条等价):
 *   1. /api/v1/* 一律 404(上游面永不对控制台暴露);
 *   2. 公开域(登录);
 *   3. 身份闸门 ---- 未认证 401,到此为止;
 *   4. 已认证域按域组顺序尝试,各自返回"是否已处理";
 *   5. 全不认 -> 404.
 *
 */
import { sendJson, parseCookies } from '../../util/http.ts'
import { requestSlotStats } from '../../proxy.ts'
import { buildModelsListResponse } from '../../model.ts'
import { readJson } from './lib/helpers.ts'
import { getSessionUser } from './lib/session.ts'
import { DOMAINS as CONTROL_DOMAINS, authPublic } from './control/index.ts'
import { DOMAINS as INVENTORY_DOMAINS } from './inventory/index.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 域组匹配顺序:先控制面,再资源面. */
const DOMAIN_GROUPS = [CONTROL_DOMAINS, INVENTORY_DOMAINS]

/**
 * 组装路由上下文 ---- 把实现里用到的一切依赖收成一个对象.
 *
 *
 * @param {any} deps createWebApi 的依赖
 * @returns {any} 路由上下文
 */
function buildContext(deps: any) {
  return {
    // 身份与存储(各域直接用到的)
    config: deps.config,
    userStore: deps.userStore,
    webSessions: deps.webSessions,
    loginFlows: deps.loginFlows,
    runtimes: deps.runtimes,
    proxyStore: deps.proxyStore,
    settingsStore: deps.settingsStore,
    modelStore: deps.modelStore,
    restart: deps.restart,
    readJson,
    parseCookies,
    requestSlotStats,
    buildModelsListResponse,
  }
}

/**
 * 创建控制面 HTTP API.
 *
 * @param {{
 *   config: any,
 *   userStore: import('../store/session/user-store.ts').UserStore,
 *   webSessions: import('../store/session/session-store.ts').WebSessionStore,
 *   loginFlows: import('../store/session/login-flows.ts').LoginFlowManager,
 *   runtimes: any,
 *   proxyStore?: import('../store/config/proxy-store.ts').ProxyStore,
 *   settingsStore?: import('../store/config/settings-store.ts').SettingsStore,
 *   modelStore?: import('../store/config/model-store.ts').ModelStore,
 *   restart?: () => void,
 * }} deps
 * @returns {{handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>}}
 *   控制面 API
 */
export function createWebApi(deps: any) {
  const ctx = buildContext(deps)

  /**
   * 控制台请求的总入口.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @returns {Promise<boolean>} handled
   */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = (req.method || 'GET').toUpperCase()
    // ! 这个变量名必须是 route:早先这里叫 path,把上面的 node:path 模块
    // 整个遮蔽掉了,于是数据文件自检接口里的 path.basename(...) 变成
    // "path.basename is not a function" ---- 该接口直接 500(真实故障).
    // 路由字符串与 fs 路径语义完全不同,别再用 path 当路由变量名.
    const route = url.pathname

    // Freebuff upstream API surface (/api/v1/*) is never exposed.
    if (route.startsWith('/api/v1/')) {
      sendJson(res, 404, {
        error: `No route for ${method} ${route}`,
        type: 'invalid_request_error',
        code: 'not_found',
      })
      return true
    }

    // --- public: login ---
    if (await authPublic(method, route, req, res, ctx)) return true

    // --- session required ---
    const user = getSessionUser(req, ctx)
    if (!user) {
      sendJson(res, 401, { error: '未登录或会话已过期' })
      return true
    }

    for (const group of DOMAIN_GROUPS) {
      for (const domain of Object.values(group)) {
        if (await domain(method, route, req, res, user, ctx)) return true
      }
    }

    sendJson(res, 404, { error: `未知接口 ${method} ${route}` })
    return true
  }

  return { handle }
}
