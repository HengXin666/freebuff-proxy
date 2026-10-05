import { parseChatRequest } from './proxy/routes/chat-request.ts'
import { handle as handleRoute } from './proxy/routes/router.ts'
import { releaseSessionUnlessPaid } from './proxy/routes/auth.ts'
import { mapAndSendError } from './proxy/transport/errors/respond.ts'
import { createChatState, withRequestSlot } from './proxy/chat/state/state.ts'
import { runChatLoop } from './proxy/chat/run/loop.ts'

/**
 * OpenAI-compatible surface under /v1 only.
 * Freebuff upstream calls are internal (/api/v1/...).
 *
 * 本文件保留原路径与全部原有导出名, 实现按职责拆进 ./proxy/**:
 *   proxy/chat/state/**    每请求一份的可变状态与全局槽位(并发正确性的支点)
 *   proxy/chat/acquire/**  选号与账号锁
 *   proxy/chat/run/**      一次上游调用 + 失败归类 + 重试决策
 *
 * 关键约束(见 .agents/notes/implemented/architecture/2026-10-05-proxy-js-split-by-responsibility.md):
 * 状态必须每请求一份. 因此 createChatState() 在请求作用域内调用, 而不是把
 * 字段提成模块级变量或类实例字段 ---- 后者会让并发请求互相覆盖对方的
 * lastKey / pendingGateCode / heldRt.
 *
 * @param {object} ctx 依赖集合(config / runtimes / userStore / settingsStore / modelStore)
 * @returns {{ handle: (req: object, res: object) => Promise<void> }} 请求处理器
 */
export function createProxyHandler(ctx: any) {
  const { config, runtimes, userStore, settingsStore } = ctx
  /** 传给已抽出的模块级函数(它们需要 config 等依赖). */
  const ctxValue = { config, runtimes, userStore, settingsStore, modelStore: ctx.modelStore }
  if (!runtimes) {
    throw new Error('createProxyHandler requires ctx.runtimes (AccountRuntimes)')
  }

  /** 前端[模型管理]配置的自定义模型(覆盖内置目录),实时生效.读取见 ./proxy/routes/catalog.ts. */

  /** 前端[模型管理]删除(隐藏)的模型 id,实时生效.读取见 ./proxy/routes/catalog.ts. */

  /**
   - 已删除 probeUpstreamSessionCached() 及其 60s 缓存.
   *
   - 它做过两件都错的事:
   - 1. 主动打上游 ---- 白名单校验时 GET /session,与[零自动探测]
   - (docs/reverse/20 §20.3:只有用户主动刷新才准探测)直接冲突;
   - 2. 无调用点 ---- 是死代码,却留着"随时会被重新接上"的隐患.
   *
   - 白名单判定所需的模型 id 现在全部来自本地:目录行(catalogKeys),
   - 内置 catalog,前端自定义,隐藏表.拿不到就是拿不到,如实拒绝,
   - 不为判定而发上游请求.
   */

  /**
   * 路由分发(实现在 ./proxy/routes/router.ts, 见其文件头).
   * @param {object} req 请求
   * @param {object} res 响应
   * @returns {Promise<void>} 处理完成
   */
  async function handle(req: any, res: any) {
    return handleRoute(ctxValue, handleChatCompletions, req, res)
  }

  /** 一键屏蔽收费模型开关(前端[模型管理],实时生效).读取见 ./proxy/routes/catalog.ts. */

  async function handleChatCompletions(req: any, res: any) {
    // 有界排队:闸门排满时最多等 slotWaitMs,超时以 429 server_busy 拒绝
    // (客户端可重试),绝不无界排队把整个服务静默钉死.
    // 实现与"客户端排队期间断开即放弃"见 ./proxy/chat/state.ts.
    const releaseSlot = await withRequestSlot(ctxValue, req, res, mapAndSendError)
    if (!releaseSlot) return
    try {
      await handleChatCompletionsInner(req, res)
    } finally {
      releaseSlot()
    }
  }

  async function handleChatCompletionsInner(req: any, res: any) {
    const parsed = await parseChatRequest(ctxValue, req, res)
    if (!parsed) return
    // 每请求一份状态:绝不提到模块级或实例字段(并发请求会互相覆盖).
    const st = createChatState(ctxValue, req, parsed)
    st.mapAndSendError = mapAndSendError
    st.releaseSessionUnlessPaid = (key: any, why: any) =>
      releaseSessionUnlessPaid(ctxValue, key, why)
    await runChatLoop(st, res)
  }

  /** 读请求体的上限(毫秒).<=0 关闭(不建议).见 ./proxy/routes/chat-request.ts. */

  return { handle }
}

/**
 - 搬进 ./proxy/* 的私有实现 ---- 必须逐个 import 进来,因为下面
 - createProxyHandler 内部直接调用它们.
 *
 - 教训(2026-10-05 实测复现的运行时回归):单靠末尾的
 - export { X } from './proxy/y.ts' 是不够的 ---- re-export 只影响本模块的
 - 对外导出,不会把 X 带进本模块的作用域.只写 re-export 的话,
 - createProxyHandler 里每个调用点都会抛 ReferenceError: X is not defined,
 - 而 node --check 与 tsc(默认 checkJs:false)都可能放过它.这与本仓历史上
 - 的 mergeOfficialTools: mapped is not defined 是同一形状.
 *
 - 自查纪律:搬走一个函数后 grep -n "<名>" <原文件> ---- 每一处出现必须是
 - import,注释或调用点,且 import 必须存在.
 */

// 这三个符号在 src/proxy.ts 里的对外导出名必须保持不变(消费方:
// src/server.ts,src/web/api.ts,test/smoke.mjs 含动态 import).
//  upstreamBodyEmbeddedError 在本次搬运前就是 src/proxy.ts 的导出符号,
// 搬进子模块后必须原样再导出,否则是无声的导出面收缩.
export { shouldSwitchAccountOnError } from './proxy/transport/errors/errors.ts'
export { requestSlotStats } from './proxy/transport/stream/slots.ts'
export { upstreamBodyEmbeddedError } from './proxy/transport/errors/errors.ts'
