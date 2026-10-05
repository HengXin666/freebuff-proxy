/**
 * SessionManager 的薄门面(.js 路径, 实现见 ./session/).
 *
 * 保留原路径与全部原有导出名, 所以 src/app-context.ts, src/proxy.ts,
 * bin/, test/ 的既有 import 一处都不用改.
 *
 * 实现按域拆分(每个文件 <= 300 行):
 *   - ./session/manager.ts          SessionManager 类与原型装配
 *   - ./session/methods.ts          方法名 -> 实现的唯一登记表
 *   - ./session/state.ts            可变状态容器与类型
 *   - ./session/inventory.ts        纯函数层(常量/回执解析/标量工具)
 *   - ./session/core/gate.ts        两本账闸门与可用性判据
 *   - ./session/core/lease.ts       在途计数, 互斥锁, 付费时段, 空闲释放
 *   - ./session/observe/probe.ts    探测/轮询(含持有心跳)
 *   - ./session/observe/events.ts   会话现场落盘与四类回调
 *   - ./session/observe/snapshot.ts 控制台快照与上游清单
 *   - ./session/admit/*             ensureSession 与 admission 的每一步
 *   - ./session/release/*           释放, 退款结算与追问
 *
 * 为什么拆: 原文件 2280 行, 其中 _admitUnlocked 一个函数 366 行. 拆开之后
 * 每个方法的依赖只通过 this 上的状态契约传递, 静态检查(check-declared)能
 * 抓住漏挂的方法 -- 这曾经是本仓的生产事故形态.
 */
export { SessionManager } from './session/manager.ts'
export { accountLevelSessionStatus } from './session/inventory.ts'
