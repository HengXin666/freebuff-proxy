/**
 * 目录抓取 -- CatalogHolder 的 fetch / _fetchViaBun / _doFetch 的实现.
 *
 * 每个分支只做一件事: 优先走 bun / 走 Node 的头集 / 退避 / 错误翻译.
 */
import { logger } from '../../util/log.ts'
import {
  CATALOG_FETCH_USER_AGENT,
  CATALOG_PATH,
  CATALOG_PROTOCOL_VERSION,
  CLIENT_DESKTOP,
  HEADER_CATALOG_PROTOCOL,
  HEADER_CLIENT,
} from './constants.ts'

/**
 * 优先在 bun 里抓目录(与官方客户端同一个运行时).
 *
 * 走 bun 才叫"一致"(见 docs/reverse/19 §19.10):
 * Node 26 的内置 fetch 会自动加两个头, 且 sec-fetch-mode: cors 属于
 * forbidden header, 设不掉:
 *
 * Node 26  -> connection / authorization / catalog-protocol / client /
 *             user-agent / accept / accept-language /
 *             sec-fetch-mode: cors / accept-encoding
 * Bun 1.4.2 -> connection / authorization / catalog-protocol / client /
 *             user-agent / accept / accept-encoding      (与客户端一致)
 *
 * 客户端就是 bun 跑的, 所以只有 bun 这一跳能做到逐字节相同.
 * bun 不可用(未随镜像分发 / 执行失败)时退回 Node 路径, 可用性优先.
 * @param {any} holder CatalogHolder 实例
 * @returns {Promise<any|null>} 目录原文;不可用返回 null
 */
export async function fetchViaBun(holder: any) {
  if (!holder.bunFetch) return null
  try {
    const out = await holder.bunFetch({
      //  apiHost 必须带走:主服务指向本地镜像做对照时,bun 侧也要打到镜像.
      cfg: { token: holder.token, apiHost: holder.apiHost || null },
      action: 'catalog',
    })
    const body = out?.catalog
    if (!body || !Array.isArray(body.rows) || !body.rows.length) return null
    if (typeof body.fetchId !== 'string' || !body.fetchId) return null
    return body
  } catch {
    return null
  }
}

/**
 * 走 Node 内置 fetch 抓一次目录, 失败时设退避.
 * @param {any} holder CatalogHolder 实例
 * @returns {Promise<any|null>} 目录响应原文;失败返回 null
 */
async function fetchViaNode(holder: any) {
  const url = `${holder.apiHost}${CATALOG_PATH}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), holder.timeoutMs)
  if (timer.unref) timer.unref()
  try {
    const res = await holder.fetchImpl(url, {
      method: 'GET',
      // 头集逐字对齐官方抓包的 catalog 那一条(2026-10-03,77 条里 1 条):
      //
      //   Authorization: Bearer <token>
      //   x-freebuff-catalog-protocol: 1
      //   x-freebuff-client: desktop
      //   User-Agent: Bun/1.4.2
      //   Accept: */*
      //
      // 不发这三个(见 docs/reverse/19 §19.2):
      //   - x-codebuff-api-key:全 77 条抓包出现 0 次;
      //   - install-id / first-tab-discount / multi-session /
      //     include-unused-rate-limits:那些是 session 那跳的头;
      //   - 设备签名三头:官方时序是 catalog(无签名)-> device-keys ->
      //     session(开始签名),catalog 这一跳不签.
      headers: {
        authorization: `Bearer ${holder.token}`,
        [HEADER_CATALOG_PROTOCOL]: CATALOG_PROTOCOL_VERSION,
        [HEADER_CLIENT]: CLIENT_DESKTOP,
        'user-agent': CATALOG_FETCH_USER_AGENT,
        accept: '*/*',
        /**
         - 这两个是 Node 内置 fetch 自动加的,客户端(bun)不发:
         - - accept-language: * -- 显式设空串即可消除;
         - - sec-fetch-mode: cors -- forbidden header,设不掉.
         *
         - 对照(本地镜像 + 裸 fetch):
         - Node 26 fetch -> 自动带 accept-language / sec-fetch-mode
         - Bun 1.4.2    -> 只带业务头,与客户端抓包逐项一致
         - 要彻底一致只能让请求跑在 bun 上(见 docs/reverse/19 §19.10).
         */
        'accept-language': '',
        // 客户端发的是这四种(含 br / zstd),Node 默认只给 gzip, deflate
        'accept-encoding': 'gzip, deflate, br, zstd',
      },
      signal: ac.signal,
    })
    if (!res.ok) {
      logger.warn('catalog fetch rejected', { status: res.status })
      return null
    }
    return await res.json()
  } catch (err) {
    logger.debug('catalog fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 实际抓取:先 bun 后 Node 两条路径, 共用同一套解析.
 * @param {any} holder CatalogHolder 实例
 * @returns {Promise<boolean>} 是否成功
 */
export async function doFetch(holder: any): Promise<boolean> {
  /**
   - bun 路径拿到的就是目录原文(已在 bun 侧按客户端头集发出),
   - 直接走同一套解析,避免两条解析逻辑.
   */
  const viaBun = await fetchViaBun(holder)
  if (viaBun) {
    holder._apply(viaBun)
    logger.info('catalog fetched via bun (client-identical headers)', {
      fetchId: String(viaBun.fetchId).slice(0, 24) + '...',
      rows: viaBun.rows.length,
      version: viaBun.version ?? null,
    })
    return true
  }
  const body = await fetchViaNode(holder)
  const applied = body ? holder._apply(body) : false
  if (!applied) {
    holder.retryAfter = Date.now() + 5 * 60_000
    return false
  }
  return true
}
