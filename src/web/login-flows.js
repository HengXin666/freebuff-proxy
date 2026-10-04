/**
 * login-flows 的薄门面(.js 路径, 实现见 ./login-flows.ts).
 *
 * 为什么保留 .js 而不是让消费者改成 .ts: 消费者(bin/serve.js 与 test/smoke.mjs)
 * 写的是 .js, 且 Node 不会把 .js 说明符解析到 .ts. 门面让实现转 TS 与消费者
 * 改名解耦. 口径: 只许 re-export.
 */
export * from './login-flows.ts'
