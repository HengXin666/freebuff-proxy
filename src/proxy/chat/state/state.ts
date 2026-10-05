/**
 * 一次 chat 请求的可变状态.
 *
 * 每请求一份: 这批字段必须随请求生灭, 不得提成模块级变量或类实例字段.
 * 工厂形态 ---- createChatState() 在 handleChatCompletionsInner 里被调用一次,
 * 产出一个独立的请求作用域对象.
 *
 * 约束: 模块级不得出现任何可变绑定; createChatState 的调用点必须在请求作用域内.
 * 见 .agents/notes/implemented/architecture/2026-10-05-proxy-js-split-by-responsibility.md
 */
import { clientGoneSignal } from '../../transport/stream/stream-pipe.ts'
import { schedulingBudgetMs, slotWaitMs } from '../../config/limits.ts'
import { acquireRequestSlot } from '../../transport/stream/slots.ts'
import { buildChatState } from '../state/fields.ts'

/**
 * 请求级全局槽位(有界排队).
 *
 * 是 handleChatCompletions 里唯一在解析请求体之前的等待: 排队超时 -> 429 server_busy;
 * 客户端断开 -> 安静收场.
 * @param {any} ctx 依赖集合(含 config)
 * @param {any} req 下游请求
 * @param {any} res 下游响应
 * @param {(res: any, err: any) => void} onError 非 client_gone 的失败出口
 * @returns {Promise<(() => void) | null>} 槽位释放函数; null = 已收场(调用方直接返回)
 */
export async function withRequestSlot(ctx: any, req: any, res: any, onError: any) {
  // 客户端在排队期间断开: 立即放弃等待, 不占用稍后拿到的槽位.
  const slotGone = clientGoneSignal(req)
  try {
    return await slotGone.race(
      acquireRequestSlot(ctx.config.limits.maxConcurrentRequests, slotWaitMs(ctx)),
    )
  } catch (err: any) {
    // client_gone:连接已没了,安静收场(无法再写响应).
    if (err?.code !== 'client_gone') onError(res, err)
    return null
  } finally {
    slotGone.cleanup()
  }
}

/**
 * 建一份本次请求专属的可变状态.
 *
 * 每个字段都逐字对应原闭包里的一个局部变量(名称保持可检索), 字段表本身在
 * ./state-fields.ts(它只是一份对象字面量, 与这里的时序逻辑分开读).
 * @param {any} ctx 依赖集合(config / runtimes / settingsStore / modelStore)
 * @param {any} req 下游请求
 * @param {any} parsed parseChatRequest 的结果(body / upstreamModel / catalogKeys)
 * @returns {any} 请求级状态对象(引用相等即"同一次请求")
 */
export function createChatState(ctx: any, req: any, parsed: any) {
  const st: any = buildChatState(ctx, req, parsed)
  const { config, runtimes, settingsStore } = ctx
  const budgetSetting = settingsStore?.get?.()?.maxNewSessionsPerRequest
  const budgetRaw = Number.isFinite(budgetSetting)
    ? budgetSetting
    : config.limits.maxNewSessionsPerRequest
  const budgetLimit = Number.isFinite(budgetRaw) ? Math.floor(budgetRaw) : 2
  st.sessionBudget = {
    // 0(或负数)= 不限额:remaining 为 null 时闸门恒放行,也不递减.
    remaining: budgetLimit > 0 ? budgetLimit : null,
  }
  /** 释放当前账号的串行化锁与在途标记(换号/请求结束时调用). */
  st.dropChatHold = () => dropChatHold(st)
  st.chatWaitMs = (rt: any) => chatWaitMs(st, rt)
  return st
}

/** 释放当前账号的串行化锁与在途标记(换号/请求结束时调用). */
function dropChatHold(st: any) {
  if (st.releaseChat) {
    st.releaseChat()
    st.releaseChat = null
  }
  if (st.rt) {
    st.rt.sessions.endRequest()
    st.rt = null
  }
  // 预留槽位(选号时占用)必须无论如何交还:它是 spread 排序看见
  // "这个账号马上要满了"的唯一依据,泄漏一次就会让账号被误判为满员.
  if (st.releaseReserved) {
    st.releaseReserved()
    st.releaseReserved = null
  }
}

/**
 - 账号锁等待时长(仅在所有可用账号都满员时排队才生效;有账号空闲时
 - 选号阶段就已换号,不会走到这里):
 - - 热 session(同模型可直接复用):等一个完整 idle 超时周期; 卡死的上游会在
 - streamIdleTimeoutSec 后被掐断释放锁.
 - - 冷账号/换模型:只等固定窗口,超时即换下一个账号.
 */
function chatWaitMs(st: any, rt: any) {
  // spread 模式: 账号满员即溢出到下一个账号, 只给一个短窗
  // (accountOverflowWaitMs, 默认 15s). sticky(默认)保留大等待: 优先排队,
  // 不主动换号.
  if (st.runtimes.schedulingMode() === 'spread') {
    const overflow = st.settingsStore?.get?.()?.accountOverflowWaitMs
    const ms = Number.isFinite(overflow) ? overflow : 15_000
    return Math.max(0, Math.min(ms, 60_000))
  }
  if (rt.sessions.isUsableForModel(st.upstreamModel)) {
    return ((st.config.limits.streamIdleTimeoutSec || 120) * 1000) + 15_000
  }
  return st.config.limits.accountChatWaitMs || 60_000
}
