/**
 * 官方 Freebuff/Codebuff CLI 的请求指纹常量 ---- 单一真源.
 *
 * 为什么需要这个文件:上游把[请求形态是否来自官方 CLI]当作客户端判据,并据此
 * 降级或拒绝第三方(freebuff 源码 freebuff-models.ts 引用了
 * docs/freebuff-abuse-detection.md 的 tool-schema 检查;封禁信写的则是
 * "accessing Freebuff with a third-party client or proxy").因此每个会出现在线上
 * wire 上的常量都必须逐字对齐官方,而不是各写各的.
 *
 * 全部取值来自对官方发布二进制的静态提取(不是猜测,也不是从报文反推):
 *   npm freebuff@0.0.178 → launcher 下载
 *   https://codebuff.com/api/releases/download/0.0.178/freebuff-linux-x64.tar.gz
 *   strings -n 6 freebuff
 * 提取到的原文锚点见各项注释.
 *
 * 保鲜期:这些值随官方 CLI 发版变化.用户代理若与真实版本差太远,本身就是可用
 * 指纹,所以版本号优先由调用方传入(从 npm 对齐的最新版本),拿不到才回落本文件
 * 写死的已知值.
 */

/**
 * 已知的官方 CLI 版本(提取自 freebuff@0.0.178 二进制):
 *   CODEBUFF_CLI_VERSION:"0.0.178"
 * 仅作离线兜底;在线时优先用 npm 上 freebuff 包的最新版本.
 */
/*
 * 决策与四处偏差的原文锚点见
 * .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
 */
export const KNOWN_CLI_VERSION = '0.0.178'

/**
 * 官方 chat/completions 的 UA ---- 两段式,逐字对齐真机抓包.
 *
 * 实测(mitmproxy 抓官方 CLI 0.2.6):
 *
 * ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser
 *
 *
 *  但 desktop 客户端的第三段是 runtime/bun/1.4.2,不是 browser:
 * 2026-10-03 抓包(官方 desktop 经 HTTP_PROXY 走 mitm 解密,
 * docs/reverse/captures/2026-10-03-official-client.jsonl)实测为
 *   .../codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2
 * 因为官方 orchestrator 本身就是 bun 跑的.
 * 本仓库走 desktop 路线,故 OFFICIAL_CHAT_UA_SUFFIX 取 bun 形态.
 *
 * 两个此前搞错的点:
 *
 * 1. 版本是 0.0.0-test,不是真实 CLI 版本号. 二进制原文:
 *    Qo=typeof __PACKAGE_VERSION__<"u"?__PACKAGE_VERSION__:"0.0.0-test"
 *    ---- 官方发布构建里该变量未注入,于是回退到字面量 0.0.0-test.
 *    我们此前发 0.0.178(包版本),反而与官方不一致.
 * 2. 后面还有第二段(ai-sdk 的 provider-utils 与 runtime 标记),我们整段漏了.
 *
 * 绝不能在中间插项目自有标记(freebuff-proxy 等):上游按 UA 指纹代理客户端.
 * 见 .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md
 * 与 .agents/notes/implemented/bug-fix/2026-10-01-chat-ua-two-part.md
 * @param {string} [version] 覆盖版本段(默认对齐官方的 0.0.0-test)
 * @returns {string}
 */
export const OFFICIAL_CHAT_UA_VERSION = '0.0.0-test'
//  第三段是 runtime/bun/1.4.2,不是 runtime/browser.
//
// 真机抓包(2026-10-03,官方 desktop 客户端经 mitm 解密,
// docs/reverse/captures/2026-10-03-official-client.jsonl):
//   User-Agent: ai-sdk/openai-compatible/0.0.0-test/codebuff
//               ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2
// 官方 orchestrator 就是 bun 跑的,所以 runtime 段是 bun 而非 browser.
// 此前写成 browser 是按 CLI 侧抓包填的 ---- 与 desktop 路线不符.
// 见 docs/reverse/14-captured-diff.md
export const OFFICIAL_CHAT_UA_SUFFIX =
  'ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2'

export function officialChatUserAgent(version = OFFICIAL_CHAT_UA_VERSION) {
  return (
    'ai-sdk/openai-compatible/' + version + '/codebuff ' + OFFICIAL_CHAT_UA_SUFFIX
  )
}

/**
 * 官方 BYOK 分支的 UA(二进制原文 .../freebuff-byok).仅作参考:BYOK 是用户自带
 * key 的通道,与免费模式相反,不要用它冒充免费客户端.
 * @param {string} [version]
 * @returns {string}
 */
export function officialByokUserAgent(version = KNOWN_CLI_VERSION) {
  return 'ai-sdk/openai-compatible/' + version + '/freebuff-byok'
}

/**
 * 官方 CLI 的裸 fetch UA(非 chat 调用).二进制原文:
 *   CODEBUFF_IS_BINARY:"true" 走 Bun 自带 UA;对齐 trefeon bunUserAgent.
 */
