/**
 * 签到执行器: 逐账号 [读 streak 状态] + [需要时发一条最小消息落当天签到].
 *
 * ## 为什么不是"调一个签到接口"
 *
 * 官方没有"签到"接口. 客户端全仓只有一处 streak 相关调用:
 *   GET /api/v1/freebuff/streak   ---- 只读, 报告状态
 * 当天签到的触发条件是官方文案写死的那句:
 *   "+{freebucksDailyBonus} to your daily allowance with each day's first message"
 * 也就是[当天第一条消息]. 所以签到动作 = 建会话 + 发一条最小 chat.
 *
 * ## 成本控制(最硬的一条)
 *
 * admit = 买断一小时(见 .agents/notes/.../2026-09-14-paid-hour-hold.md).
 * 顺序严格是:
 *   1. 先 GET streak(只读, 零成本);
 *   2. todayCredited === true 或 todayUsed === true -> 跳过, 一分钱不花;
 *   3. 否则建会话 + 发最小消息.
 * 已签到过的账号绝不重复付费.
 *
 * 状态读不到时不猜也不试: 记一条 failed 让人看见, 而不是默默花钱.
 */
import { logger } from '../../../util/log.ts'
import { alreadySignedToday } from './store.ts'

/** 单账号签到结果. */
export interface SignInResult {
  key: string
  email?: string
  /** 本次是否真的发了消息(已签到过则为 false). */
  signedIn: boolean
  /** 跳过原因或失败原因. */
  reason: string | null
  /** 上游回执里的 streak 天数(拿得到就给). */
  streak: number | null
  /** 当日的额外奖励额度(freebucksDailyBonus). */
  dailyBonus: number | null
  ok: boolean
}

/**
 * 读一个账号的签到状态(只读, 零成本).
 *
 * 走 bun 通道拿官方形态的头; 拿不到返回 null, 调用方按[状态未知]处理
 * ---- 不猜, 也不用猜的结果去决定要不要花钱.
 *
 * @param {any} rt 账号运行时
 * @param {any} key 账号 key
 * @param {any} config 运行配置
 * @returns {Promise<any>} streak 回执;拿不到为 null
 */
async function readStreak(rt: any, key: string, config: any): Promise<any | null> {
  try {
    const mod: any = await import('../../../upstream/rpc/official-rpc.ts').catch(() => null)
    const ports: any = await import('../../../upstream/rpc/streak.ts').catch(() => null)
    if (!mod?.buildRpcCfg || !ports?.rpcStreak) return null
    const cfg = await mod.buildRpcCfg(rt.upstream, config)
    if (!cfg) return null
    cfg.apiHost = config?.upstream?.apiBase || null
    const r = await ports.rpcStreak({ cfg })
    if (!r?.ok) {
      logger.info('signin: streak read failed', { key, status: r?.status, error: r?.error })
      return null
    }
    return r.body ?? null
  } catch (err) {
    logger.info('signin: streak read threw', { key, error: String(err) })
    return null
  }
}

/**
 * 给一个账号落当天的签到(发一条最小消息).
 *
 * 前置条件由调用方保证(已确认今天没签过). 两步:
 *   1. ensureSession 建/复用会话 ---- 热会话直接复用, 不重复扣费;
 *   2. 用它发一条 hi(这一条就是[当天第一条消息]).
 *
 * 它不发工具: 签到关心的是[有消息], 不是模型答什么, 少带 tools 少一分失败面.
 *
 * @param {any} rt 账号运行时
 * @param {any} config 运行配置
 * @param {any} model 目录 key
 * @param {any} settings 运行设置
 * @returns {Promise<any>} 结果(ok / reason)
 */
