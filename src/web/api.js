/**
 * 控制面 HTTP API 的薄门面(.js 路径,实现见 ./api.ts).
 *
 * 为什么保留 .js 而不是让消费者都改成 .ts:src/server.js 与 test/smoke.mjs 的
 * import 写的是 .js,且 smoke 里有读源码做断言的用例 -- 整体改名会让那些断言落进
 * try/catch 的静默分支(断言失效但不报红).口径:薄门面只许 re-export.
 */
export { createWebApi } from './api.ts'
