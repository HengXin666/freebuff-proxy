import { t } from '../../locale/index.ts'

/**
 * 跨视图联动注册表 ---- 让视图模块之间不互相 import.
 *
 *
 *
 * 因此约定:跨视图调用一律走本表.谁提供实现在 app.js 装配层注册(那是
 * 唯一知道全部视图的地方),谁使用就 need(name) 取.运行时解析, 不用静态 import;
 * import,环就断在这里.
 *
 * 范围限定:只登记[视图 -> 视图]的联动.lib/ 下的纯工具(dom/api/format 等)
 * 不在此列,照常静态 import ---- 它们没有反向依赖,不存在成环风险.
 *
 * 见 .agents/notes/implemented/architecture/2026-10-05-entry-and-frontend-lib-split.md
 */

/** 已登记的跨视图回调(名字 -> 实现). */
const handlers = new Map()

/**
 * 登记一批跨视图回调(由入口装配层在启动时调用一次).
 * @param {Record<string, Function>} map 名字 -> 实现
 * @returns {void}
 */
export function registerHooks(map: any) {
  for (const [name, fn] of Object.entries(map || {})) {
    if (typeof fn !== 'function') {
      throw new TypeError(t('hooks.notFunction', { name, type: typeof fn }))
    }
    handlers.set(name, fn)
  }
}

/**
 * 取一个跨视图回调.取不到直接抛错,不静默返回空函数.
 *
 * 判据:静默空实现会让[装配层漏注册]表现成[按钮点了没反应]----那是本仓
 * 里以明确的[跨视图回调未注册: X]暴露出来.
 * @param {string} name 回调名
 * @returns {Function} 该回调
 */
export function need(name: any) {
  const fn = handlers.get(name)
  if (!fn) {
    throw new Error(t('hooks.notRegistered', { name }))
  }
  return fn
}
