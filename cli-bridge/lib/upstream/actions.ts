/**
 * CLI action 分发 -- 从 cli-bridge/upstream.ts 的入口块按职责搬出.
 *
 *
 * 两处与原文的等价变换(纯机械, 不改行为):
 *   1. 原链里 release 分支写了两次(第二处永远不可达, 两个分支体逐字相同)
 *      -- 表里只留一条, 语义等价.
 *   2. pickRow 把 5 个分支里重复的 rows.find(...) || rows[0] 兜底抽成一处.
 */
import type { BridgeLike } from './bridge.ts'

/** 单个 action 的入参:桥接实例 / 原始输入 / 待填充的输出. */
interface ActionCtx {
  bridge: BridgeLike
  input: any
  out: any
}

/** 一个 action 的实现(读 input, 写 out). */
type ActionFn = (ctx: ActionCtx) => Promise<void>

/**
 * 按 modelKey 在 catalog 里挑一行:优先目录 key, 次选本次抓取的 handle.
 *
 * 绝不回落首行. 旧实现是 "|| rows[0]", 它把一个定位失败伪装成定位成功:
 * 会话是按 A 模型的 handle 绑定的, 回落首行就会拿 B 模型的 handle 去 chat,
 * 上游回 409 session_model_mismatch, 而本地日志只会显示
 * rpc result ... model=<别的模型> ---- 排障时看不见真实原因.
 *
 * 实测(2026-10-05, 远程 reqId ea7b362d):主服务持有的 handle 与 bun 现场抓到的
 * handle 不同(handle 每次抓取全量轮换, 只有 key 稳定; 见 docs/reverse/19 第 19.3 节),
 * 于是 find(handle) 落空 -> 回落 catalog 首行(当时是 MiMo 2.6 Flash) -> 用一个
 * 与会话不符的模型标识发 chat -> 409.
 *
 * @param {BridgeLike} bridge 桥接实例(catalog 已在 runAction 里抓过)
 * @param {any} input 原始输入
 * @returns {any} 命中的 catalog 行;定位失败返回 null(调用方必须显式报错)
 */
function pickRow(bridge: BridgeLike, input: any): any {
  const rows = bridge.catalog?.rows
  if (!Array.isArray(rows) || rows.length === 0) return null
  return rows.find((r) => r.key === input.modelKey)
    || rows.find((r) => r.handle === input.modelKey)
    || null
}

/**
 * pickRow 失败时统一的显式失败出口:写 out.error 并置 ok=false.
 *
 * @param {any} out 输出对象
 * @param {any} modelKey 未命中的模型标识
 * @returns {void} 无返回值
 */
function failUnknownModel(out: any, modelKey: any): void {
  out.error = `model not found in catalog: ${modelKey}`
  out.ok = false
}

/** 抓目录并放进 out.catalog. */
async function actCatalog({ bridge, out }: ActionCtx): Promise<void> {
  out.catalog = await bridge.fetchCatalog()
}

/** 注册设备公钥. */
async function actDeviceKeys({ bridge, input, out }: ActionCtx): Promise<void> {
  out.result = await bridge.registerDeviceKey(input.publicKey)
}

/**
 * 读会话. instanceId / heartbeat 由主服务下发(官方的"持有心跳"形态).
 */
async function actSession({ bridge, input, out }: ActionCtx): Promise<void> {
  out.result = await bridge.getSession({
    instanceId: input.instanceId || null,
    heartbeat: input.heartbeat === true,
  })
}

/** 释放会话. */
async function actRelease({ bridge, input, out }: ActionCtx): Promise<void> {
  out.result = await bridge.release(input.instanceId)
}

/** 买断一个模型的会话(admission). */
async function actAdmit({ bridge, input, out }: ActionCtx): Promise<void> {
  const row = pickRow(bridge, input)
  if (!row) return failUnknownModel(out, input.modelKey)
  out.model = { key: row.key, name: row.displayName }
  out.result = await bridge.admit(row)
}

/** 开一次 run. */
async function actStartRun({ bridge, input, out }: ActionCtx): Promise<void> {
  out.result = await bridge.startRun(input.agentId, { layer: input.layer || 'worker' })
}

/** 发一次 chat(需要调用方已持有 instanceId / runId). */
async function actChat({ bridge, input, out }: ActionCtx): Promise<void> {
  const row = pickRow(bridge, input)
  if (!row) return failUnknownModel(out, input.modelKey)
  out.model = { key: row.key, name: row.displayName }
  out.result = await bridge.chat({
    row,
    instanceId: input.instanceId,
    runId: input.runId,
    messages: input.messages,
    tools: input.tools,
    stream: input.stream,
  })
}

