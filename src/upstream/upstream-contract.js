/**
 - 上游契约单一真源(端点 + 头名).
 *
 - 这个文件是架构级的约束,不是常量收集的便利:
 *
 - 主服务(src/)与官方形态实现(cli-bridge/)都必须从这里取端点与头名,
 - 不得各自硬编码字符串.
 *
 - 为什么:上游一旦改 API(改头名,加端点),若两端各写一份就会出现
 - "改了一处,另一处静默过期" —— 这正是 2026-10-03 反复踩到的形状
 - (主服务加了 x-freebuff-client,cli-bridge 里还没有;反过来 cli-bridge
 - 有 x-freebuff-install-id,主服务却缺失).
 *
 - 契约真值来自客户端抓包,由以下两个脚本机器维护:
 - - scripts/gen-upstream-contract.mjs  从抓包生成 docs/reverse/upstream-contract.json
 - - scripts/check-upstream-contract.mjs 拿那份 JSON 与本文件对账(CI 跑)
 *
 - 上游变更后只需:重抓包 → 重生成 JSON → 门禁报出差异 → 改本文件一处.
 */

// ── 端点 ────────────────────────────────────────────────────────────────
export const EP_CATALOG = '/api/v1/freebuff/models'
export const EP_DEVICE_KEYS = '/api/v1/freebuff/device-keys'
export const EP_SESSION = '/api/v1/freebuff/session'
export const EP_SESSION_ADMISSION = '/api/v1/freebuff/session/admission'
export const EP_AGENT_RUNS = '/api/v1/agent-runs'
export const EP_CHAT = '/api/v1/chat/completions'

/** 全部必需端点(用于门禁与文档对账). */
export const REQUIRED_ENDPOINTS = [
  EP_CATALOG,
  EP_DEVICE_KEYS,
  EP_SESSION,
  EP_SESSION_ADMISSION,
  EP_AGENT_RUNS,
  EP_CHAT,
]

// ── 头名 ────────────────────────────────────────────────────────────────
export const H_AUTHORIZATION = 'authorization'
export const H_TIMEZONE = 'x-fb-timezone'
export const H_CATALOG_PROTOCOL = 'x-freebuff-catalog-protocol'
export const H_CATALOG_FETCH = 'x-freebuff-catalog-fetch'
export const H_CLIENT = 'x-freebuff-client'
export const H_INSTALL_ID = 'x-freebuff-install-id'
export const H_INSTANCE_ID = 'x-freebuff-instance-id'
export const H_MODEL = 'x-freebuff-model'
export const H_WALLET_SPEND_LIMIT = 'x-freebuff-wallet-spend-limit'
export const H_FIRST_TAB_DISCOUNT = 'x-freebuff-first-tab-discount'
export const H_INCLUDE_UNUSED_RATE_LIMITS = 'x-freebuff-include-unused-rate-limits'
export const H_MULTI_SESSION = 'x-freebuff-multi-session'
export const H_PURCHASE_CONTINUITY = 'x-freebuff-purchase-continuity'
export const H_HEARTBEAT = 'x-freebuff-heartbeat'
export const H_DESKTOP_ATTEMPT_ID = 'x-freebuff-desktop-attempt-id'
export const H_TAKEOVER_INSTANCE_ID = 'x-freebuff-takeover-instance-id'
export const H_ACTING_USER_ID = 'x-freebuff-acting-user-id'
// 设备签名三头
export const H_DEVICE_KEY = 'x-freebuff-device-key'
export const H_DEVICE_TS = 'x-freebuff-device-ts'
export const H_DEVICE_SIG = 'x-freebuff-device-sig'

/** 业务头全集(传输层头不在此列). */
export const BUSINESS_HEADERS = [
  H_AUTHORIZATION,
  H_TIMEZONE,
  H_CATALOG_PROTOCOL,
  H_CATALOG_FETCH,
  H_CLIENT,
  H_INSTALL_ID,
  H_INSTANCE_ID,
  H_MODEL,
  H_WALLET_SPEND_LIMIT,
  H_FIRST_TAB_DISCOUNT,
  H_INCLUDE_UNUSED_RATE_LIMITS,
  H_MULTI_SESSION,
  H_PURCHASE_CONTINUITY,
  H_HEARTBEAT,
  H_DESKTOP_ATTEMPT_ID,
  H_TAKEOVER_INSTANCE_ID,
  H_ACTING_USER_ID,
  H_DEVICE_KEY,
  H_DEVICE_TS,
  H_DEVICE_SIG,
]

/**
 - 已废弃的头:客户端 165 条抓包里出现 0 次,不得再发送.
 - 列在这里是为了让门禁能拦住回潮(有人"顺手加回来"会直接红).
 */
export const RETIRED_HEADERS = [
  'x-codebuff-api-key', // 客户端 0 次（docs/reverse/20 §20.4）
  'x-freebuff-env', // CLI 源码来的，desktop 客户端 0 次
  'x-freebuff-compact-session', // 同上
]

// ── 常量值 ──────────────────────────────────────────────────────────────
/** 官方客户端 bun 的 UA(抓包实测,勿用 CLI 侧历史值 1.3.14). */
export const OFFICIAL_BUN_UA = 'Bun/1.4.2'
export const CATALOG_PROTOCOL_VERSION = '1'
export const CLIENT_DESKTOP = 'desktop'
export const DEVICE_CLIENT_DESKTOP = 'desktop'
