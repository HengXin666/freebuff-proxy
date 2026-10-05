/**
 * 一次 chat 请求的可变状态 ---- 从 src/proxy.ts 的 handleChatCompletionsInner 提出.
 *
 * ## 为什么必须有这个文件(并发正确性的唯一支点)
 *
 * 原实现把这批状态放在闭包里(createProxyHandler 内部), 因此每处理一个
 * 请求就新建一份, 天然"每请求独立". 搬出闭包时唯一危险的形态是: 把这些字段
 * 提成模块级变量或类实例字段 ---- 那会变成跨请求共享: 长驻进程里两个并发
 * 请求会互相覆盖对方的 lastKey / pendingGateCode / heldRt, 表现为"A 的失败被
 * 记到 B 的账号上""B 释放了 A 的锁". 这种 bug 在单请求测试里完全看不出来,
 * 只在真并发下偶发(见 .agents/notes/implemented/architecture/2026-10-05-proxy-js-split-by-responsibility.md
 * 的 Alternatives considered 第一条).
 *
 * 所以这里刻意不是类, 而是"每请求调用一次"的工厂: createChatState() 在
 * handleChatCompletionsInner 里被调用一次, 产出一个随请求生灭的独立对象.
 *
 * 验证方式(两条, 见交付报告):
 *   1. 静态: 全文搜 createChatState 的调用点必须是请求作用域内(每请求一次);
 *      模块级不得出现任何可变绑定.
 *   2. 动态: node test/tools/repro-concurrency.ts sticky 2 3 8 与拆分前逐行对比
 *      (并发 8 个请求在同一账号上串行, 账号分配/流峰值/账号状态三行必须一致).
 *
 * 口径: 纯搬移, 行为零改动.
 */
import { clientGoneSignal } from '../../transport/stream/stream-pipe.ts'
import { schedulingBudgetMs, slotWaitMs } from '../../config/limits.ts'
import { acquireRequestSlot } from '../../transport/stream/slots.ts'
import { buildChatState } from '../state/fields.ts'

/**
 * 请求级全局槽位(有界排队).
 *
 * 为什么单独成函数: 它是 handleChatCompletions 里唯一"在解析请求体之前"的
 * 等待, 与后面的选号/上游调用无共享状态, 因此可以被单测直接钉住(排队超时 →
 * 429 server_busy; 客户端断开 → 安静收场).
 * @param {any} ctx 依赖集合(含 config)
 * @param {any} req 下游请求
 * @param {any} res 下游响应
 * @param {(res: any, err: any) => void} onError 非 client_gone 的失败出口
 * @returns {Promise<(() => void) | null>} 槽位释放函数; null = 已收场(调用方直接返回)
 */
export async function withRequestSlot(ctx: any, req: any, res: any, onError: any) {
  // 客户端在排队期间断开:立即放弃等待(否则这个"已死"的请求会一直占着
  // 它稍后拿到的槽位,直到走完整个上游流程).
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
 - - 热 session(同模型可直接复用):等一个完整 idle 超时周期.上游卡死也会在
 - streamIdleTimeoutSec 后被掐断释放锁,所以热会话优先排队复用而不是新建 session.
 - - 冷账号/换模型:只等固定窗口,超时即换下一个账号.
 */
function chatWaitMs(st: any, rt: any) {
  // spread 模式:并发优先----账号满员就是"该换号了",只给一个短窗
  // (accountOverflowWaitMs,默认 15s)就溢出到下一个账号,绝不把并发
  // 钉死在一个账号上干等.sticky(默认)保留大等待:宁可排队也不换号,
  // 因为换号 = 新买一条 Freebucks 计费会话.
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
