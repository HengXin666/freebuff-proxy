/**
 - 上游错误载体与判据  --  按职责拆开后保留的唯一入口.
 *
 - 为什么拆成目录:原 client/errors.ts 是 323 行(超 300 红线),而里面两块东西的
 - 变更节奏完全不同  --  error-class 是"失败长什么样"的载体, 上游协议换字段时
 - 才动; codes 是一整柜上游判据(封禁 / 限流 / 闸门 / 当日配额), 每次实测出新码
 - 都要改.同放一个文件会让两类改动互相覆盖.
 *
 - 为什么保留 ./errors/index.ts 这个路径:src/upstream/client/ 目录只允许恰好
 - 5 个受控文件, 再拆出一个同级的 errors-codes.ts 就会变成 6 个而破红线;
 - 而对外消费者只认这条路径, 内部两个文件名不往外暴露.
 */
export type { ErrorExtra, SafeTextRes } from './error-class.ts'
export { UpstreamError, safeText, parseRetryAfterMs } from './error-class.ts'

export type { QuotaVerdict } from './codes.ts'
export {
  isTerminalCountryBlock,
  extractRateLimitError,
  dailySessionQuota,
  extractAccountBanError,
  extractGateError,
  isSessionRecoverableGate,
} from './codes.ts'
