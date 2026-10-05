/**
 * 目录驱动的模型表 ---- 薄门面, 实现见 src/catalog-models.ts.
 *
 * 为什么保留这个 .js 路径(而不是把消费者都改成 .ts):
 *
 *   test/smoke.mjs 与 test/verify-*.mjs 有 6 处硬编码源码路径读文件做断言,
 *   bin/ 与 src/proxy.js 的 import 也写的是 .js. Node 能 import .ts, 但一旦
 *   把文件名整体改掉, 那些读源码的断言会落进 try/catch 的静默分支 --
 *   断言失效但不报红, 这比改名带来的整洁更贵.
 *
 * 口径: 薄门面只许 re-export, 不得有实现.
 */
export { buildCatalogDrivenModelsResponse } from './catalog-models.ts'
