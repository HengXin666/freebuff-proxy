/**
 * 默认值真源:硬编码常量 + 配置默认值 + YAML 键归一表.
 *
 * 从 src/config.js 拆出(原 446 行单文件).本文件只放数据,
 * 不放加载逻辑(那是 load.js).
 */

/**
 * 上游 API 主机  --  硬编码真源,不接受配置文件覆盖.
 *
 * 为什么不能可配(2026-10-04 Docker 部署事故,用户裁决"硬编码吧,不可能
 * 有人会去改"):全新容器把 config.example.yaml 复制成 /data/config.yaml,
 * 而 example 里写的是 https://codebuff.com(主机名少了 w 前缀).后果链:
 *
 *   所有上游请求打到主机名不完整的那台
 *     → 401 {"error":"unauthorized","message":"Missing or invalid Authorization header"}
 *     → 设备密钥注册失败(拿不到 keyId)
 *     → session GET 无签名 → 控制台显示[凭证失效]
 *
 * 而 token 完全有效:同一份凭证在 api_base 正确的实例上探测 ok=true,
 * 在全新容器上 401.差异只有这个主机字符串.
 *
 * 它能潜伏到用户头上的原因:两个值都是"看起来合理的 URL",少一个 w 前缀肉眼
 * 看不出来;本地开发读的是仓库根那份 config.yaml(写对了),只有全新
 * 部署(Docker 空卷走 example)才会踩中.
 *
 * 因此:这个值是代码常量,不是配置.配置文件里即便写了也一律忽略,
 * 老配置文件里写错的会被自动纠正.
 *
 * 唯一例外:FREEBUFF_UPSTREAM_API_BASE 环境变量  --  仅供本地镜像对照/
 * 离线契约测试(docs/reverse 里有这条用法),生产不设.
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
     * 请求形态通道.'legacy' 已废弃.
     *
     *   'official'(唯一有效值) --  上游请求一律经 RPC 委托给副仓库
     *       (cli-bridge / bun)执行:官方 37 工具,官方 system 模板,
     *       desktop 世代 agent,分层 provider.主服务不再自己拼上游请求.
     *       见 src/upstream/official-rpc.js 与 docs/reverse/18.
     *   'legacy'  --  已废弃,禁止调用:主服务自己拼的那套旧形态
     *       (ensureFreebuffSystemMessages + ensureFreebuffToolSignature +
     *        CLI 世代 agent + 自管 session 调度).它与官方抓包逐字段不符,
     *       且实测 admission 反复失败.保留该值只为兼容旧配置文件,
     *       实际一律回落 official(见 resolveUpstreamChannel).
     */
    channel: 'official',
    /** null → <dataDir>/credentials (legacy ./credentials kept as fallback) */
    credentialsDir: null,
    /** Explicit proxy URL, e.g. http://<user>:<pass>@host:7890. Env HTTP(S)_PROXY used otherwise. */
    proxy: null,
    /** 全局代理池(多代理):账号按稳定哈希分配到池内某个代理;连接失败自动回落下一个. */
    proxies: [],
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
    // 避免请求发到马上过期的会话上,中途卡住(默认 60s,付费模型适用 --
    // 付费会话每次 admit 都计费,尽量用到接近过期).
    reAdmitLeadSec: 60,
    // 免费模型(pool 非 premium)的提前切换阈值(秒):会话剩余不足该值时
    // 不再调度到该会话上,提前 re-admit 换全新会话(默认 60s = 1 分钟).
    // Freebucks 计费(2026-09,见 docs/account-scheduling-and-refund.md §3):
    // 每条 session 按整小时单价预扣,提前 DELETE 会按实际占用时长退还
    // 未用部分(freebucksRefund 回执, pending = 结算未完成,需用同一 instance
    // 重放 DELETE 取回执,不是"不退").所以提前 re-admit 只把当前这条换成新
    // 计费行,但每条都有结算开销 -- 够用就复用,别无谓空转.
    freeModelReAdmitLeadSec: 60,
    pollIntervalSec: 30,
    admitTimeoutMs: 30_000,
    // 空闲自动释放(秒):会话在途请求归零后,空闲超过该时长就早退 DELETE.
    //  已付费时段内不释放(2026-09-14 一手实测后改,结论与 09-13 版相反):
    // 上游一次 admit = 买断一小时,POST 当场扣满整小时单价,回执带 expiresAt.
    // 实测(账号 lolid8faw4er,模型 solar-pro4,无 units 行 → 纯 Freebucks 计费):
    //   admit rem 5 → 0;25s 后 DELETE → {freebucksRefundPending:true};
    //   +20/+40/+60/+120s rem 仍为 0(未到账);重放 DELETE ×2 仍只有 pending.
    // 而 session_units 那本账早退是当场按比例退的(实测 1.1 → 0.2).
    // 不对称才关键:实测 24 个[账号 × 模型]组合里 22 个是 Freebucks 先见底,
    // 所以早退等于拿稀缺的账去省不稀缺的账 -- 已付费的这一小时内继续用边际成本为 0.
    // 因此 idleReleaseSec 现在是付费时段结束之后的空闲释放时长;付费时段内
    // 一律不因空闲释放(见 session-manager._armIdleRelease 与 docs/freebucks-strategy.html).
    // 0 = 关闭释放(会话留到自然过期;代价是换模型要等).
    // 控制台[额度保护]可调(5s..24h).
    idleReleaseSec: 60,
  },
  limits: {
    maxConcurrentRequests: 32,
    // 全局请求闸门的排队上限(毫秒):排满时最多等这么久,超时返回 429
    // server_busy.旧实现无界排队 → 几个卡死的请求就能让整个服务永久不接单.
    slotWaitMs: 15_000,
    // 读请求体的上限(毫秒):客户端声明 Content-Length 却不再发完(SDK 中断,
    // 半开连接)时,readRequestBody 的 for-await 永不返回,请求会一直占着
    // 全局槽位.超时即放弃该请求(408),从根上消除槽位泄漏.
    bodyReadTimeoutMs: 120_000,
    // [首字节之前]的总调度预算(毫秒).本代理在写出响应头之前有多段串行
    // 静默等待(全局槽位 → 账号 chat 锁 → 上游首字节),最坏情况会累加到
    // 几分钟.上游链路前面挂着 Cloudflare(源站 100s 未回响应头即 524),
    // 等待超过这个天花板时客户端只会看到一个[连上了但一直转圈]的连接.
    // 这里给整个调度阶段一个总预算:超了就以 429 scheduling_timeout 快速返回
    // 让客户端重试,绝不静默闷等(默认 45s,明显低于 100s 的 524 悬崖).
    schedulingBudgetMs: 45_000,
    // 每个账号同一时间最多可转发的 SSE 响应流数(账号并发).默认 2:
    // 并发请求先挤在同一账号上(粘性优先,换号 = 多买一条 Freebucks 计费会话),
    // 超过该值才溢出到下一个账号.可在控制台[负载均衡]实时调整,立即生效.
    accountMaxConcurrency: 2,
    upstreamTimeoutSec: 600,
    // 上游流式响应 body 的 idle 超时(秒):收到响应头后若长时间没有新数据块,
    // 视为上游卡死(幽灵连接),主动掐断/换号,避免连接永远挂着.
    // 默认 60s -- 网络不稳定的上游 1 分钟不吐数据就该切换(用户明确要求);
    // 慢思考模型(DeepSeek 等)思考期可能 >30s 才出首包,别设太小.
    streamIdleTimeoutSec: 60,
    // 账号级串行化:同一账号同一时间只处理一个 chat.热 session 排队等待的
    // 上限(毫秒,约等于一个完整 idle 超时周期);超时后换下一个可用账号.
    accountChatWaitMs: 120_000,
    maxAutoRetryOnSessionError: 1,
    // 上游流被掐断(幽灵连接 idle 超时)后,账号的短暂冷却时长(秒):
    // 该账号刚被掐断过一次,说明上游/网络对该会话不稳定,短期内让新请求
    // 优先去别的账号,避免反复撞上同一条卡死的链路.0 = 不冷却(旧行为,
    // 掐断后下一请求仍可复用该会话).
    stallCooldownSec: 30,
    // 上游 chat 调用前的随机抖动上限(毫秒):每次请求前等 [0, N) 的随机时长,
    // 打散机器式等间隔节奏(上游风控按请求节奏指纹自动化;参考项目 SAFE_MODE
    // 默认 200ms).0 = 关闭(最低延迟).
    requestJitterMs: 200,
    // 一个下游请求最多新建几个上游会话(Freebucks 计费单位).
    // 上游按整小时单价预扣:admit 一次就扣整小时单价,但早退 DELETE 会按实际
    // 占用把未用部分退回来(见 docs/account-scheduling-and-refund.md §3).
    // 旧行为在报错时把[账号数 +1]个账号挨个 admit 一遍 -- 一次故障就同时占用
    // 好几条整小时额度(issue #7).默认 2:首个账号 + 一次换号兜底;复用已有
    // 热 session 不消耗预算.0 = 不限制(仅保留给调试).
    maxNewSessionsPerRequest: 2,
  },
  logging: {
    level: 'info',
    /**
     * 进程内日志环形缓冲的条数上限(控制台[日志]页读的就是它).
     *
     *  默认从 500 提到 5000(2026-10-04 真实事故):一次故障能在十几秒内
     * 刷出几百条,500 条瞬间被冲爆  --  用户事后想查更早的排障记录时,
     * 缓冲里只剩最近十几分钟,无法取证.日志不落盘(纯内存),所以这个上限
     * 就是能回溯的全部深度.
     *
     * 代价:每条日志约几百字节,5000 条约几 MB 内存  --  对容器可忽略.
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
