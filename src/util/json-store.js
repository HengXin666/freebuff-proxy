/**
 * util/json-store 的薄门面(-- facade):实现已迁到 src/util/json-store.ts.
 *
 * 为什么保留 .js 路径:src/web/** 与 src/session-handles.js 等大量消费者
 * 写的是 'util/json-store.js'.Node 能 import .ts,但整仓改名会把风险扩散到别人的
 * 写范围;门面让"实现转 TS"与"消费者改名"解耦.口径:只许 re-export.
 */
export * from './json-store.ts'