/** 复用已有会话:只做 startRun + chat,绝不 admission. */
async function actReuse({ bridge, input, out }: ActionCtx): Promise<void> {
  const row = pickRow(bridge, input)
  if (!row) return failUnknownModel(out, input.modelKey)
  out.model = { key: row.key, name: row.displayName }
  const run = await bridge.startRun(input.agentId, { layer: input.layer || 'worker' })
  out.startRun = { status: run.status, runId: run.runId }
  if (!run.runId) {
    out.ok = false
    return
  }
  const c = await bridge.reuseChat({
    row, instanceId: input.instanceId, runId: run.runId,
    messages: input.messages, tools: input.tools, stream: input.stream,
  })
  out.chat = c
  out.ok = c.status === 200
}

/**
 * 只构造并 dump, 不发送. 用于与官方抓包做离线逐字段对比, 零额度消耗.
 */
async function actDryrun({ bridge, input, out }: ActionCtx): Promise<void> {
  const row = pickRow(bridge, input)
  if (!row) return failUnknownModel(out, input.modelKey)
  const fakeInst = 'cli:dryrun-' + crypto.randomUUID()
  const fakeRun = 'dryrun-' + crypto.randomUUID()
  await bridge.chat({
    row, instanceId: fakeInst, runId: fakeRun,
    messages: input.messages || [{ role: 'user', content: 'x' }],
    tools: input.tools, layer: input.layer || 'worker',
    reasoningEffort: input.reasoningEffort || null,
    stream: input.stream !== false,
    noSend: true,
  }).catch(() => ({}))
  out.dryrun = { instanceId: fakeInst, runId: fakeRun, sent: false }
  out.ok = true
}

/**
 * 一次跑完: admit -> startRun -> chat(严格单次, 不重试, 不重建).
 *
 * FINISH 上报: 官方每次 run 结束都发(line 32/65/74);
 * steps[].messageId 取流式响应的 chatcmpl-*.
 */
async function actFull({ bridge, input, out }: ActionCtx): Promise<void> {
  const row = pickRow(bridge, input)
  if (!row) return failUnknownModel(out, input.modelKey)
  out.model = { key: row.key, name: row.displayName }
  const ad = await bridge.admit(row)
  out.admit = { status: ad.status, state: ad.body?.status, error: ad.body?.error }
  if (ad.body?.status !== 'active') {
    out.ok = false
    return
  }
  const inst = ad.body.instanceId || ad.instanceId
  out.instanceId = inst
  const run = await bridge.startRun(input.agentId, { layer: input.layer || 'worker' })
  out.startRun = { status: run.status, runId: run.runId }
  if (!run.runId) {
    out.ok = false
    return
  }
  //  参数名必须是 instanceId(chat 的解构键名).
  // 上游不知道请求属于哪个会话 -> 428 waiting_room_required.
  const c = await bridge.chat({
    row, instanceId: inst, runId: run.runId,
    messages: input.messages, tools: input.tools,
    stream: input.stream !== false,
    layer: input.layer || 'worker',
    reasoningEffort: input.reasoningEffort || null,
  })
  out.chat = c
  out.ok = c.status === 200
  if (input.finishRun === false) return
  const steps = c.messageId
    ? [{
        id: c.messageId, stepNumber: 1, credits: 0,
        childRunIds: [], messageId: c.messageId,
        status: c.status === 200 ? 'completed' : 'failed',
        startTime: new Date().toISOString(),
      }]
    : []
  out.finishRun = await bridge.finishRun(run.runId, {
    status: c.status === 200 ? 'completed' : 'failed',
    steps,
  })
}

/** action 名 -> 实现. 与原文 if / else-if 链逐分支对应. */
const ACTIONS: Record<string, ActionFn> = {
  catalog: actCatalog,
  deviceKeys: actDeviceKeys,
  session: actSession,
  release: actRelease,
  admit: actAdmit,
  startRun: actStartRun,
  chat: actChat,
  reuse: actReuse,
  dryrun: actDryrun,
  full: actFull,
}

/**
 * 执行一个 action 并返回要序列化到 stdout 的结果对象.
 *
 * catalog 是唯一的例外: 其它 action 都先抓一次目录(需要 rows 做模型匹配).
 * @param {BridgeLike} bridge 桥接实例
 * @param {any} input 原始输入(action / cfg / 各 action 的字段)
 * @returns {Promise<any>} 输出对象(含 action; 失败时为 error / ok=false)
 */
export async function runAction(bridge: BridgeLike, input: any): Promise<any> {
  const act = input.action
  const out: any = { action: act }
  try {
    if (act !== 'catalog') await bridge.fetchCatalog()
    const fn = ACTIONS[act]
    if (!fn) {
      out.error = `unknown action: ${act}`
      return out
    }
    await fn({ bridge, input, out })
  } catch (e: any) {
    out.error = String(e?.message || e)
    out.ok = false
  }
  return out
}
