/**
 * 控制面 HTTP API 的薄门面.
 *
 * 实现已按域拆到 src/web/routes/(每个文件 <=300 行,每目录 <=5 个文件),
 * 本文件只保留入口 re-export(src/server.ts 只 import 这一处),
 * 门面能把"内部怎么拆"完全隐藏,拆文件不需要动 bin/,test/,文档.
 *
 */
export { createWebApi } from './routes/index.ts'
