/**
 * 官方 Freebuff/Codebuff CLI 的请求指纹常量 ---- 单一真源.
 *
 * 上游把[请求形态是否来自官方 CLI]当作客户端判据, 并据此降级或拒绝第三方
 * (freebuff 源码 freebuff-models.ts 引用了 docs/freebuff-abuse-detection.md 的
 * tool-schema 检查). 因此每个会出现在线上 wire 上的常量都逐字对齐官方.
 *
 * 全部取值来自对官方发布产物的静态提取(不是猜测, 也不是从报文反推):
 *   npm freebuff@0.0.178 → launcher 下载
 *   https://codebuff.com/api/releases/download/0.0.178/freebuff-linux-x64.tar.gz
 *   strings -n 6 freebuff
 * 桌面端常量(身份组 / SSE 标记)取自桌面客户端 0.0.173 AppImage 里的 orchestrator.js.
 * 提取到的原文锚点见各项注释.
 *
 * 保鲜期:这些值随官方 CLI 发版变化.版本号优先由调用方传入(从 npm 对齐的最新
 * 版本), 拿不到才回落本文件写死的已知值.
 *
 * 纯设备指纹常量与函数在 fingerprint/**: ua.ts / instance-id.ts / client-env.ts /
 * cli-version.ts. 这里原样 re-export 以保持既有 import 点不变; 本文件只保留头部
 * 常量与 officialSessionHeaders / officialChatHeaders 两个装配函数.
 */

export * from './ua.ts'
export * from './instance-id.ts'
export * from './client-env.ts'
export * from './cli-version.ts'

import { officialChatUserAgent } from './ua.ts'
import {
  CLI_CLAIM_PREFIX,
  HEADER_DESKTOP_ATTEMPT_ID,
  HEADER_HEARTBEAT,
  HEADER_INCLUDE_UNUSED_RATE_LIMITS,
  HEADER_MULTI_SESSION,
  HEADER_PURCHASE_CONTINUITY,
  HEADER_TAKEOVER_INSTANCE_ID,
  claimAttemptId,
} from './instance-id.ts'
/**
 * 会话准入端点(POST 专用).二进制原文:
 *   NAA="/api/v1/freebuff/session/admission"
 *   function PN$(H){return ${base}${H==="POST"?NAA:"/api/v1/freebuff/session"}}
 * GET / DELETE 用 /api/v1/freebuff/session,POST 用 .../admission.
 */
export const SESSION_ADMISSION_ENDPOINT = '/api/v1/freebuff/session/admission'
export const SESSION_ENDPOINT = '/api/v1/freebuff/session'

/** 头部常量(二进制原文逐字). */
export const HEADER_MODEL = 'x-freebuff-model'
export const HEADER_INSTANCE_ID = 'x-freebuff-instance-id'
/** 桌面端身份组(原文 FREEBUFF_CLIENT_HEADER / _CLIENT_VERSION_HEADER / _INSTALL_ID_HEADER). */
export const HEADER_CLIENT = 'x-freebuff-client'
export const HEADER_CLIENT_VERSION = 'x-freebuff-client-version'
export const HEADER_INSTALL_ID = 'x-freebuff-install-id'
/**  x-freebuff-compact-session 常量已删除:客户端 0 次,见 RETIRED_HEADERS. */
export const HEADER_WALLET_SPEND_LIMIT = 'x-freebuff-wallet-spend-limit'
export const HEADER_FIRST_TAB_DISCOUNT = 'x-freebuff-first-tab-discount'
export const HEADER_ACTING_USER_ID = 'x-freebuff-acting-user-id'
/**  x-codebuff-api-key 常量已删除:客户端 0 次,见 RETIRED_HEADERS(真源). */
/**
 * 官方每次会话请求都带本机时区(二进制原文 w6A):
 *   function w6A(){try{return{["x-fb-timezone"]:Intl.DateTimeFormat()
 *     .resolvedOptions().timeZone}}catch{return{}}}
 */
export const HEADER_TIMEZONE = 'x-fb-timezone'

/**
 * agent 步进终止哨兵.二进制原文:
 *   x9="cb_easp";  K7H=${JSON.stringify(x9)}
 *   O7H(...) → { stopSequences:[K7H] }
 * 即 stop: '"cb_easp"'.
 */
