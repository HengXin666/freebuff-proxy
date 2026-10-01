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
    // 客户端环境描述符：官方在 session 与广告请求上都带（见
    // cli/src/utils/client-environment.ts）。缺它就不像官方客户端。
    [HEADER_CLIENT_ENV]: clientEnvironment(),
  }
  // multi-session 协议：官方只在 instanceId 是 CLI claim（`cli:` 前缀）时发
  // 这一整套头（cli/src/utils/freebuff-session-api.ts:186-200）。
  // 服务端据此把请求认成 CLI 而不是 Desktop 标签。
  if (isCliClaim(opts.instanceId)) {
    headers[HEADER_MULTI_SESSION] = '1'
    headers[HEADER_PURCHASE_CONTINUITY] = '1'
    if (method === 'GET') {
      headers[HEADER_HEARTBEAT] = '1'
      if (!opts.compact) headers[HEADER_INCLUDE_UNUSED_RATE_LIMITS] = '1'
    }
  }
  const tz = localTimeZone()
  if (tz) headers[HEADER_TIMEZONE] = tz
  // 官方原文（cli/src/utils/freebuff-session-api.ts:201）：
  //   if ((multiSession || method !== 'POST') && opts.instanceId)
  //      headers[instance-id] = opts.instanceId
  // 即：GET/DELETE 总是带；POST **只在 multiSession（cli claim）时**带 ——
  // 那时它是客户端自己声明的 claim，服务端据此签发同一条（实测原样保留）。
  if ((isCliClaim(opts.instanceId) || method !== 'POST') && opts.instanceId) {
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
 * 官方 CLI 的**客户端环境描述符**（terminal-environment summary）。
 *
 * 这是上游判断"这是不是真 CLI"的核心指纹之一：官方把它作为
 * `x-freebuff-env` 头发在 session / 广告请求上，并把同一份字符串放进
 * `codebuff_metadata.freebuff_client_env`。缺它 = 请求形态不像官方客户端。
 *
 * 取值逐字对齐官方 CLI 源码
 *   cli/src/utils/client-environment.ts → formatClientEnvironment()
 * 常量真源
 *   common/src/constants/freebuff-client-descriptor.ts
 * 官方注释里的样例：
 *   v1;in=1;out=1;tp=iterm;term=1;ct=1;sz=120x40;ci=0;ssh=0;l=1;p=shell;g=terminal;osc=1
 *
 * 只放存在性标志、尺寸与固定桶名 —— **绝不**放路径、进程名、环境变量原文
 * （官方明确约束：never a raw environment value, path, or process name）。
 */
export const HEADER_CLIENT_ENV = 'x-freebuff-env'

/**
 * 官方 CLI 的会话 claim 前缀（`cli:`）。
 *
 * 官方**客户端自己生成** instanceId：
 *   cli/src/utils/freebuff-session-identity.ts
 *     const CLI_MULTI_SESSION_PREFIX = FREEBUFF_CLI_CLAIM_PREFIX   // 'cli:'
 *     newFreebuffCliInstanceId() => `cli:${randomUUID()}`
 *   cli/src/hooks/use-freebuff-session.ts:576
 *     let claimId = relaunch?.instanceId ?? newFreebuffCliInstanceId()
 *
 * 常量真源：common/src/constants/freebuff-desktop-sessions.ts
 *   export const FREEBUFF_CLI_CLAIM_PREFIX = 'cli:'
 *   "The server reads it to tell the CLI's claims from Desktop tabs"
 *
 * ⚠️ **实测确认**（2026-09-30，真账号）：POST admission 时自带
 * `x-freebuff-instance-id: cli:<uuid>`，服务端**接受并原样保留**
 * （返回的 instanceId 与传入的完全一致，带前缀）。
 */
export const CLI_CLAIM_PREFIX = 'cli:'

/** 官方 multi-session 协议头（instanceId 带 cli: 前缀时才发）。 */
export const HEADER_MULTI_SESSION = 'x-freebuff-multi-session'
export const HEADER_PURCHASE_CONTINUITY = 'x-freebuff-purchase-continuity'
export const HEADER_HEARTBEAT = 'x-freebuff-heartbeat'
export const HEADER_INCLUDE_UNUSED_RATE_LIMITS =
  'x-freebuff-include-unused-rate-limits'

/**
 * 生成一个官方形态的 CLI 会话 claim（`cli:<uuid>`）。
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
  // crypto.randomUUID 不可用时的兜底（形态仍须是 uuidv4）
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

/** 判断 instanceId 是否是官方 CLI 形态的 claim（带 `cli:` 前缀）。 */
export function isCliClaim(instanceId) {
  return typeof instanceId === 'string' && instanceId.startsWith(CLI_CLAIM_PREFIX)
}

/** `codebuff_metadata` 里承载同一份描述符的键。 */
export const META_CLIENT_ENV = 'freebuff_client_env'

/** 终端程序桶（官方 TERMINAL_PROGRAMS 映射）。 */
const TERMINAL_PROGRAMS = {
  apple_terminal: 'apple_terminal',
  'iterm.app': 'iterm',
  iterm2: 'iterm',
  vscode: 'vscode',
  ghostty: 'ghostty',
  wezterm: 'wezterm',
  warpterminal: 'warp',
  hyper: 'hyper',
  tmux: 'tmux',
  zed: 'zed',
  tabby: 'tabby',
  rio: 'rio',
  mintty: 'mintty',
  'jetbrains-jediterm': 'jetbrains',
  kitty: 'kitty',
  alacritty: 'alacritty',
}

function bucketTerminalProgram(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!v) return 'none'
  return TERMINAL_PROGRAMS[v] || 'other'
}

