/**
 - 上游客户端  --  薄门面(barrel).
 *
 - 实现已按职责拆进 ./client/:
 - - egress/           统一出网出口(代理解析唯一真源 + 唯一请求入口)
 - - transport.js      带池内回落与单次尝试超时的 fetch(不认协议)
 - - errors.js         UpstreamError / safeText / 错误与配额判据
 - - bun-channel.js    bun(cli-bridge)通道包装与 401 显式抛出
 - - http.js           统一头装配(UA/Bearer/目录头/设备签名)与登录重试
 - - session-endpoint.js /session 的 GET/POST/DELETE 与回执归一
 - - endpoints.js      登录码,agent run,裸透传,close
 - - factory.js        装配(依赖全部显式传参,不再藏在闭包里)
 *
 - 本文件保留原路径与全部原有导出名,因此 src/proxy.ts,bin/,
 - test/smoke.mjs 的既有 import 一处都不用改(并行开发零破坏).
 - 新增代码请写进对应的 client/ 子模块,不要在这里堆实现.
 *
 - 为什么拆:原文件 1499 行,其中 createUpstreamClient 一个函数 798 行,
 - 闭包里 7 个依赖任意拼错名字都只在运行时炸(mapped is not defined
 - 曾进过生产镜像).拆分把依赖显式化,配合 check-declared(TS2304 零容忍)
 - 把这类事故挡在提交前.
 */
export {
  UpstreamError,
  safeText,
  parseRetryAfterMs,
  isTerminalCountryBlock,
  extractRateLimitError,
  dailySessionQuota,
  extractAccountBanError,
  extractGateError,
  isSessionRecoverableGate,
} from './client/errors/index.ts'

export { createUpstreamClient } from './client/factory.ts'
export { createEgress, egressForConfig } from './client/egress/index.ts'
export type { Egress } from './client/egress/index.ts'
export { bunEnabled, installIdFromClientState, unwrapSessionViaBun } from './client/bun-channel.ts'
export { apiFetch, fetchLoginUpstream } from './client/http.ts'

// 常量真源在 ./official-fingerprint.ts(逐字取自官方二进制).这里 re-export
// 只是为兼容既有 import 点,不要在本文件另立取值.
export {
  BUN_USER_AGENT,
  HEADER_INSTANCE_ID as FREEBUFF_INSTANCE_HEADER,
  HEADER_MODEL as FREEBUFF_MODEL_HEADER,
} from './fingerprint/official-fingerprint.ts'
