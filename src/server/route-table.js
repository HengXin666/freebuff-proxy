/**
 * 路径分流表 ---- 一台服务器上的三张面:对外 LLM 面,控制台面,静态资源面.
 *
 * 为什么要把这张表抽出来(而不是留在 startServer 里):
 *
 *   1. 它是"改一处坏一片"的高风险点:/v1/* 与 /api/* 的边界写错,
 *      症状是某个面整体 404/500,而单测往往只覆盖其中一面;
 *   2. 分流规则要能被单独断言(test/ 侧的用例),包括未知路径的处置
 *      ---- 未识别的 /v1/xxx 必须由 proxy 侧回答结构化 404,而不是掉进
 *      静态资源面返回 HTML.
 *
 * 分流决策只依赖 pathname,不依赖 method ---- method 的区分在各面内部做
 * (例如 /v1/chat/completions 只接受 POST).把 method 拿进来会让这张表
 * 变成一张永远补不全的路由清单.
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
export function faceOf(pathname) {
  if (pathname === '/healthz' || pathname === '/health') return FACES.proxy
  if (pathname.startsWith('/v1/')) return FACES.proxy
  if (pathname.startsWith('/api/')) return FACES.console
  return FACES.static
}
