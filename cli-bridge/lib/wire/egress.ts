/**
 * bun 侧统一出口 ---- cli-bridge 里所有上游请求的唯一发出口.
 *
 * 主服务(Node)把本次生效的出口地址经 RPC cfg.proxy 下传  --  bun 自己读不到
 * 控制台的代理设置(那在 /data/proxies.json, 由 Node 侧解析). 因此这里的纪律是:
 *
 *   1. 所有上游请求一律走 egressFetch, 不许直接调全局 fetch;
 *   2. 出口只来自 cfg.proxy(配置里写的)或环境变量(bun 自己认 HTTP(S)_PROXY);
 *   3. null / 空串一律表示"直连", 绝不把 null 当代理地址传给 fetch
 *      (实测: proxy='' 会让 bun 抛错, 而 proxy=null 才是直连).
 *
 * 见 .agents/notes/implemented/architecture/2026-10-07-unified-upstream-egress.md
 */

/**
 * 取本次请求该用的 proxy 参数.
 *
 * 只认字符串形态的代理地址; 其余(undefined / null / 空串 / 非字符串)一律
 * 返回 undefined  --  undefined 表示"不覆盖", bun 会按环境变量自行判定;
 * 而 null 表示"显式直连", 两者语义不同, 不能混用.
 *
 * @param {any} cfg 本次 RPC 配置
 * @returns {string | undefined} 交给 fetch 的 proxy 参数
 */
export function proxyOf(cfg: any) {
  const v = cfg?.proxy
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * 统一出口 fetch: 所有上游请求的唯一发出口.
 *
 * @param {any} cfg 本次 RPC 配置(含 proxy)
 * @param {string} url 请求地址
 * @param {Record<string, any>} [init] fetch 初始化
 * @returns {Promise<Response>} 上游响应
 */
export function egressFetch(cfg: any, url: string, init: Record<string, any> = {}) {
  const proxy = proxyOf(cfg)
  return fetch(url, proxy ? { ...init, proxy } : init)
}
