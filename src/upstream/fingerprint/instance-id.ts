/**
 - 会话实例标识与会话 claim  --  instanceId 的两种形态及其协议头.
 *
 * 为什么单独成文件: 原 official-fingerprint.ts 569 行超 300 红线. instanceId
 * 有 desktop(裸 UUID)与 CLI(cli:<uuid>)两种形态, 各自的配套头也不同; 这条线
 * 是[一次 admit = 买断一小时]的直接相关面(新建 instanceId 会让上一次购买作废),
 * 所以单独成文件以便独立审阅与测试.
 */

/**
 * 官方 CLI 的会话 claim 前缀(cli:).
 *
 * 官方客户端自己生成 instanceId:
 *   cli/src/utils/freebuff-session-identity.ts
 *     const CLI_MULTI_SESSION_PREFIX = FREEBUFF_CLI_CLAIM_PREFIX   // 'cli:'
 *     newFreebuffCliInstanceId() => cli:${randomUUID()}
 *   cli/src/hooks/use-freebuff-session.ts:576
 *     let claimId = relaunch?.instanceId ?? newFreebuffCliInstanceId()
 *
 * 常量真源:common/src/constants/freebuff-desktop-sessions.ts
 *   export const FREEBUFF_CLI_CLAIM_PREFIX = 'cli:'
 *   "The server reads it to tell the CLI's claims from Desktop tabs"
 *
 *  实测确认(2026-09-30,真账号):POST admission 时自带
 * x-freebuff-instance-id: cli:<uuid>,服务端接受并原样保留
 * (返回的 instanceId 与传入的完全一致,带前缀).
 */
export const CLI_CLAIM_PREFIX = 'cli:'

/** 官方 multi-session 协议头(instanceId 带 cli: 前缀时才发). */
export const HEADER_MULTI_SESSION = 'x-freebuff-multi-session'
export const HEADER_PURCHASE_CONTINUITY = 'x-freebuff-purchase-continuity'
/**
 * 槽位被别的 instance 占着时,显式接管那一个槽位.
 *
 * 官方常量原文(orchestrator.js:112553):
 *   FREEBUFF_TAKEOVER_INSTANCE_HEADER = "x-freebuff-takeover-instance-id"
 * 用法(orchestrator.js:208152-208155):admission 回 purchase_capacity /
 * purchase_in_use / premium_slot_taken 且回执给了 currentInstanceId 时,
 * 带着它重发一次 ---- 上游会把剩余时长移交过来(官方文案:
 * "Use that tab or choose 'Use it here' to move the remaining time here
 *  without another charge").
 */
export const HEADER_TAKEOVER_INSTANCE_ID = 'x-freebuff-takeover-instance-id'
/**
 * Desktop 专用头,但CLI 在多会话协议下也发.
 *
 * 真机抓包(2026-10-01,从零建会话):官方 POST /session/admission 带
 *   x-freebuff-desktop-attempt-id: b4e28cef-827c-4584-a9b7-caf2d0062f09
 * 而同一请求的 x-freebuff-instance-id 是 cli:b4e28cef-827c-4584-a9b7-caf2d0062f09
 * ---- 即 claim 去掉 cli: 前缀(对齐官方 freebuffCliAttemptId()).
 */
export const HEADER_DESKTOP_ATTEMPT_ID = 'x-freebuff-desktop-attempt-id'

/**
 - claim 的裸 uuid(去掉 cli: 前缀),官方 freebuffCliAttemptId() 同义.
 - @param {any} instanceId 会话实例 id(cli:<uuid> 形态才取得到)
 - @returns {string | null} 裸 uuid;不是 cli claim 时返回 null
 */
export function claimAttemptId(instanceId: any) {
  if (typeof instanceId !== 'string') return null
  return instanceId.startsWith(CLI_CLAIM_PREFIX)
    ? instanceId.slice(CLI_CLAIM_PREFIX.length)
    : null
}
export const HEADER_HEARTBEAT = 'x-freebuff-heartbeat'
export const HEADER_INCLUDE_UNUSED_RATE_LIMITS =
  'x-freebuff-include-unused-rate-limits'

/**
 * 生成一个官方形态的 CLI 会话 claim(cli:<uuid>).
 * @returns {string}
 */
export function newCliClaimId() {
  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : fallbackUuid()
  return CLI_CLAIM_PREFIX + uuid
}

function fallbackUuid() {
  // crypto.randomUUID 不可用时的兜底(形态仍须是 uuidv4)
  const hex = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-'
    else if (i === 14) out += '4'
    else if (i === 19) out += hex[(Math.random() * 4) | 8]
    else out += hex[(Math.random() * 16) | 0]
  }
  return out
}

/**
 * 生成一个裸 UUID形态的会话实例 id(不带 cli: 前缀).
 *
 * 抓包复核(2026-10-03,docs/reverse/15-protocol-review.md P0-2):
 * 官方 desktop 的 instanceId 是裸 UUID(如 e1be7199-331e-4622-b5a9-...),
 * 且整场复用;而 cli: 前缀是 CLI 侧 claim 的形态
 * (official-fingerprint 里另一条证据显示 CLI 抓包为 cli:b4e28cef-...).
 *
 * 本仓库走 desktop 路线,故用裸 UUID.且调用方应复用同一个值,
 * 不要每次 admission 新建 ---- 那会让每次购买被全额退款作废.
 *
 * @returns {string}
 */
export function newRawInstanceId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return fallbackUuid()
}

/**
 - 判断 instanceId 是否是官方 CLI 形态的 claim(带 cli: 前缀).
 - @param {any} instanceId 待判定的会话实例 id
 - @returns {boolean} 是 cli claim 则为真
 */
export function isCliClaim(instanceId: any) {
  return typeof instanceId === 'string' && instanceId.startsWith(CLI_CLAIM_PREFIX)
}