async function sendSignInMessage(rt: any, config: any, model: string, settings: any) {
  try {
    const snap: any = await rt.sessions.ensureSession(model)
    const instanceId = snap?.instanceId || snap?.id
    if (!instanceId) return { ok: false, reason: 'no_session' }
    const mod: any = await import('../../../upstream/rpc/official-rpc.ts').catch(() => null)
    const ports: any = await import('../../../upstream/rpc/ports.ts').catch(() => null)
    if (!mod?.buildRpcCfg || !ports?.rpcReuse) return { ok: false, reason: 'rpc_unavailable' }
    const cfg = await mod.buildRpcCfg(rt.upstream, config)
    if (!cfg) return { ok: false, reason: 'no_rpc_cfg' }
    cfg.apiHost = config?.upstream?.apiBase || null
    // 与真实转发同源: 用服务端指派的 model 值, 且带上当前工具注入/系统提示配置,
    // 免得签到请求的形态与正常请求差出一截.
    const r = await ports.rpcReuse({
      cfg,
      instanceId,
      modelKey: snap?.model || model,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      layer: 'worker',
      stream: false,
      officialToolNames: settings?.officialToolNames,
      systemPrompt: settings?.systemPrompt,
      timeoutMs: 60_000,
    })
    if (!r?.ok) {
      return { ok: false, reason: `chat_${r?.status ?? 'failed'}` }
    }
    return { ok: true, reason: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.info('signin: send failed', { error: msg })
    return { ok: false, reason: msg }
  }
}

/**
 * 选一个用于签到的模型.
 *
 * 优先 freebucks.prices 里单价为 0 的那个(部分 reward/daily 池模型签到不花钱);
 * 没有 0 价就退回账号当前的会话模型, 再退回目录首行.
 * 全程从真值取, 不猜别名字符串.
 *
 * @param {any} rt 账号运行时
 * @param {any} row 账号池行(含 freebucks 快照)
 * @param {any} catalogCache 目录快照
 * @returns {any} 目录 key;选不出为 null
 */
function pickSignInModel(rt: any, row: any, catalogCache: any): string | null {
  try {
    const prices = row?.freebucks?.prices
      || rt?.sessions?.getSnapshot?.()?.quota?.freebucks?.prices
      || null
    if (prices && typeof prices === 'object') {
      const free = Object.entries(prices).find(([, v]) => v === 0)
      if (free) return String(free[0])
    }
    const snap = rt?.sessions?.getSnapshot?.()
    if (snap?.model && typeof snap.model === 'string') return snap.model
    const rows = catalogCache?.rows || catalogCache?.models || []
    const first = rows[0]
    return first?.key || first?.id || null
  } catch {
    return null
  }
}

/**
 * 跑一轮签到(手工或自动).
 *
 * 逐账号串行: 签到是一串上游写操作, 并发只会让[哪个账号扣了钱]难以归因;
 * 账号数量有限, 串行的墙钟代价可接受.
 *
 * @param {any} deps 依赖(runtimes / config / catalogCache / settings / store)
 * @param {any} kind 触发方式('manual' | 'auto')
 * @returns {Promise<any>} 逐账号结果与汇总
 */
export async function runSignInRound(deps: any, kind: 'manual' | 'auto') {
  const { runtimes, config, catalogCache, settings, store } = deps
  const results: SignInResult[] = []
  for (const row of runtimes.list()) {
    const rt = runtimes.get(row.key)
    const base = { key: row.key, email: row.email }
    if (!rt) {
      results.push({ ...base, signedIn: false, reason: 'no_runtime', streak: null, dailyBonus: null, ok: false })
      continue
    }
    const streak = await readStreak(rt, row.key, config)
    const days = typeof streak?.streak === 'number' ? streak.streak : null
    const bonus = typeof streak?.freebucksDailyBonus === 'number' ? streak.freebucksDailyBonus : null
    // 今天已签到 -> 跳过, 不花钱. 本模块最硬的一条判据.
    if (alreadySignedToday(streak)) {
      results.push({
        ...base, signedIn: false, reason: 'already_signed_today',
        streak: days, dailyBonus: bonus, ok: true,
      })
      continue
    }
    if (streak === null) {
      results.push({
        ...base, signedIn: false, reason: 'streak_unavailable',
        streak: null, dailyBonus: null, ok: false,
      })
      continue
    }
    const model = pickSignInModel(rt, row, catalogCache)
    if (!model) {
      results.push({ ...base, signedIn: false, reason: 'no_model', streak: days, dailyBonus: bonus, ok: false })
      continue
    }
    const sent = await sendSignInMessage(rt, config, model, settings)
    results.push({ ...base, signedIn: sent.ok, reason: sent.reason, streak: days, dailyBonus: bonus, ok: sent.ok })
  }
  store.markDone(kind, results.filter((r) => r.signedIn).map((r) => r.key))
  return {
    results,
    total: results.length,
    signedIn: results.filter((r) => r.signedIn).length,
    skipped: results.filter((r) => r.reason === 'already_signed_today').length,
    failed: results.filter((r) => !r.ok).length,
  }
}