const flag = (v) => (v ? '1' : '0')

/**
 * 代理桶（对齐官方 cli/src/utils/client-environment.ts proxyBucketOf）。
 * 只看 6 个代理环境变量，取值 none / loopback / remote —— **不上报真实地址**。
 */
function proxyBucketOf(env) {
  const one = (value) => {
    const v = typeof value === 'string' ? value.trim() : ''
    if (!v) return null
    try {
      const host = new URL(v).hostname
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
        return 'loopback'
      }
      return 'remote'
    } catch {
      return 'remote'
    }
  }
  const buckets = [
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
    env.ALL_PROXY,
    env.all_proxy,
  ].map(one)
  if (buckets.includes('loopback')) return 'loopback'
  if (buckets.includes('remote')) return 'remote'
  return 'none'
}

function clampDimension(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(9999, Math.floor(value)))
}

/**
 * 生成本进程的客户端环境描述符（对齐官方 formatClientEnvironment）。
 *
 * 本代理跑在容器/服务里，**没有真实终端**，所以按官方对"非交互环境"的
 * 取值填：in/out = 0（非 TTY）、tp = none、l = 0、p/g = na（未查询）、
 * osc = na。这是自洽的取值 —— 官方自己也有 `na` 桶表示"未查询/不适用"，
 * 伪造成一个真实终端反而与运行环境矛盾。
 *
 * @param {{ env?: Record<string, string|undefined>, columns?: number, rows?: number }} [opts]
 * @returns {string}
 */
export function formatClientEnvironment(opts = {}) {
  const env = opts.env || {}
  const ci =
    env.CI === 'true' || env.CI === '1' || env.GITHUB_ACTIONS === 'true'
  const fields = [
    ['in', flag(false)],
    ['out', flag(false)],
    ['tp', bucketTerminalProgram(env.TERM_PROGRAM)],
    ['term', flag(env.TERM)],
    ['ct', flag(env.COLORTERM)],
    ['sz', `${clampDimension(opts.columns)}x${clampDimension(opts.rows)}`],
    ['ci', flag(ci)],
    ['ssh', flag(env.SSH_TTY || env.SSH_CONNECTION)],
    ['l', flag(false)],
    ['p', 'na'],
    ['g', 'na'],
    ['osc', 'na'],
    // 后 4 个字段是官方较新版本才加的（真机抓包 2026-10-01 确认存在）。
    // 语义逐条对齐 cli/src/utils/client-environment.ts:377-380：
    //   tzo = TZ 覆盖了系统时区？（本进程不改 TZ → 0）
    //   px  = 代理桶（none/loopback/remote）
    //   tls = 是否禁用了证书校验（默认 1 = 正常校验）
    //   ca  = 是否追加了自定义 CA
    ['tzo', flag(env.TZ && String(env.TZ).trim())],
    ['px', proxyBucketOf(env)],
    ['tls', env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0' ? '0' : '1'],
    ['ca', flag(env.NODE_EXTRA_CA_CERTS?.trim())],
  ]
  return ['v1', ...fields.map(([k, v]) => `${k}=${v}`)].join(';')
}

/**
 * 本进程的环境描述符（构建一次后缓存：官方也是 per-process 构建一次）。
 * @type {string | null}
 */
let cachedClientEnv = null

/** 取（并缓存）本进程的客户端环境描述符。 */
export function clientEnvironment() {
  if (!cachedClientEnv) {
    cachedClientEnv = formatClientEnvironment({
      env: typeof process !== 'undefined' ? process.env : {},
    })
  }
  return cachedClientEnv
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
