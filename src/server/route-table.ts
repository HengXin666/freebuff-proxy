/**
 * 路径分流表 ---- 一台服务器上的三张面:对外 LLM 面,控制台面,静态资源面.
 *
 * 分流判定只依赖 pathname,不依赖 method ---- method 的区分在各面内部做
 * (例如 /v1/chat/completions 只接受 POST).
 * 未识别的 /v1/xxx 由 proxy 侧回答结构化 404, 不掉进静态资源面返回 HTML.
 */

/** 三张面的名字. */
export const FACES = {
  proxy: 'proxy',
  console: 'console',
  static: 'static',
}

/**
 * 判断一个 pathname 属于哪张面.
 * @param {string} pathname 请求路径(不含 query)
 * @returns {'proxy'|'console'|'static'} 面的名字
 */
export function faceOf(pathname: any) {
  if (pathname === '/healthz' || pathname === '/health') return FACES.proxy
  if (pathname.startsWith('/v1/')) return FACES.proxy
  if (pathname.startsWith('/api/')) return FACES.console
  return FACES.static
}