export const AGENT_STOP_SEQUENCE = JSON.stringify('cb_easp')

/**
 * 官方在 metadata 里放的字段(二进制原文 vXH):
 *   codebuff_metadata:{...extra, run_id, client_id, ...n&&{n}, ...costMode&&{cost_mode}}
 *   provider:{order:[...], allow_fallbacks:!isOpenRouterOnly}
 */
export const META_RUN_ID = 'run_id'
export const META_CLIENT_ID = 'client_id'
export const META_COST_MODE = 'cost_mode'

/** provider.data_collection 官方取值(二进制 providerOptions schema enum). */
export const DATA_COLLECTION_DENY = 'deny'

/**
 * 本机时区(官方 w6A 的同义实现).取不到时返回 null,由调用方决定是否跳过该头.
 * @returns {string | null}
 */
export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

/**
 * 当前对齐的官方桌面端版本 -- 桌面身份头 x-freebuff-client-version 的兜底值.
 *
 * 桌面版号没有可自动对齐的公开 registry(与 CLI 的 refreshCliVersion 不同): 部署侧用
 * FREEBUFF_APP_VERSION 覆盖, 未设置时用这里;桥接端 lib/endpoints/session.ts 有同一份
 * 兜底, 升级对齐时两处一起改. 不跟官方 clientVersionHeaders() 一样"env 没有就省略":
 * 官方桌面进程自己总是有该 env, 我们的部署没有, 省略等于身份组缺项. 见
 * .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md.
 */
export const KNOWN_DESKTOP_VERSION = '0.0.173'

/**
 * 本次请求要发的桌面端版本号(FREEBUFF_APP_VERSION 优先).
 * @returns {string} 版本号(形如 0.0.173)
 */
export function desktopClientVersion() {
  return (process.env.FREEBUFF_APP_VERSION || '').trim() || KNOWN_DESKTOP_VERSION
}

/**
 * 构造官方风格的会话请求头(POST 准入 / GET / DELETE 三态,对齐二进制 jg()).
 *
 * 官方原文逐字翻译:
 *   let L = { Authorization: Bearer token, ...w6A(), [first-tab-discount]: flag||'0' }
 *   if ((GET||DELETE) && instanceId) L[instance-id] = instanceId
 *   if (GET && compact)              L[compact-session] = '1'
 *   if (POST) { if (model) L[model] = model; L[wallet-spend-limit] = String(limit ?? 0) }
 *
 * 本仓按桌面形态发:另带身份组(client / client-version / install-id),POST 的
 * wallet-spend-limit 缺省 'session'(CLI 形态是 '0').取值来源与取舍见
 * .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md.
 *
 * @param {'GET'|'POST'|'DELETE'} method
 * @param {string} token
 * @param {{ model?: string, instanceId?: string, compact?: boolean, walletSpendLimit?: number | string, firstTabDiscount?: boolean, installId?: string | null }} [opts]
 * @returns {Record<string, string>}
 */