export const BUN_USER_AGENT = 'Bun/1.3.14'

/**
 * 会话准入端点(POST 专用).二进制原文:
 *   NAA="/api/v1/freebuff/session/admission"
 *   function PN$(H){return ${base}${H==="POST"?NAA:"/api/v1/freebuff/session"}}
 * GET / DELETE 用 /api/v1/freebuff/session,POST 用 .../admission.
 * 旧实现三种方法都打 session ---- POST 打错端点.
 */
export const SESSION_ADMISSION_ENDPOINT = '/api/v1/freebuff/session/admission'
export const SESSION_ENDPOINT = '/api/v1/freebuff/session'

/** 头部常量(二进制原文逐字). */
export const HEADER_MODEL = 'x-freebuff-model'
export const HEADER_INSTANCE_ID = 'x-freebuff-instance-id'
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
 * 构造官方风格的会话请求头(POST 准入 / GET / DELETE 三态,对齐二进制 jg()).
 *
 * 官方原文逐字翻译:
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
export function officialSessionHeaders(method: any, token: any, opts: any = {}) {
  /** @type {Record<string, string>} */
  const headers: any = {
    Authorization: 'Bearer ' + token,
    [HEADER_FIRST_TAB_DISCOUNT]: opts.firstTabDiscount ? '1' : '0',
    // 客户端环境描述符：官方在 session 与广告请求上都带（见
    // cli/src/utils/client-environment.ts）。缺它就不像官方客户端。
    //  不再发 `x-freebuff-env` 头：desktop 客户端 0 次。
    // clientEnvironment() 仍用于 chat 的 codebuff_metadata（那里客户端确实放）。
  }
  //  这组头此前只在 cli: 前缀时才发(按官方 CLI 源码
  // cli/src/utils/freebuff-session-api.ts:186-200:服务端据此认成 CLI
  // 而非 Desktop 标签).
  //
  // 但 desktop 抓包证明它同样发这一组,且用的是裸 UUID:
  // 2026-10-03 抓取(docs/reverse/captures/2026-10-03-official-client.jsonl)
  // line 8 / 34 / 54 三次 POST admission 均带
  //   x-freebuff-instance-id: e1be7199-331e-4622-b5a9-0a2cfe8aecc1(裸 UUID)
  //   x-freebuff-multi-session: 1
  //   x-freebuff-purchase-continuity: 1
  //   x-freebuff-desktop-attempt-id: <每次新 uuid>
  //
  // 本仓库走 desktop 路线,故改为[有 instanceId 就发整组].
  // 见 docs/reverse/15-protocol-review.md P0-2 / P1-5.
  if (opts.instanceId) {
    headers[HEADER_MULTI_SESSION] = '1'
    headers[HEADER_PURCHASE_CONTINUITY] = '1'
    // 官方在非 GET 的 cli claim 请求上带 attempt id(POST admission 实测有).
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
  //  desktop 下 POST admission 也带(抓包 line 8/34/54,裸 UUID).
  // 本仓库走 desktop,故改为:有 instanceId 就带,不再限定 cli: 与方法.
  if (opts.instanceId) {
    headers[HEADER_INSTANCE_ID] = opts.instanceId
  }
  //  不再发 x-freebuff-compact-session:desktop 客户端 0 次.
  if (method === 'POST') {
    if (opts.model) headers[HEADER_MODEL] = opts.model
    headers[HEADER_WALLET_SPEND_LIMIT] = String(opts.walletSpendLimit ?? 0)
    // 显式接管:只在调用方拿到 currentInstanceId 时带(否则不带,保持官方默认形态)
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
 * x-codebuff-api-key ---- 那个头只出现在其它端点(agent-runs / session 等,见二进制
 * 里 wtH 的 headers).多发这一个头就是纯多余的指纹面.
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

/**
 * 其它上游端点(session / agent-runs / me 等)的头部.二进制原文(wtH):
 *   headers:{"Content-Type":"application/json", Authorization:Bearer ${E},
 *     "x-codebuff-api-key":E}
 * ---- 这些端点确实带 x-codebuff-api-key.
 *
 * @param {string} token
 * @returns {Record<string, string>}
 */
/**
 *  officialApiKeyHeaders() 已删除.
 *
 * 它发的 x-codebuff-api-key 在客户端 165 条抓包里出现 0 次
 * (docs/reverse/20 §20.4).上游鉴权只发 Bearer ---- 需要鉴权头用
 * freebuffAuthHeaders()(src/auth-store.ts).
 * 保留此函数等于给回潮留一个入口,故连定义一起删.
 */

/**
 * 官方 CLI 的客户端环境描述符(terminal-environment summary).
 *
 * 这是上游判断"这是不是真 CLI"的核心指纹之一:官方把它作为
 * x-freebuff-env 头发在 session / 广告请求上,并把同一份字符串放进
 * codebuff_metadata.freebuff_client_env.缺它 = 请求形态不像官方客户端.
 *
 * 取值逐字对齐官方 CLI 源码
 *   cli/src/utils/client-environment.ts → formatClientEnvironment()
 * 常量真源
 *   common/src/constants/freebuff-client-descriptor.ts
 * 官方注释里的样例:
 *   v1;in=1;out=1;tp=iterm;term=1;ct=1;sz=120x40;ci=0;ssh=0;l=1;p=shell;g=terminal;osc=1
 *
 * 只放存在性标志,尺寸与固定桶名 ---- 绝不放路径,进程名,环境变量原文
 * (官方明确约束:never a raw environment value, path, or process name).
 */
/**  x-freebuff-env 常量已删除:desktop 客户端 0 次,见 RETIRED_HEADERS. */

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

/** claim 的裸 uuid(去掉 cli: 前缀),官方 freebuffCliAttemptId() 同义. */
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

/** 判断 instanceId 是否是官方 CLI 形态的 claim(带 cli: 前缀). */
export function isCliClaim(instanceId: any) {
  return typeof instanceId === 'string' && instanceId.startsWith(CLI_CLAIM_PREFIX)
}

/** codebuff_metadata 里承载同一份描述符的键. */
export const META_CLIENT_ENV = 'freebuff_client_env'

/** 终端程序桶(官方 TERMINAL_PROGRAMS 映射). */
const TERMINAL_PROGRAMS: any = {
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

function bucketTerminalProgram(value: any) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!v) return 'none'
  return TERMINAL_PROGRAMS[v] || 'other'
}

const flag = (v: any) => (v ? '1' : '0')

/**
 * 代理桶(对齐官方 cli/src/utils/client-environment.ts proxyBucketOf).
 * 只看 6 个代理环境变量,取值 none / loopback / remote ---- 不上报真实地址.
 */
function proxyBucketOf(env: any) {
  const one = (value: any) => {
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

function clampDimension(value: any) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(9999, Math.floor(value)))
}

/**
 * 生成本进程的客户端环境描述符(对齐官方 formatClientEnvironment).
 *
 * 本代理跑在容器/服务里,没有真实终端,所以按官方对"非交互环境"的
 * 取值填:in/out = 0(非 TTY),tp = none,l = 0,p/g = na(未查询),
 * osc = na.这是自洽的取值 ---- 官方自己也有 na 桶表示"未查询/不适用",
 * 伪造成一个真实终端反而与运行环境矛盾.
 *
 * @param {{ env?: Record<string, string|undefined>, columns?: number, rows?: number }} [opts]
 * @returns {string}
 */
export function formatClientEnvironment(opts: any = {}) {
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
    // 后 4 个字段是官方较新版本才加的(真机抓包 2026-10-01 确认存在).
    // 语义逐条对齐 cli/src/utils/client-environment.ts:377-380:
    //   tzo = TZ 覆盖了系统时区?(本进程不改 TZ → 0)
    //   px  = 代理桶(none/loopback/remote)
    //   tls = 是否禁用了证书校验(默认 1 = 正常校验)
    //   ca  = 是否追加了自定义 CA
    ['tzo', flag(env.TZ && String(env.TZ).trim())],
    ['px', proxyBucketOf(env)],
    ['tls', env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0' ? '0' : '1'],
    ['ca', flag(env.NODE_EXTRA_CA_CERTS?.trim())],
  ]
  return ['v1', ...fields.map(([k, v]) => `${k}=${v}`)].join(';')
}

/**
 * 本进程的环境描述符(构建一次后缓存:官方也是 per-process 构建一次).
 * @type {string | null}
 */
let cachedClientEnv: any = null

/** 取(并缓存)本进程的客户端环境描述符. */
export function clientEnvironment() {
  if (!cachedClientEnv) {
    cachedClientEnv = formatClientEnvironment({
      env: typeof process !== 'undefined' ? process.env : {},
    })
  }
  return cachedClientEnv
}
/**
 * 进程内生效的 CLI 版本号.启动时 = KNOWN_CLI_VERSION;refreshCliVersion() 成功后
 * 更新为 npm 上 freebuff 包的最新版本(上游只认[版本号看起来是真 CLi 发的]).
 */
let activeCliVersion = KNOWN_CLI_VERSION

/** 当前生效的 CLI 版本号(同步,无 IO). */
export function getCliVersion() {
  return activeCliVersion
}

/** 测试/运维用:显式设置版本号(非法值忽略). */
export function setCliVersion(version: any) {
  if (typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version.trim())) {
    activeCliVersion = version.trim()
  }
  return activeCliVersion
}

/**
 * 从 npm registry 对齐官方 CLI 的最新版本号(best-effort).
 *
 * 为什么值得做:UA 里的版本号是上游判断[这是不是官方客户端]的一部分指纹,写死一个
 * 过时值(旧实现是 1.0.0)长期看本身就是破绽.拿不到就保留现值 ---- 绝不因为一次
 * 网络失败影响代理可用性.
 *
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<string>} 生效的版本号
 */
export async function refreshCliVersion(opts: any = {}) {
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
