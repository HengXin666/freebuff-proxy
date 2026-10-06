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
 *   proxy/chat/run/**      一次上游调用 + 失败归类 + 重试分支
 *
 * 关键约束(见 .agents/notes/implemented/architecture/2026-10-05-proxy-js-split-by-responsibility.md):
 * 状态必须每请求一份: createChatState() 在请求作用域内调用, 字段不提成模块级变量
 * 或类实例字段.
 *
 * 顶层路径与导出名是契约面: 保留原路径 + 按职责拆子目录
 * (见 .agents/notes/implemented/architecture/2026-10-05-src-top-level-split-by-responsibility.md).
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
   - 白名单判定所需的模型 id 全部来自本地: 目录行(catalogKeys), 内置 catalog,
   - 前端自定义, 隐藏表. 不为此发上游请求(见 docs/reverse/20).
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
    // 有界排队:闸门排满时最多等 slotWaitMs,超时以 429 server_busy 拒绝.
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
 - 搬进 ./proxy/* 的私有实现必须逐个 import 进来: re-export 只影响本模块的
 - 对外导出, 不会把符号带进本模块作用域, 而 createProxyHandler 内部直接调用它们.
 */

// 以下符号在 src/proxy.ts 的对外导出名保持不变(消费方: src/server.ts, src/web/api.ts,
// test/smoke.mjs 含动态 import).
export { shouldSwitchAccountOnError } from './proxy/transport/errors/errors.ts'
export { requestSlotStats } from './proxy/transport/stream/slots.ts'
export { upstreamBodyEmbeddedError } from './proxy/transport/errors/errors.ts'
