/**
 * 控制面 HTTP API 的薄门面.
 *
 * 实现已按域拆到 src/web/routes/(每个文件 <=300 行,每目录 <=5 个文件),
 * 本文件只保留入口 re-export ---- 因为 src/server.ts 只 import 这一处,
 * 门面能把"内部怎么拆"完全隐藏,拆文件不需要动 bin/,test/,文档.
 *
 * 历史上这里是一个 1847 行的单体(createWebApi 1657 行,内部 handle
 * 1366 行),职责是登录/用户/账号/模型/代理/设置/日志/生命周期的全部路由.
 * 拆分只做搬移与去重,不改任何对外行为;路由对账见
 * 路由按域拆在 ./routes/ 下(每个域一个文件).
 */
export { createWebApi } from './routes/index.ts'