export function officialSessionHeaders(method: any, token: any, opts: any = {}) {
  /** @type {Record<string, string>} */
  const headers: any = {
    Authorization: 'Bearer ' + token,
    [HEADER_FIRST_TAB_DISCOUNT]: opts.firstTabDiscount ? '1' : '0',
    // 桌面端身份组(原文锚点与取舍见
    // .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md).
    [HEADER_CLIENT]: 'desktop',
    [HEADER_CLIENT_VERSION]: desktopClientVersion(),
    // installId 由调用方用同一解析器给出(env 优先, 回落官方客户端登录态, 见
    // src/upstream/client/client-state.ts 的 resolveInstallId);读不到时整头省略.
    ...(opts.installId ? { [HEADER_INSTALL_ID]: opts.installId } : {}),
    // 客户端环境描述符：官方在 session 与广告请求上都带（见
    // cli/src/utils/client-environment.ts）。缺它就不像官方客户端。
    //  不再发 `x-freebuff-env` 头：desktop 客户端 0 次。
    // clientEnvironment() 仍用于 chat 的 codebuff_metadata（那里客户端确实放）。
  }
  // 这组头在有 instanceId 时整组发出(官方 CLI 源码
  // cli/src/utils/freebuff-session-api.ts:186-200;desktop 抓包同样发这一组,
  // 用的是裸 UUID, 见 docs/reverse/captures/2026-10-03-official-client.jsonl
  // line 8 / 34 / 54 三次 POST admission):
  //   x-freebuff-instance-id: <裸 UUID>
  //   x-freebuff-multi-session: 1
  //   x-freebuff-purchase-continuity: 1
  //   x-freebuff-desktop-attempt-id: <每次新 uuid>
  // 见 docs/reverse/15-protocol-review.md P0-2 / P1-5.
  // 见 .agents/notes/implemented/bug-fix/2026-10-03-instance-id-bare-uuid-reuse.md
  if (opts.instanceId) {
    headers[HEADER_MULTI_SESSION] = '1'
    headers[HEADER_PURCHASE_CONTINUITY] = '1'
    // 非 GET 的 cli claim 请求带 attempt id(POST admission 有).
    const attempt = claimAttemptId(opts.instanceId)
    if (attempt && method !== 'GET') {
      headers[HEADER_DESKTOP_ATTEMPT_ID] = attempt
    }
    if (method === 'GET') {
      headers[HEADER_HEARTBEAT] = '1'
      if (!opts.compact) headers[HEADER_INCLUDE_UNUSED_RATE_LIMITS] = '1'
    }
  }
  const tz = localTimeZone()
  if (tz) headers[HEADER_TIMEZONE] = tz
  // 官方 CLI 原文(cli/src/utils/freebuff-session-api.ts:201):
  //   if ((multiSession || method !== 'POST') && opts.instanceId)
  //      headers[instance-id] = opts.instanceId
  // 即 CLI 下:GET/DELETE 总是带;POST 只在 cli claim 时带.
  //
  // desktop 下 POST admission 也带(抓包 line 8/34/54,裸 UUID),
  // 所以这里统一为:有 instanceId 就带.
  if (opts.instanceId) {
    headers[HEADER_INSTANCE_ID] = opts.instanceId
  }
  //  不再发 x-freebuff-compact-session:desktop 客户端 0 次.
  if (method === 'POST') {
    if (opts.model) headers[HEADER_MODEL] = opts.model
    // 缺省 'session':桌面准入的额度口径(orchestrator.js 的
    // FREEBUFF_WALLET_SPEND_LIMIT_HEADER = "session"), 不是 CLI 的 0.
    headers[HEADER_WALLET_SPEND_LIMIT] = String(opts.walletSpendLimit ?? 'session')
    // 显式接管:只在调用方拿到 currentInstanceId 时带, 未拿到时保持官方默认形态
    if (opts.takeoverInstanceId) {
      headers[HEADER_TAKEOVER_INSTANCE_ID] = String(opts.takeoverInstanceId)
    }
  }
  return headers
}

/**
 * 官方 chat/completions 的请求头.二进制原文(codebuff provider 分支):
 *   headers:()=>({Authorization:Bearer ${H},
 *     "user-agent":ai-sdk/openai-compatible/${nc}/codebuff,
 *     ...userId?{[x-freebuff-acting-user-id]:userId}:{},
 *     ...openrouterKey?{[x-openrouter-api-key]:openrouterKey}:{}})
 *
 * 注意:只有这两个(+可选 acting-user-id).官方 chat 不带
 * x-codebuff-api-key ---- 那个头只出现在其它端点(agent-runs / session 等).
 *
 * 已删除 officialApiKeyHeaders(): 它发的 x-codebuff-api-key 在客户端 165 条
 * 抓包里出现 0 次(docs/reverse/20 §20.4), 上游鉴权只发 Bearer;
 * 需要鉴权头用 freebuffAuthHeaders()(src/auth-store.ts).
 *
 * @param {string} token
 * @param {{ version?: string, userId?: string }} [opts]
 * @returns {Record<string, string>}
 */
export function officialChatHeaders(token: any, opts: any = {}) {
  /** @type {Record<string, string>} */
  const headers: any = {
    Authorization: 'Bearer ' + token,
    'user-agent': officialChatUserAgent(opts.version),
  }
  if (opts.userId) headers[HEADER_ACTING_USER_ID] = opts.userId
  return headers
}
