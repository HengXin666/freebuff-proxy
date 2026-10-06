/**
 * 签到端口(rpcStreak) -- 从 ports.ts 按体量拆出.
 *
 * 拆出原因: ports.ts 加上签到后 321 行, 撞了后端 300 行硬红线.
 * 本文件只放这一件事: 把 GET /api/v1/freebuff/streak 委托给 bun 侧执行.
 *
 * 为什么它单独一个文件而不是搭在 session 上: 它是只读的状态查询,
 * 与会话的 admit/release 不是一类; 混在一起会让"读状态"与"买会话"共用
 * 失败路径, 而前者是可以静默失败的.
 */
import { callBun } from '../../../cli-bridge/bridge.ts'

/**
 * 连续签到状态(端口):GET /api/v1/freebuff/streak.
 *
 * 与 rpcSession 同理: 不在这里拼头, 交给 bun 侧的唯一官方形态实现.
 * 它是只读的: 真实[签到]由[当天第一条消息]触发, 这个端口只报告结果
 * (streak / freebucksDailyBonus / todayUsed / nextResetAt ...).
 *
 * @param {{ cfg: object, timeoutMs?: number }} params
 * @returns {Promise<{ ok: boolean, status?: number, body?: any, error?: string }>} 结果
 */
export async function rpcStreak(params: any) {
  const { cfg, timeoutMs = 20_000 } = params
  try {
    const out: any = await callBun({ cfg, action: 'streak' }, timeoutMs)
    return {
      ok: out?.ok === true,
      status: out?.status ?? null,
      body: out?.result ?? null,
      error: out?.error || null,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
