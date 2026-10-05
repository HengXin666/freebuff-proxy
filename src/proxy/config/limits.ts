/**
 * 各处的超时与预算常量 -- 为什么不写死在调用点.
 *
 * 它们都从 ctx.config.limits 读, 且都有默认值兜底的必要: 配置缺失时若返回
 * undefined, 会变成 setTimeout(undefined) 立即触发或永不触发 (两者都出现过).
 * 集中在一处是为了让这几个数分别是多少能被一眼看完, 而不是散在 2000 行的
 * 请求链路里.
 */

export /**
 - 流式 idle 超时:默认取 limits.streamIdleTimeoutSec;若会话剩余时间已知,
 - 在其基础上加一个 lead 宽限并封顶,会话过期后上游若不再吐数据(幽灵卡死)
 - 会更快被掐断,避免"会话快过期时响应卡住".带下限 30s,避免误伤慢首包.
 */
function effectiveStreamIdleMs(ctx: any, sessionRemainingMs: any) {
  const base = (ctx.config.limits.streamIdleTimeoutSec || 0) * 1000
  if (!(base > 0) || !Number.isFinite(sessionRemainingMs)) return base
  const lead = 20_000
  return Math.min(
    base,
    Math.max(30_000, Math.max(0, sessionRemainingMs) + lead),
  )
}

export /**
 - chat/completions 响应头等待上限(毫秒):与 body idle 同量级并带 30s 下限,
 - 且不超过全局 upstreamTimeoutSec.上游 chat 是流式接口,正常秒级出响应头;
 - 网络波动(TCP 黑洞/代理挂起)时等 upstreamTimeoutSec(默认 600s)才 abort,
 - 账号 chat 锁会被占死 10 分钟,所有新请求超时----必须尽快释放.
 */
function chatHeaderTimeoutMs(ctx: any) {
  const idleSec = ctx.config.limits.streamIdleTimeoutSec
  const idleMs = (Number.isFinite(idleSec) && idleSec > 0 ? idleSec : 120) * 1000
  const bound = Math.max(30_000, idleMs)
  const cap = (ctx.config.limits.upstreamTimeoutSec || 600) * 1000
  return Math.min(cap, bound)
}

export /**
 - 全局请求闸门的排队上限(毫秒).有界即可:这是"同一进程内等一个并发
 - 名额"的预算,不是上游等待.给足 15s 让突发流量自然消化,超时就明确
 - 拒绝,绝不像旧实现那样把请求永久挂在队列里.可用
 - limits.slotWaitMs 调整(<=0 表示一旦排满立即拒绝).
 */
function slotWaitMs(ctx: any) {
  const v = ctx.config.limits.slotWaitMs
  return Number.isFinite(v) && v > 0 ? v : 0
}

export /**
 - [首字节之前]的调度总预算(毫秒).上游链路前置 Cloudflare(源站 100s
 - 未回响应头即 524),而本代理在 writeHead 之前有多段串行静默等待(全局槽位
 - → 账号 chat 锁 → 上游首字节).默认 45s:留足正常排队余量,又明显低于
 - 100s 悬崖,绝不把请求静默拖到客户端早已超时.
 */
function schedulingBudgetMs(ctx: any) {
  const v = ctx.config.limits.schedulingBudgetMs
  return Number.isFinite(v) && v > 0 ? v : 45_000
}

export function bodyReadTimeoutMs(ctx: any) {
  const v = ctx.config.limits.bodyReadTimeoutMs
  return Number.isFinite(v) && v > 0 ? v : 0
}
