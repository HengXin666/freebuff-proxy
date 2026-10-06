/**
 * 默认值真源:硬编码常量 + 配置默认值 + YAML 键归一表.
 *
 * 本文件只放数据, 不放加载逻辑(那是 load.ts).
 */

/**
 * 上游 API 主机 -- 代码常量, 不接受配置文件覆盖; 配置文件里写了也一律忽略,
 * 老配置里写错的会被自动纠正.
 *
 * 唯一例外: FREEBUFF_UPSTREAM_API_BASE 环境变量, 仅供本地镜像对照与
 * 离线契约测试.
 * 见 .agents/notes/implemented/bug-fix/2026-10-04-upstream-apibase-hardcoded.md
 */
export const UPSTREAM_API_BASE = 'https://www.codebuff.com'

/** 全量默认配置(loadConfig 的 deepMerge 基底). */
export const DEFAULTS: Record<string, any> = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    /** Optional Agent gate. Empty = open (OK on loopback only). */
    apiKeys: [],
    /** All persistent state (credentials, users, sessions, login flows). */
    dataDir: './data',
  },
  upstream: {
    apiBase: UPSTREAM_API_BASE,
    loginBase: 'https://freebuff.com',
    /**
     * 请求形态通道.
     *
     *   'official'(唯一有效值) --  上游请求一律经 RPC 委托给副仓库
     *       (cli-bridge / bun)执行:官方 37 工具, 官方 system 模板,
     *       desktop 世代 agent, 分层 provider. 主服务不自己拼上游请求.
     *       见 src/upstream/official-rpc.ts 与 docs/reverse/18.
     *   'legacy'  --  仅用于兼容旧配置文件: 该值一律回落 official
     *       (见 resolveUpstreamChannel), 见
     *       .agents/notes/implemented/architecture/2026-10-03-legacy-channel-deprecated.md
     */
    channel: 'official',
    /** null → <dataDir>/credentials (legacy ./credentials kept as fallback) */
    credentialsDir: null,
    /** Explicit proxy URL, e.g. http://<user>:<pass>@host:7890. Env HTTP(S)_PROXY used otherwise. */
    proxy: null,
    /** 全局代理池(多代理):账号按稳定哈希分配到池内某个代理;连接失败自动回落下一个. */
    proxies: [],
  },
  downstream: {
    /**
     * 下游客户端的本地工作目录(绝对路径).
     *
     * 有些下游工具要求[绝对搜索目录]这种本地事实, 而它不在上游请求里, 只能由
     * 控制台配一次. 未配置时同名工具的参数翻译不做兜底, 下游会明确报必填缺失.
     * 见 .agents/notes/implemented/bug-fix/2026-10-06-downstream-code-search-mapping.md
     */
    searchFolder: null,
  },
  web: {
    cookieSecure: false,
    sessionTtlHours: 24 * 7,
  },
  users: {
    /** First-run admin (created when no admin exists). */
    defaultAdminUsername: 'admin',
    /** null → random password printed once in logs (also ADMIN_PASSWORD env). */
    defaultAdminPassword: null,
  },
  session: {
    releaseOnShutdown: true,
    reAdmitOnExpire: true,
    // 会话剩余时间低于该值(秒)时不再承接新请求,提前 re-admit 换新会话,
    // 避免请求发到马上过期的会话上中途卡住(默认 60s).
    reAdmitLeadSec: 60,
    // 免费模型(pool 非 premium)的提前切换阈值(秒): 会话剩余不足该值时
    // 不再调度到该会话上, 提前 re-admit 换全新会话(默认 60s).
    freeModelReAdmitLeadSec: 60,
    pollIntervalSec: 30,
    admitTimeoutMs: 30_000,
    // 空闲自动释放(秒):会话在途请求归零后,空闲超过该时长就早退 DELETE.
    // 付费时段内一律不因空闲释放,该值作用于付费时段结束之后.
    // 0 = 关闭释放(会话留到自然过期;换模型需要等).
    // 控制台[额度保护]可调(5s..24h).
    // 见 .agents/notes/implemented/architecture/2026-09-14-paid-hour-hold.md 与
    // docs/design/freebucks-strategy.html
    idleReleaseSec: 60,
  },
  limits: {
    maxConcurrentRequests: 32,
    // 全局请求闸门的排队上限(毫秒):排满时最多等这么久,超时返回 429
    // server_busy. 排队有界, 卡死的请求不会让服务停止接单.
    slotWaitMs: 15_000,
    // 读请求体的上限(毫秒):客户端声明 Content-Length 却不再发完(SDK 中断,
    // 半开连接)时,readRequestBody 的 for-await 永不返回,请求会一直占着
    // 全局槽位.超时即放弃该请求(408),从根上消除槽位泄漏.
    bodyReadTimeoutMs: 120_000,
    // [首字节之前]的总调度预算(毫秒):本代理在写出响应头之前有多段串行
    // 静默等待(全局槽位 → 账号 chat 锁 → 上游首字节).超预算即以 429
    // scheduling_timeout 快速返回让客户端重试,不静默等待(默认 45s,
    // 低于上游 Cloudflare 源站 524 阈值 100s).
    schedulingBudgetMs: 45_000,
    // 每个账号同一时间最多可转发的 SSE 响应流数(账号并发).默认 2:
    // 并发请求先挤在同一账号上(粘性优先),超过该值才溢出到下一个账号.
    // 可在控制台[负载均衡]实时调整,立即生效.
    accountMaxConcurrency: 2,
    upstreamTimeoutSec: 600,
    // 上游流式响应 body 的 idle 超时(秒):收到响应头后若长时间没有新数据块,
    // 视为上游卡死,主动掐断/换号.
    // 默认 60s;慢思考模型(DeepSeek 等)思考期可能 >30s 才出首包,不宜过小.
    streamIdleTimeoutSec: 60,
    // 账号级串行化:同一账号同一时间只处理一个 chat.热 session 排队等待的
    // 上限(毫秒,约等于一个完整 idle 超时周期);超时后换下一个可用账号.
    accountChatWaitMs: 120_000,
    maxAutoRetryOnSessionError: 1,
    // 上游流被掐断(幽灵连接 idle 超时)后该账号的短暂冷却时长(秒):
    // 让新请求优先去别的账号,避免反复撞上同一条链路.0 = 不冷却.
    stallCooldownSec: 30,
    // 上游 chat 调用前的随机抖动上限(毫秒):每次请求前等 [0, N) 的随机时长,
    // 打散等间隔的请求节奏(上游风控按请求节奏指纹自动化).0 = 关闭.
    requestJitterMs: 200,
    // 一个下游请求最多新建几个上游会话(Freebucks 计费单位);复用已有热
    // session 不消耗预算.默认 2 = 首个账号 + 一次换号兜底.0 = 不限制.
    maxNewSessionsPerRequest: 2,
  },
  logging: {
    level: 'info',
    /**
     * 进程内日志环形缓冲的条数上限(控制台[日志]页读的就是它).
     * 日志不落盘(纯内存), 该上限即可回溯的全部深度.
     * 0 = 不保留(关闭缓冲).
     */
    ringCap: 5000,
  },
}

