/**
 * 官方 Freebuff/Codebuff CLI 的请求指纹常量 —— **单一真源**。
 *
 * 为什么需要这个文件：上游把「请求形态是否来自官方 CLI」当作客户端判据，并据此
 * 降级或拒绝第三方（freebuff 源码 freebuff-models.ts 引用了
 * docs/freebuff-abuse-detection.md 的 tool-schema 检查；封禁信写的则是
 * "accessing Freebuff with a third-party client or proxy"）。因此每个会出现在线上
 * wire 上的常量都必须**逐字对齐官方**，而不是各写各的。
 *
 * 全部取值来自对官方发布二进制的静态提取（**不是**猜测、也不是从报文反推）：
 *   npm freebuff@0.0.178 → launcher 下载
 *   https://codebuff.com/api/releases/download/0.0.178/freebuff-linux-x64.tar.gz
 *   strings -n 6 freebuff
 * 提取到的原文锚点见各项注释。
 *
 * 保鲜期：这些值随官方 CLI 发版变化。用户代理若与真实版本差太远，本身就是可用
 * 指纹，所以版本号优先由调用方传入（从 npm 对齐的最新版本），拿不到才回落本文件
 * 写死的已知值。
 */

/**
 * 已知的官方 CLI 版本（提取自 freebuff@0.0.178 二进制）：
 *   CODEBUFF_CLI_VERSION:"0.0.178"
 * 仅作离线兜底；在线时优先用 npm 上 freebuff 包的最新版本。
 */
/*
 * 决策与四处偏差的原文锚点见
 * .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
 */
export const KNOWN_CLI_VERSION = '0.0.178'

/**
 * 官方 chat/completions 的 UA（二进制原文）：
 *   headers:()=>({Authorization:`Bearer ${H}`,
 *     "user-agent":`ai-sdk/openai-compatible/${nc}/codebuff`})
 * 其中 nc = __PACKAGE_VERSION__（= CLI 版本号）。
 *
 * 绝不能在中间插项目自有标记（freebuff-proxy 等）：上游按 UA 指纹代理客户端。
 * 旧实现硬编码 1.0.0，与真实 CLI 版本（0.0.178）不符 —— 见
 * .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
 * @param {string} [version] CLI 版本号，默认 KNOWN_CLI_VERSION
 * @returns {string}
 */
export function officialChatUserAgent(version = KNOWN_CLI_VERSION) {
  return 'ai-sdk/openai-compatible/' + version + '/codebuff'
}

/**
 * 官方 BYOK 分支的 UA（二进制原文 .../freebuff-byok）。仅作参考：BYOK 是用户自带
 * key 的通道，与免费模式相反，不要用它冒充免费客户端。
 * @param {string} [version]
 * @returns {string}
 */
export function officialByokUserAgent(version = KNOWN_CLI_VERSION) {
  return 'ai-sdk/openai-compatible/' + version + '/freebuff-byok'
}

/**
 * 官方 CLI 的裸 fetch UA（非 chat 调用）。二进制原文：
 *   CODEBUFF_IS_BINARY:"true" 走 Bun 自带 UA；对齐 trefeon bunUserAgent。
 */
export const BUN_USER_AGENT = 'Bun/1.3.14'

/**
 * 会话准入端点（**POST 专用**）。二进制原文：
 *   NAA="/api/v1/freebuff/session/admission"
 *   function PN$(H){return `${base}${H==="POST"?NAA:"/api/v1/freebuff/session"}`}
 * GET / DELETE 用 /api/v1/freebuff/session，POST 用 .../admission。
 * 旧实现三种方法都打 session —— POST 打错端点。
 */
export const SESSION_ADMISSION_ENDPOINT = '/api/v1/freebuff/session/admission'
export const SESSION_ENDPOINT = '/api/v1/freebuff/session'

/** 头部常量（二进制原文逐字）。 */
export const HEADER_MODEL = 'x-freebuff-model'
export const HEADER_INSTANCE_ID = 'x-freebuff-instance-id'
export const HEADER_COMPACT_SESSION = 'x-freebuff-compact-session'
export const HEADER_WALLET_SPEND_LIMIT = 'x-freebuff-wallet-spend-limit'
export const HEADER_FIRST_TAB_DISCOUNT = 'x-freebuff-first-tab-discount'
export const HEADER_ACTING_USER_ID = 'x-freebuff-acting-user-id'
export const HEADER_API_KEY = 'x-codebuff-api-key'
/**
 * 官方每次会话请求都带本机时区（二进制原文 w6A）：
 *   function w6A(){try{return{["x-fb-timezone"]:Intl.DateTimeFormat()
 *     .resolvedOptions().timeZone}}catch{return{}}}
 */
export const HEADER_TIMEZONE = 'x-fb-timezone'

/**
 * agent 步进终止哨兵。二进制原文：
 *   x9="cb_easp";  K7H=`${JSON.stringify(x9)}`
 *   O7H(...) → { stopSequences:[K7H] }
 * 即 stop: ['"cb_easp"']（**带引号**，因为它是 JSON.stringify 的结果）。
 */
export const AGENT_STOP_SEQUENCE = JSON.stringify('cb_easp')

