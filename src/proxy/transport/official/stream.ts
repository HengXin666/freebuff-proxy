/**
 * official 通道的流式 RPC 段 -- 从 official.ts 按体量红线切出.
 *
 * 只管一件事: 把 rpcReuse 的流式输出织成下游可读的 Response, 并保证
 * "提交下游响应头之前只等上游状态行, 不等正文".
 *
 * 为什么这条约束是根因修复: 旧链路 bun 侧 await res.text() 攒完整篇才返回,
 * 主服务要等整篇回复; 长回答(线上实测 44.8s)撞穿 45s 调度预算 -> 降级 legacy
 * -> 428 -> 换号 -> 全池买不起 -> 下游 429.
 *
 * 口径: 从 official.ts 搬移, 行为零改动.
 */
import { rpcReuse } from '../../../upstream/rpc/official-rpc.ts'
import { buildUpstreamResponseFromRpc } from '../reply/rewrite.ts'
import { logger } from '../../../util/log.ts'

/**
 * 记一条 RPC 结果日志.
 *
 * 非 200 时必须把上游原文记下来(2026-10-04 教训): 此前只记 status, 于是 503 时
 * 日志里只有一行 status=503, 而上游原文(放 rpc.text 里)只塞进 Response 不落日志,
 * 排障时只能看见数字看不到原因. 截断到 300 字符: 够看清 message/code, 又不至于
 * 把整段流式体写进日志.
 *
 * @param {any} rpc rpcReuse 的回执
 * @returns {void} 无返回值
 */
export function logRpcResult(rpc: any): void {
  logger.info('official channel: rpc result', {
    status: rpc.status,
    ok: rpc.ok,
    model: rpc.model?.name,
    error: rpc.error,
    streamed: rpc.streamed === true,
    body: rpc.ok || !rpc.text ? undefined : String(rpc.text).slice(0, 300),
  })
}

/**
 * 流式: 只等上游状态行就交出响应体(不等正文), 首字节延迟与纯透传等同.
 *
 * 三态:
 *   - 状态行 = 200: 立刻返回带流体的 Response; 后台任务负责在 RPC 结束时关闭写端.
 *   - 状态行非 200: 等 RPC 收完错误体, 返回带真实状态码的普通响应
 *     (不能包成 200, 否则下游看不见 428/503).
 *   - 任何信号之前就失败: 返回 null, 让调用方降级 legacy.
 *
 * @param {any} rpcArgs rpcReuse 入参
 * @param {any} carrierPlan 载体映射
 * @param {any} declaredToolNames 本次声明的工具名
 * @param {any} declaredToolSchemas 本次声明的工具 schema
 * @param {any} paramContext 运行期参数(下游本地事实)
 * @returns {Promise<{upstreamRes: any, upstreamErrText: any}|null>} 结果
 */
export async function runStreamingRpc(
  rpcArgs: any, carrierPlan: any, declaredToolNames: any, declaredToolSchemas: any, paramContext?: any,
) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  let pipeBroken = false

  /** 首个决定性信号: 状态行 或 失败. */
  let signalResolved = false
  let resolveSignal: (v: { kind: string; status?: number; rpc?: any; err?: any }) => void = () => {}
  const firstSignal = new Promise<{ kind: string; status?: number; rpc?: any; err?: any }>((resolve) => {
    resolveSignal = resolve
  })
  const signalOnce = (v: { kind: string; status?: number; rpc?: any; err?: any }) => {
    if (signalResolved) return
    signalResolved = true
    resolveSignal(v)
  }

  const rpcPromise = rpcReuse({
    ...rpcArgs,
    onStatus: (s: number) => signalOnce({ kind: 'status', status: s }),
    onLine: (line: string) => {
      if (pipeBroken || !line) return
      void writer.write(encoder.encode(line + '\n')).catch(() => { pipeBroken = true })
    },
  }).then(
    (rpc: any) => {
      logRpcResult(rpc)
      signalOnce({ kind: 'done', rpc })
      return rpc
    },
    (err: any) => {
      signalOnce({ kind: 'error', err })
      return null
    },
  )

  const signal = await firstSignal

  // 还没拿到状态行就失败: 释放管道, 交给调用方降级 legacy.
  if (signal.kind === 'error') {
    try { await writer.close() } catch { /* 已关 */ }
    void rpcPromise
    logger.warn('official channel rpc failed, falling back to legacy', {
      error: String(signal.err?.message || signal.err),
    })
    return null
  }

  // 状态行 200: 立刻把流交给下游(不等正文) ---- 首字节延迟与纯透传等同.
  if (signal.kind === 'status' && signal.status === 200) {
    void rpcPromise.then(async (rpc: any) => {
      // 状态行之后中途出错: 把上游原文补进管道, 让下游看到原因而不是空响应.
      if (rpc && rpc.status && rpc.status !== 200 && rpc.text && !pipeBroken) {
        await writer.write(encoder.encode(String(rpc.text))).catch(() => {})
      }
      try { await writer.close() } catch { /* 已关/已断 */ }
    })
    return {
      upstreamRes: buildUpstreamResponseFromRpc(
        { status: 200, streamedBody: readable, streamed: true },
        carrierPlan,
        declaredToolNames,
        declaredToolSchemas,
        paramContext,
      ),
      upstreamErrText: null,
    }
  }

  return buildStatusMismatchResult(
    rpcPromise, writer, carrierPlan, declaredToolNames, declaredToolSchemas, paramContext, signal,
  )
}

/**
 * 状态行非 200(或没有状态行就结束)时的收口: 等 RPC 收全, 用真实状态码交出.
 *
 * 不能把它包成 200 ---- 否则下游看不见 428/503, 错误被吞掉.
 *
 * @param {Promise<any>} rpcPromise RPC 完成 promise
 * @param {any} writer 管道写端
 * @param {any} carrierPlan 载体映射
 * @param {any} declaredToolNames 本次声明的工具名
 * @param {any} declaredToolSchemas 本次声明的工具 schema
 * @param {any} paramContext 运行期参数(下游本地事实)
 * @param {{status?: number}} signal 首个信号(取状态码兜底)
 * @returns {Promise<{upstreamRes: any, upstreamErrText: any}|null>} 结果
 */
async function buildStatusMismatchResult(
  rpcPromise: Promise<any>,
  writer: any,
  carrierPlan: any,
  declaredToolNames: any,
  declaredToolSchemas: any,
  paramContext: any,
  signal: { status?: number },
) {
  const rpc: any = await rpcPromise
  try { await writer.close() } catch { /* 已关 */ }
  const status = rpc?.status ?? signal.status ?? null
  if (!status) return null
  const finalRpc = { ...(rpc || {}), status }
  return {
    upstreamRes: buildUpstreamResponseFromRpc(
      finalRpc,
      carrierPlan,
      declaredToolNames,
      declaredToolSchemas,
      paramContext,
    ),
    upstreamErrText: finalRpc.ok ? null : (finalRpc.text || ''),
  }
}