/** YAML snake_case → camelCase. Unknown keys kept as-is. */
export const KEY_MAP: Record<string, string> = {
  api_keys: 'apiKeys',
  api_base: 'apiBase',
  login_base: 'loginBase',
  credentials_dir: 'credentialsDir',
  data_dir: 'dataDir',
  cookie_secure: 'cookieSecure',
  session_ttl_hours: 'sessionTtlHours',
  default_admin_username: 'defaultAdminUsername',
  default_admin_password: 'defaultAdminPassword',
  release_on_shutdown: 'releaseOnShutdown',
  re_admit_on_expire: 'reAdmitOnExpire',
  re_admit_lead_sec: 'reAdmitLeadSec',
  free_model_re_admit_lead_sec: 'freeModelReAdmitLeadSec',
  poll_interval_sec: 'pollIntervalSec',
  admit_timeout_ms: 'admitTimeoutMs',
  max_concurrent_requests: 'maxConcurrentRequests',
  slot_wait_ms: 'slotWaitMs',
  body_read_timeout_ms: 'bodyReadTimeoutMs',
  account_max_concurrency: 'accountMaxConcurrency',
  upstream_timeout_sec: 'upstreamTimeoutSec',
  stream_idle_timeout_sec: 'streamIdleTimeoutSec',
  account_chat_wait_ms: 'accountChatWaitMs',
  scheduling_budget_ms: 'schedulingBudgetMs',
  max_auto_retry_on_session_error: 'maxAutoRetryOnSessionError',
  stall_cooldown_sec: 'stallCooldownSec',
  max_new_sessions_per_request: 'maxNewSessionsPerRequest',
  request_jitter_ms: 'requestJitterMs',
  idle_release_sec: 'idleReleaseSec',
  ring_cap: 'ringCap',
}

/** 已废弃的双轨字段:出现在旧配置里一律静默丢弃. */
export const DROPPED_KEYS: string[] = [
  'credentials_path',
  'auth_token',
  'read_local_credentials',
  'codebuff_api_key_env',
  'auto_admit',
]