/**
 * 官方在 metadata 里放的字段（二进制原文 vXH）：
 *   codebuff_metadata:{...extra, run_id, client_id, ...n&&{n}, ...costMode&&{cost_mode}}
 *   provider:{order:[...], allow_fallbacks:!isOpenRouterOnly}
 */
export const META_RUN_ID = 'run_id'
export const META_CLIENT_ID = 'client_id'
export const META_COST_MODE = 'cost_mode'

/** provider.data_collection 官方取值（二进制 providerOptions schema enum）。 */
export const DATA_COLLECTION_DENY = 'deny'

/**
 * 本机时区（官方 w6A 的同义实现）。取不到时返回 null，由调用方决定是否跳过该头。
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
 * 构造官方风格的会话请求头（POST 准入 / GET / DELETE 三态，对齐二进制 jg()）。
 *
 * 官方原文逐字翻译：
 *   let L = { Authorization: Bearer token, ...w6A(), [first-tab-discount]: flag||'0' }
 *   if ((GET||DELETE) && instanceId) L[instance-id] = instanceId
 *   if (GET && compact)              L[compact-session] = '1'
 *   if (POST) { if (model) L[model] = model; L[wallet-spend-limit] = String(limit ?? 0) }
 *
 * @param {'GET'|'POST'|'DELETE'} method
 * @param {string} token
 * @param {{ model?: string, instanceId?: string, compact?: boolean, walletSpendLimit?: number, firstTabDiscount?: boolean }} [opts]
 * @returns {Record<string, string>}
 */
export function officialSessionHeaders(method, token, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: 'Bearer ' + token,
    [HEADER_FIRST_TAB_DISCOUNT]: opts.firstTabDiscount ? '1' : '0',
  }
  const tz = localTimeZone()
  if (tz) headers[HEADER_TIMEZONE] = tz
  if ((method === 'GET' || method === 'DELETE') && opts.instanceId) {
    headers[HEADER_INSTANCE_ID] = opts.instanceId
  }
  if (method === 'GET' && opts.compact) {
    headers[HEADER_COMPACT_SESSION] = '1'
  }
  if (method === 'POST') {
    if (opts.model) headers[HEADER_MODEL] = opts.model
    headers[HEADER_WALLET_SPEND_LIMIT] = String(opts.walletSpendLimit ?? 0)
  }
  return headers
}

/**
 * 官方 chat/completions 的请求头。二进制原文（codebuff provider 分支）：
 *   headers:()=>({Authorization:`Bearer ${H}`,
 *     "user-agent":`ai-sdk/openai-compatible/${nc}/codebuff`,
 *     ...userId?{[x-freebuff-acting-user-id]:userId}:{},
 *     ...openrouterKey?{[x-openrouter-api-key]:openrouterKey}:{}})
 *
 * 注意：**只有这两个（+可选 acting-user-id）**。官方 chat 不带
 * x-codebuff-api-key —— 那个头只出现在其它端点（agent-runs / session 等，见二进制
 * 里 wtH 的 headers）。多发这一个头就是纯多余的指纹面。
 *
 * @param {string} token
 * @param {{ version?: string, userId?: string }} [opts]
 * @returns {Record<string, string>}
 */
export function officialChatHeaders(token, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    Authorization: 'Bearer ' + token,
    'user-agent': officialChatUserAgent(opts.version),
  }
  if (opts.userId) headers[HEADER_ACTING_USER_ID] = opts.userId
  return headers
}

/**
 * 其它上游端点（session / agent-runs / me 等）的头部。二进制原文（wtH）：
 *   headers:{"Content-Type":"application/json", Authorization:`Bearer ${E}`,
 *     "x-codebuff-api-key":E}
 * —— 这些端点**确实**带 x-codebuff-api-key。
 *
 * @param {string} token
 * @returns {Record<string, string>}
 */
export function officialApiKeyHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    [HEADER_API_KEY]: token,
  }
}
/**
 * 进程内生效的 CLI 版本号。启动时 = KNOWN_CLI_VERSION；refreshCliVersion() 成功后
 * 更新为 npm 上 freebuff 包的最新版本（上游只认「版本号看起来是真 CLi 发的」）。
 */
let activeCliVersion = KNOWN_CLI_VERSION

/** 当前生效的 CLI 版本号（同步、无 IO）。 */
export function getCliVersion() {
  return activeCliVersion
}

/** 测试/运维用：显式设置版本号（非法值忽略）。 */
export function setCliVersion(version) {
  if (typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version.trim())) {
    activeCliVersion = version.trim()
  }
  return activeCliVersion
}

/**
 * 从 npm registry 对齐官方 CLI 的最新版本号（best-effort）。
 *
 * 为什么值得做：UA 里的版本号是上游判断「这是不是官方客户端」的一部分指纹，写死一个
 * 过时值（旧实现是 1.0.0）长期看本身就是破绽。拿不到就保留现值 —— 绝不因为一次
 * 网络失败影响代理可用性。
 *
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<string>} 生效的版本号
 */
export async function refreshCliVersion(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') return activeCliVersion
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8_000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  if (timer.unref) timer.unref()
  try {
    const res = await fetchImpl('https://registry.npmjs.org/freebuff/latest', {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return activeCliVersion
    const body = await res.json()
    return setCliVersion(body && body.version)
  } catch {
    return activeCliVersion
  } finally {
    clearTimeout(timer)
  }
}
