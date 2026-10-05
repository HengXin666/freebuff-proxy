/**
 * 两个横切鉴权/释放工具 -- 从 src/proxy.ts 搬出.
 *
 * authorize: 下游 API Key 鉴权(配置里的 apiKeys 或用户表里的 key).
 * releaseSessionUnlessPaid: 释放上游会话的唯一允许入口 -- 付费时段内一律
 *   拒绝, 因为早退 DELETE 不退 Freebucks (买断制, POST 当场扣整小时).
 *
 * 口径: 纯搬移, 行为零改动.
 */

import { timingSafeEqual } from 'node:crypto'
import { sendJson, readBearer } from '../../util/http.ts'
import { apiKeyMatches } from '../transport/stream/stream-pipe.ts'
import { logger } from '../../util/log.ts'

export /**
 - 释放账号的上游会话 ---- 付费时段内一律拒绝,这是唯一允许的释放入口.
 *
 - 为什么要有这个统一入口(2026-10-04 真实事故):
 - ctx.runtimes.releaseSession(key) 此前散落在 7 处重试/换号路径上,
 - 每一处都是无条件的早退 DELETE.而 Freebucks 是买断制(POST 当场扣
 - 整小时单价),早退 不退钱(实测只回 freebucksRefundPending,
 - 观察 2 分钟未到账)---- 于是每一次换号/最终失败都在把已付的一小时扔掉.
 *
 - 用户看到的后果:请求一次 → 钱扣光 → 请求失败 → 会话也没了 →
 - 下一个请求买不起(freebucks_exhausted)→ 表现成"账号废了".
 *
 - 修法:把释放收敛到这一个函数,在付费时段内直接拒绝(并留日志),
 - 只允许"付费时段已过"时释放.这样将来新增重试路径也不会再漏 ----
 - 只要它调的是这个函数.
 *
 - @param {string} key 账号 key
 - @param {string} why 释放原因(写进日志,便于复盘谁在释放)
 - @returns {boolean} 是否真的发起了释放
 */
function releaseSessionUnlessPaid(ctx: any, key: any, why: any) {
  if (!key) return false
  let inPaid = false
  try {
    inPaid = ctx.runtimes.get?.(key)?.sessions?.inPaidWindow?.() === true
  } catch {
    inPaid = false
  }
  if (inPaid) {
    logger.info('refusing to release session: paid hour still running', {
      key,
      why,
      note: 'early DELETE does not refund Freebucks — releasing would burn the money',
    })
    return false
  }
  ctx.runtimes.releaseSession(key)
  return true
}

export function authorize(ctx: any, req: any, res: any) {
  const keys = ctx.config.server.apiKeys || []
  if (keys.length === 0 && !ctx.userStore) return true
  const token = readBearer(req)
  if (keys.length > 0 && token && apiKeyMatches(token, keys)) {
    return true
  }
  if (ctx.userStore) {
    const user = token ? ctx.userStore.getByApiKey(token) : null
    if (user) return true
  }
  sendJson(res, 401, {
    error: {
      message: 'Invalid proxy API key',
      type: 'auth_error',
      code: 'invalid_api_key',
    },
  })
  return false
}
