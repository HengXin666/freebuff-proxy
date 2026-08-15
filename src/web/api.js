import {
  readRequestBody,
  sendJson,
  parseCookies,
  serializeCookie,
} from '../util/http.js'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { buildModelsListResponse } from '../model.js'
import {
  saveAccountUser,
  coerceUser,
  accountKeyOf,
  deleteAccountUser,
  listAccounts,
  readJsonFile,
  writeJsonFile,
} from '../auth-store.js'
import { logger } from '../util/log.js'

const SESSION_COOKIE = 'fb_session'

/**
 * Control-plane HTTP API for the dashboard (login, users, accounts, login flows).
 *
 * @param {{
 *   config: any,
 *   userStore: import('./user-store.js').UserStore,
 *   webSessions: import('./session-store.js').WebSessionStore,
 *   loginFlows: import('./login-flows.js').LoginFlowManager,
 *   runtimes: any,
 *   proxyStore?: import('./proxy-store.js').ProxyStore,
 *   settingsStore?: import('./settings-store.js').SettingsStore,
 *   restart?: () => void,
 * }} deps
 */
export function createWebApi(deps) {
  const {
    config,
    userStore,
    webSessions,
    loginFlows,
    runtimes,
    proxyStore,
    settingsStore,
  } = deps

  function getSessionUser(req) {
    const cookies = parseCookies(req.headers.cookie)
    const token = cookies[SESSION_COOKIE]
    const username = token ? webSessions.get(token) : null
    return username ? userStore.getByUsername(username) : null
  }

  function requireUser(req, res) {
    const user = getSessionUser(req)
    if (!user) {
      sendJson(res, 401, { error: '未登录或会话已过期' })
      return null
    }
    return user
  }

  async function readJson(req) {
    const buf = await readRequestBody(req, 2 * 1024 * 1024)
    if (!buf || !buf.length) return {}
    return JSON.parse(buf.toString('utf8') || '{}')
  }

  /**
   * @returns {Promise<boolean>} handled
   */
  async function handle(req, res, url) {
    const method = (req.method || 'GET').toUpperCase()
    const path = url.pathname

    // Freebuff upstream API surface (/api/v1/*) is never exposed.
    if (path.startsWith('/api/v1/')) {
      sendJson(res, 404, {
        error: `No route for ${method} ${path}`,
        type: 'invalid_request_error',
        code: 'not_found',
      })
      return true
    }

    // --- public: login ---
    if (method === 'POST' && path === '/api/auth/login') {
      let body
      try {
        body = await readJson(req)
      } catch {
        sendJson(res, 400, { error: '无效的 JSON' })
        return true
      }
      const user = userStore.verifyPassword(body.username, body.password)
      if (!user) {
        sendJson(res, 401, { error: '用户名或密码错误' })
        return true
      }
      const token = webSessions.create(user.username)
      res.setHeader(
        'set-cookie',
        serializeCookie(SESSION_COOKIE, token, {
          maxAge: config.web.sessionTtlHours * 3600,
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: Boolean(config.web.cookieSecure),
        }),
      )
      sendJson(res, 200, { ok: true, user })
      return true
    }

    // --- session required ---
    const user = requireUser(req, res)
    if (!user) return true

    if (method === 'POST' && path === '/api/system/reconnect') {
      // 前端「全部断开重连」：比重启更轻量。释放所有账号 session、清理死任务，
      // 下一个请求自动 admit 全新 session；进程不重启。
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '需要管理员权限' })
        return true
      }
      logger.info('reconnect-all requested via web console', {
        by: user.username,
      })
      const accounts = await runtimes.reconnectAll()
      sendJson(res, 200, {
        ok: true,
        message:
          '已断开全部 session，下次请求将自动重建；正在传输的连接可能被中断',
        accounts,
      })
      return true
    }

    if (method === 'POST' && path === '/api/system/restart') {
      // 前端「重启服务」：admin 专属，彻底解决幽灵连接等进程级问题。
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '需要管理员权限' })
        return true
      }
      if (typeof deps.restart !== 'function') {
        sendJson(res, 501, { error: '当前进程未启用重启功能' })
        return true
      }
      logger.info('system restart requested via web console', {
        by: user.username,
      })
      sendJson(res, 200, { ok: true, message: '服务正在重启，约几秒后恢复' })
      // 先让响应完整落地到客户端，再触发自重启
      setTimeout(() => {
        try {
          deps.restart()
        } catch (err) {
          logger.error('system restart failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }, 300)
      return true
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      const cookies = parseCookies(req.headers.cookie)
      if (cookies[SESSION_COOKIE]) webSessions.destroy(cookies[SESSION_COOKIE])
      res.setHeader(
        'set-cookie',
        serializeCookie(SESSION_COOKIE, '', {
          maxAge: 0,
          path: '/',
          httpOnly: true,
        }),
      )
      sendJson(res, 200, { ok: true })
      return true
    }

    if (method === 'GET' && path === '/api/me') {
      const apiKey = userStore.getByUsername(user.username)?.apiKey
      sendJson(res, 200, { user: { ...sanitize(user), apiKey } })
      return true
    }

    if (method === 'GET' && path === '/api/overview') {
      let models = []
      try {
        models = buildModelsListResponse({ includeAllCatalog: true }).data
      } catch {
        models = []
      }
      sendJson(res, 200, {
        accounts: runtimes.list(),
        accountCount: runtimes.allKeys().length,
        models: models.length,
        upstream: {
          apiBase: config.upstream.apiBase,
          loginBase: config.upstream.loginBase,
        },
        dataDir: config.server.dataDir,
        version: process.env.npm_package_version || '1.0.0',
      })
      return true
    }

    if (method === 'GET' && path === '/api/models') {
      let accessTier = null
      let extraIds = []
      const accounts = runtimes.list()
      if (accounts.length) {
        try {
          const rt = runtimes.getAny()
          const session = await rt.upstream.freebuffSession('GET')
          if (session?.accessTier === 'full' || session?.accessTier === 'limited') {
            accessTier = session.accessTier
          }
          extraIds = (session?.rateLimitsByModel
            ? Object.keys(session.rateLimitsByModel)
            : []
          ).concat(session?.model ? [session.model] : [])
        } catch {
          // static catalog below
        }
      }
      sendJson(
        res,
        200,
        buildModelsListResponse({ accessTier, extraIds, includeAllCatalog: true }),
      )
      return true
    }

    // ---- accounts (any logged-in user can view; manage = admin) ----
    if (method === 'GET' && path === '/api/accounts') {
      sendJson(res, 200, { object: 'list', data: runtimes.list() })
      return true
    }

    if (path.startsWith('/api/accounts/login')) {
      return handleLoginFlows(method, path, req, res, user)
    }

    if (method === 'POST' && path === '/api/accounts/import') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '需要管理员权限' })
        return true
      }
      let body
      try {
        body = await readJson(req)
      } catch {
        sendJson(res, 400, { error: '无效的 JSON' })
        return true
      }
      let raw = body
      if (typeof body.json === 'string') {
        try {
          raw = JSON.parse(body.json)
        } catch {
          sendJson(res, 400, { error: 'json 字段不是合法 JSON' })
          return true
        }
      }
      const u = coerceUser(raw)
      if (!u) {
        sendJson(res, 400, {
          error: '缺少 email / authToken（或格式不对）',
          hint: '期望形如 {"email":"you@example.com","authToken":"..."}，可带 "id"（Freebuff 用户ID，GitHub/Google 同邮箱的两个账号给不同 id 就不会互相覆盖）',
        })
        return true
      }
      const saved = saveAccountUser(runtimes.dir, u)
      // Drop any cached runtime so the fresh token is picked up
      try {
        await runtimes.invalidate(saved.key)
      } catch {
        // ignore
      }
      // 只读探测预热：导入后立即刷新 session/额度缓存（不占额度）
      try {
        const rt = runtimes.get(saved.key)
        await rt.sessions.refresh()
      } catch {
        // ignore — 探测失败不影响导入
      }
      logger.info('account imported via web', { key: saved.key, email: saved.user.email })
      sendJson(res, 200, { ok: true, account: saved.user.email, key: saved.key, id: saved.user.id || null })
      return true
    }

    const acctMatch = path.match(/^\/api\/accounts\/([^/]+)$/)
    if (acctMatch && method === 'PATCH') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '需要管理员权限' })
        return true
      }
      const key = decodeURIComponent(acctMatch[1])
      let body
      try {
        body = await readJson(req)
      } catch {
        sendJson(res, 400, { error: '无效的 JSON' })
        return true
      }
      const row = findAccountRow(runtimes.dir, key)
      if (!row) {
        sendJson(res, 404, { error: '账号不存在' })
        return true
      }
      const raw = readJsonFile(row.path)
      if (!raw) {
        sendJson(res, 404, { error: '账号不存在' })
        return true
      }
      const proxy =
        typeof body.proxy === 'string' && body.proxy.trim()
          ? body.proxy.trim()
          : null
      raw.proxy = proxy
      writeJsonFile(row.path, raw)
      // 让新的出口代理立即生效：丢弃缓存的 runtime
      await runtimes.invalidate(row.key)
      logger.info('account proxy updated via web', { key: row.key, email: row.email, proxy })
      sendJson(res, 200, { ok: true, key: row.key, email: row.email, proxy })
      return true
    }

    if (acctMatch && method === 'DELETE') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '需要管理员权限' })
        return true
      }
      const key = decodeURIComponent(acctMatch[1])
      await runtimes.invalidate(key)
      const removed = deleteAccountUser(runtimes.dir, key)
      if (!removed) {
        sendJson(res, 404, { error: '账号不存在' })
        return true
      }
      sendJson(res, 200, { ok: true, key })
      return true
    }

    if (method === 'POST' && path === '/api/accounts/probe') {
      // 只读探测：对每个账号 GET session，刷新 session/额度缓存。
      // 不创建 session、不占免费额度；fresh 账号若上游无使用记录则额度仍为空。
      const results = []
      for (const a of runtimes.list()) {
        try {
          const rt = runtimes.get(a.key)
          await rt.sessions.refresh()
          results.push({ key: a.key, email: a.email, ok: true })
        } catch (err) {
          results.push({
            key: a.key,
            email: a.email,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      sendJson(res, 200, { ok: true, results, accounts: runtimes.list() })
      return true
    }

    const cooldownMatch = path.match(/^\/api\/accounts\/([^/]+)\/cooldown\/clear$/)
    if (cooldownMatch && method === 'POST') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '需要管理员权限' })
        return true
      }
      const key = decodeURIComponent(cooldownMatch[1])
      runtimes.clearCooldown(key)
      sendJson(res, 200, { ok: true })
      return true
    }

    // ---- user management (admin) ----
    if (path === '/api/users' && method === 'GET') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '需要管理员权限' })
        return true
      }
      sendJson(res, 200, { object: 'list', data: userStore.all().map(sanitize) })
      return true
    }

    if (path === '/api/users' && method === 'POST') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '需要管理员权限' })
        return true
      }
      let body
      try {
        body = await readJson(req)
      } catch {
        sendJson(res, 400, { error: '无效的 JSON' })
        return true
      }
      try {
        const created = userStore.create({
          username: body.username,
          password: body.password,
          role: body.role,
        })
        sendJson(res, 200, { ok: true, user: created })
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return true
    }

    const userMatch = path.match(/^\/api\/users\/([^/]+)(?:\/([^/]+))?$/)
    if (userMatch && user.role === 'admin') {
      const username = decodeURIComponent(userMatch[1])
      const action = userMatch[2]
      const target = userStore.getByUsername(username)
      if (!target) {
        sendJson(res, 404, { error: '用户不存在' })
        return true
      }

      if (!action && method === 'PATCH') {
        let body
        try {
          body = await readJson(req)
        } catch {
          sendJson(res, 400, { error: '无效的 JSON' })
          return true
        }
        try {
          if (body.role !== undefined) userStore.setRole(username, body.role)
          sendJson(res, 200, { ok: true, user: sanitize(userStore.getByUsername(username)) })
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return true
      }

      if (!action && method === 'DELETE') {
        if (target.username === user.username) {
          sendJson(res, 400, { error: '不能删除自己' })
          return true
        }
        userStore.delete(username)
        sendJson(res, 200, { ok: true })
        return true
      }

      if (action === 'reset-key' && method === 'POST') {
        const key = userStore.resetApiKey(username)
        sendJson(res, 200, { ok: true, apiKey: key })
        return true
      }

      if (action === 'password' && method === 'POST') {
        let body
        try {
          body = await readJson(req)
        } catch {
          sendJson(res, 400, { error: '无效的 JSON' })
          return true
        }
        try {
          userStore.setPassword(username, body.password)
          sendJson(res, 200, { ok: true })
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return true
      }

      sendJson(res, 404, { error: '未知操作' })
      return true
    }

    if (path === '/api/config' && method === 'GET' && user.role === 'admin') {
      sendJson(res, 200, {
        config: {
          server: {
            host: config.server.host,
            port: config.server.port,
            dataDir: config.server.dataDir,
            apiKeyCount: config.server.apiKeys.length,
          },
          upstream: {
            apiBase: config.upstream.apiBase,
            loginBase: config.upstream.loginBase,
            proxy: config.upstream.proxy || envProxyOrNull(),
            proxies: config.upstream.proxies || [],
            credentialsDir: config.upstream.credentialsDir,
          },
          web: config.web,
        },
      })
      return true
    }

    if (method === 'GET' && path === '/api/settings') {
      sendJson(res, 200, {
        freeToolSignatureEnabled:
          settingsStore?.get().freeToolSignatureEnabled !== false,
        accountMaxConcurrency: settingsStore?.get().accountMaxConcurrency ?? 1,
        minimalRoutingEnabled: settingsStore?.get().minimalRoutingEnabled === true,
        minimalRoutingMode: settingsStore?.get().minimalRoutingMode ?? 'auto',
      })
      return true
    }

    if (method === 'POST' && path === '/api/settings') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '需要管理员权限' })
        return true
      }
      if (!settingsStore) {
        sendJson(res, 501, { error: '当前进程未启用运行设置存储' })
        return true
      }
      let body
      try {
        body = await readJson(req)
      } catch {
        sendJson(res, 400, { error: '无效的 JSON' })
        return true
      }
      const patch = {}
      if (body.freeToolSignatureEnabled !== undefined) {
        if (typeof body.freeToolSignatureEnabled !== 'boolean') {
          sendJson(res, 400, {
            error: 'freeToolSignatureEnabled 必须是布尔值',
          })
          return true
        }
        patch.freeToolSignatureEnabled = body.freeToolSignatureEnabled
      }
      if (body.accountMaxConcurrency !== undefined) {
        if (
          !Number.isInteger(body.accountMaxConcurrency) ||
          body.accountMaxConcurrency < 1 ||
          body.accountMaxConcurrency > 16
        ) {
          sendJson(res, 400, {
            error: 'accountMaxConcurrency 必须是 1..16 的整数',
          })
          return true
        }
        patch.accountMaxConcurrency = body.accountMaxConcurrency
      }
      if (body.minimalRoutingEnabled !== undefined) {
        if (typeof body.minimalRoutingEnabled !== 'boolean') {
          sendJson(res, 400, {
            error: 'minimalRoutingEnabled 必须是布尔值',
          })
          return true
        }
        patch.minimalRoutingEnabled = body.minimalRoutingEnabled
      }
      if (body.minimalRoutingMode !== undefined) {
        if (!['auto', 'spec', 'react', 'weak'].includes(body.minimalRoutingMode)) {
          sendJson(res, 400, {
            error: 'minimalRoutingMode 必须是 auto/spec/react/weak 之一',
          })
          return true
        }
        patch.minimalRoutingMode = body.minimalRoutingMode
      }
      if (!Object.keys(patch).length) {
        sendJson(res, 400, {
          error: '没有可保存的设置项',
        })
        return true
      }
      const settings = settingsStore.save(patch)
      logger.info('runtime settings updated via web', settings)
      sendJson(res, 200, { ok: true, ...settings })
      return true
    }

    if (method === 'GET' && path === '/api/proxy') {
      const configured = proxyStore ? proxyStore.list() : config.upstream.proxies || []
      sendJson(res, 200, {
        proxies: configured,
        // 实际生效的代理（含单代理/环境变量），用于前端展示
        effective: uniqueStrings([
          ...(configured || []),
          ...(config.upstream.proxy ? [config.upstream.proxy] : []),
          ...(envProxyOrNull() ? [envProxyOrNull()] : []),
        ]),
        accounts: runtimes.list().map((a) => ({
          key: a.key,
          id: a.id || null,
          email: a.email,
          proxy: a.proxy || null,
          effectiveProxy: a.effectiveProxy || null,
        })),
      })
      return true
    }

    if (method === 'POST' && path === '/api/proxy') {
      if (user.role !== 'admin') {
        sendJson(res, 403, { error: '需要管理员权限' })
        return true
      }
      if (!proxyStore) {
        sendJson(res, 501, { error: '当前进程未启用代理存储' })
        return true
      }
      let body
      try {
        body = await readJson(req)
      } catch {
        sendJson(res, 400, { error: '无效的 JSON' })
        return true
      }
      const proxies = proxyStore.save(body.proxies)
      // 立即生效：更新运行配置并重建缓存 runtime（释放旧 session、走新出口）
      config.upstream.proxies = proxies
      await runtimes.invalidateProxies()
      logger.info('proxy pool updated via web', { proxies })
      sendJson(res, 200, {
        ok: true,
        proxies,
        note: proxies.length
          ? '已保存并立即生效（账号出口已切换）'
          : '已清空全局代理池（将走环境变量/直连）',
      })
      return true
    }

    if (method === 'POST' && path === '/api/proxy/test') {
      // 代理连通性测试：走该代理访问 Cloudflare trace 拿出口 IP/地区，再探测 codebuff。
      // 只读、无副作用；body.proxy 为空时测试当前生效的代理配置。
      let body = {}
      try {
        body = await readJson(req)
      } catch {
        // ignore
      }
      const requested =
        typeof body.proxy === 'string' && body.proxy.trim()
          ? body.proxy.trim()
          : null
      let candidates = []
      if (requested) {
        candidates = [requested]
      } else {
        const pool = proxyStore ? proxyStore.list() : config.upstream.proxies || []
        for (const p of pool) if (p) candidates.push(p)
        if (config.upstream.proxy) candidates.push(config.upstream.proxy)
        const envProxy = envProxyOrNull()
        if (envProxy && !candidates.includes(envProxy)) candidates.push(envProxy)
      }
      if (!candidates.length) {
        sendJson(res, 200, {
          ok: true,
          results: [],
          note: '未配置任何代理（当前直连）。可在 config 配 upstream.proxies 或给本接口传 proxy。',
        })
        return true
      }
      const results = []
      for (const p of candidates) {
        results.push(await testProxyUrl(p))
      }
      sendJson(res, 200, { ok: true, results })
      return true
    }

    sendJson(res, 404, { error: `未知接口 ${method} ${path}` })
    return true
  }

  // ---- login flows (admin) ----
  async function handleLoginFlows(method, path, req, res, user) {
    if (user.role !== 'admin') {
      sendJson(res, 403, { error: '需要管理员权限' })
      return true
    }
    if (method === 'POST' && path === '/api/accounts/login') {
      try {
        const flow = await loginFlows.start()
        logger.info('web login flow started', { id: flow.id })
        sendJson(res, 200, { ok: true, flow })
      } catch (err) {
        sendJson(res, 502, {
          error: `发起登录失败: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      return true
    }
    if (method === 'GET' && path === '/api/accounts/login') {
      sendJson(res, 200, { object: 'list', data: loginFlows.list() })
      return true
    }
    const m = path.match(/^\/api\/accounts\/login\/([^/]+)(?:\/([^/]+))?$/)
    if (m) {
      const id = m[1]
      const action = m[2]
      if (!action && method === 'GET') {
        const flow = loginFlows.get(id)
        if (!flow) {
          sendJson(res, 404, { error: '流程不存在' })
          return true
        }
        sendJson(res, 200, { flow })
        return true
      }
      if (action === 'cancel' && method === 'POST') {
        loginFlows.cancel(id)
        sendJson(res, 200, { ok: true })
        return true
      }
    }
    sendJson(res, 404, { error: '未知登录流程操作' })
    return true
  }

  return { handle }
}

function sanitize(user) {
  if (!user) return null
  const { salt, passwordHash, ...rest } = user
  return rest
}

/**
 * 通过指定代理做连通性测试：
 * 1. GET https://www.cloudflare.com/cdn-cgi/trace → 出口 IP + 国家（证明真的走了该代理）
 * 2. GET https://codebuff.com/ → 真实目标可达性
 * @param {string} proxyUrl
 * @param {number} [timeoutMs]
 */
async function testProxyUrl(proxyUrl, timeoutMs = 12_000) {
  const started = Date.now()
  /** @type {{proxy: string, ok: boolean, error: string | null, ip: string | null, country: string | null, latencyMs: number | null, codebuffStatus: number | null}} */
  const out = {
    proxy: proxyUrl,
    ok: false,
    error: null,
    ip: null,
    country: null,
    latencyMs: null,
    codebuffStatus: null,
  }
  let agent
  try {
    agent = new ProxyAgent({ uri: proxyUrl })
  } catch (err) {
    out.error = `代理地址解析失败: ${err instanceof Error ? err.message : String(err)}`
    out.latencyMs = Date.now() - started
    return out
  }
  try {
    const traceRes = await undiciFetch('https://www.cloudflare.com/cdn-cgi/trace', {
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (traceRes.ok) {
      const text = await traceRes.text()
      out.ip = text.match(/^ip=(.+)$/m)?.[1] || null
      out.country = text.match(/^loc=(.+)$/m)?.[1] || null
    } else {
      out.error = `trace HTTP ${traceRes.status}`
    }
    try {
      const cbRes = await undiciFetch('https://codebuff.com/', {
        dispatcher: agent,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      })
      out.codebuffStatus = cbRes.status
    } catch {
      out.codebuffStatus = null
    }
    out.ok = true
  } catch (err) {
    const cause = err && err.cause
    const causeCode =
      cause && typeof cause === 'object' && cause.code
        ? String(cause.code)
        : null
    out.error =
      (err instanceof Error ? err.message : String(err)) +
      (causeCode ? ` (${causeCode})` : '')
  } finally {
    out.latencyMs = Date.now() - started
  }
  if (!out.ok && String(proxyUrl).includes('host.docker.internal')) {
    out.hint =
      'host.docker.internal 只表示"跑容器的那台宿主机本身"：仅当代理就运行在这台宿主机上才可能通' +
      '（且需代理监听 0.0.0.0 / Clash 开 Allow LAN）。' +
      '如果你的代理在其他机器上，直接填它的真实 IP，例如 http://192.168.1.10:2334。'
  }
  return out
}

function uniqueStrings(arr) {
  return [...new Set((arr || []).filter(Boolean).map(String))]
}

function envProxyOrNull() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null
  )
}

/**
 * 按 key（id 或邮箱）定位账号行；邮箱匹配仅在唯一命中时生效
 * （同邮箱多个账号时必须以 key 精确指定，否则视为不存在）。
 */
function findAccountRow(dir, key) {
  const rows = listAccounts(dir)
  const norm = String(key || '').trim()
  const exact = rows.find((a) => a.key === norm)
  if (exact) return exact
  const ci = rows.find((a) => String(a.key).toLowerCase() === norm.toLowerCase())
  if (ci) return ci
  const emailMatches = rows.filter((a) => a.email === norm.toLowerCase())
  return emailMatches.length === 1 ? emailMatches[0] : null
}
