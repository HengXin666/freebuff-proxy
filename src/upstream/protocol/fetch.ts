/**
 * 目录抓取 -- 从 CatalogHolder 的 fetch / _fetchViaBun / _doFetch 按职责抽出.
 *
 * 为什么抽出来: 原 _doFetch 是 82 行的单方法, 同时管"优先走 bun / 走 Node 的
 * 头集 / 退避 / 错误翻译"四件事. 抽成模块级函数后, 每个分支只做一件事, 且
 * 头集与 bun 参数不再埋在方法体里.
 *
 * 口径: 纯搬移, 不改行为. 逐字节对齐官方抓包的头集与注释原样保留.
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
 * 为什么必须走 bun 才叫"一致"(实测, docs/reverse/19 §19.10):
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
      //  apiHost 必须带走:主服务指向本地镜像做对照时,bun 侧也要
      // 打到镜像,否则会真的请求上游.
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
      //  头集逐字对齐官方抓包(2026-10-03,77 条里 catalog 那 1 条原样):
      //
      //   Authorization: Bearer <token>
      //   x-freebuff-catalog-protocol: 1
      //   x-freebuff-client: desktop
      //   User-Agent: Bun/1.4.2
      //   Accept: 星号斜杠星号
      //
      // 三个此前多发的东西,全部删掉(见 docs/reverse/19 §19.2):
      //   - x-codebuff-api-key:全 77 条抓包出现 0 次;
      //   - install-id / first-tab-discount / multi-session /
      //     include-unused-rate-limits:那些是 session 那跳的头,
      //     我们此前串台带到了 catalog 上;
      //   - 设备签名三头:官方时序是 catalog(无签名)-> device-keys ->
      //     session(开始签名),catalog 这一跳本来就不签.
      headers: {
        authorization: `Bearer ${holder.token}`,
        [HEADER_CATALOG_PROTOCOL]: CATALOG_PROTOCOL_VERSION,
        [HEADER_CLIENT]: CLIENT_DESKTOP,
        'user-agent': CATALOG_FETCH_USER_AGENT,
        accept: '*/*',
        /**
         - 这两个是 Node 内置 fetch 自动加的,客户端(bun)不发:
         - - accept-language: 星号 -- 显式设空串即可消除;
         - - sec-fetch-mode: cors -- forbidden header,设不掉.
         *
         - 实测(本地镜像 + 裸 fetch 对照):
         - Node 26 fetch -> 自动带 accept-language / sec-fetch-mode
         - Bun 1.4.2    -> 只带 5 个业务头,与客户端抓包逐项一致
         - 所以这两个头是运行时差异,要彻底一致只能让请求跑在 bun 上
         - (见 docs/reverse/19 §19.10).这里先把能消除的消除.
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
