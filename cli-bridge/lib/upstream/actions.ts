/**
 * CLI action 分发 -- 从 cli-bridge/upstream.ts 的入口块按职责搬出.
 *
 * 为什么单独成文件: 这段是 125 行的 if / else-if 链, 每个分支把 input 里的
 * 字段喂给 bridge 的某个方法. 它关心的只有 [action 名字到端点方法的映射],
 * 与 [BridgeLike 怎么签名, 怎么持有 cfg] 完全无关. 搬出来之后, 加一个新 action
 * 只需要在 ACTIONS 表里加一行, 不必再读一遍签名逻辑.
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
 * 按 modelKey 在 catalog 里挑一行(支持 key / handle; 都匹配不上时回落首行).
 * @param {BridgeLike} bridge 桥接实例(catalog 已在 runAction 里抓过)
 * @param {any} input 原始输入
 * @returns {any} 选中的 catalog 行
 */
function pickRow(bridge: BridgeLike, input: any): any {
  const rows = bridge.catalog.rows
  return rows.find((r) => r.key === input.modelKey)
    || rows.find((r) => r.handle === input.modelKey)
    || rows[0]
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
  // 此前写成 inst,导致 x-freebuff-instance-id 缺失 ->
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
