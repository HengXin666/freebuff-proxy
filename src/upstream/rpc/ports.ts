/**
 * 副仓库(cli-bridge)RPC 端口  --  主服务侧不复制任何协议代码, 只委托.
 *
 * 为什么单独成文件: 原 official-rpc.ts 397 行超 300 红线. 它里有两类东西:
 * 一个是装配用的 buildRpcCfg(读本机密钥文件, 把凭据归一成副仓库形态),
 * 一个是这六个"端口"(把请求委托给副仓库执行, 再把回执透传给下游). 后者全是
 * 极薄的转发, 变更节奏只跟副仓库的 action 名走, 与凭据装配无关.
 *
 * 设计原则不变: 上游请求的协议实现只有一份, 在 cli-bridge/(bun 执行).
 * 主服务(Node)不复制那套逻辑, 而是把请求委托给它执行, 再把结果透传给下游.
 * 这就是用户要的[主侧请求到副侧, 副侧直接透传自己逻辑, 相当于一个 RPC].
 *
 * 见 docs/reverse/17-current-status-and-gaps.md.
 */
import { callBun } from '../../../cli-bridge/bridge.ts'

/**
 * 委托副仓库执行 startRun + chat(不 admission).
 *
 * 用于主服务已持有会话(instanceId)的场景:副仓库自己按 desktop 世代
 * startAgentRun,再用官方形态发 chat.主服务因此不需要知道 agent 世代,
 * 官方工具集,官方 system 的任何细节 ---- 那些只在副仓库里有一份.
 *
 * @param {object} params 同 rpcChat,但不需要 runId
 * @returns {Promise<{ ok: boolean, status?: number, text?: string, runId?: string, model?: object, error?: string }>}
 */
export async function rpcReuse(params: any) {
  const {
    cfg,
    instanceId,
    modelKey,
    messages,
    tools,
    layer = 'worker',
    reasoningEffort = null,
    stream = true,
    timeoutMs = 180_000,
  } = params

  const out: any = await callBun(
    {
      cfg,
      action: 'reuse',
      modelKey,
      instanceId,
      messages,
      tools,
      layer,
      reasoningEffort,
      stream,
    },
    timeoutMs,
  )

  return {
    ok: out?.chat?.status === 200,
    status: out?.chat?.status,
    text: out?.chat?.text,
    runId: out?.startRun?.runId || null,
    model: out?.model,
    error: out?.error,
  }
}

/**
 * 委托副仓库执行 chat 那一跳.
 *
 * 主服务已持有会话(instanceId)与 run(runId),这里不重复 admission,
 * 只委托最后一步,避免多买一次会话(一次 admit = 买断一小时).
 *
 * params 字段: cfg(副仓库凭据 { token, userId, installId, keyId, privateKey,
 * timeZone }) / instanceId / runId / modelKey(目录 key 或 handle) / messages
 * (system 由副仓库用官方模板生成) / tools / layer(默认 worker) /
 * reasoningEffort / stream / timeoutMs.
 *
 * @param {object} params 见上
 * @returns {Promise<{ ok: boolean, status?: number, text?: string, model?: object, error?: string }>}
 */
export async function rpcChat(params: any) {
  const {
    cfg,
    instanceId,
    runId,
    modelKey,
    messages,
    tools,
    layer = 'worker',
    reasoningEffort = null,
    stream = true,
    timeoutMs = 180_000,
  } = params

  const out: any = await callBun(
    {
      cfg,
      action: 'chat',
      modelKey,
      instanceId,
      runId,
      messages,
      tools,
      layer,
      reasoningEffort,
      stream,
    },
    timeoutMs,
  )

  const result = out?.result || {}
  return {
    ok: result.status === 200,
    status: result.status,
    text: result.text,
    model: out.model,
    error: out.error,
  }
}

/**
 * 会话读取(端口):GET /api/v1/freebuff/session.
 *
 * 为什么必须走这个端口而不是在主服务里自己拼头:
 * Node 的内置 fetch 会强制带上 accept-language 与 sec-fetch-mode
 * (后者是 forbidden header,设不掉),而客户端(bun)不带 ----
 * 在主服务里"补头/删头"永远补不到完全一致,只有让请求跑在 bun 上才行.
 * 官方形态的实现只有一份,在 cli-bridge/;本文件不复制它.
 *
 * 见 docs/reverse/21 §21.3(客户端真值)与 §21.5(对齐状态).
 *
 * @param {{ cfg: object, timeoutMs?: number }} params
 * @returns {Promise<{ ok: boolean, status?: number, body?: any, error?: string } | null>}
 *   null = bun 不可用,调用方应回落到主服务自己的实现
 */
export async function rpcSession(params: any) {
  const {
    cfg,
    timeoutMs = 30_000,
    instanceId = null,
    heartbeat = false,
  } = params
  try {
    // instanceId / heartbeat 一起下发:bun 侧的 getSession(opts) 用它们构造
    // 官方的"持有心跳"形态(x-freebuff-instance-id + x-freebuff-heartbeat: 1).
    const out: any = await callBun(
      { cfg, action: 'session', instanceId, heartbeat },
      timeoutMs,
    )
    const result = out?.result || {}
    return {
      ok: result.status === 200,
      status: result.status,
      body: result.body ?? null,
      error: out?.error || null,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 注册设备公钥(端口):POST /api/v1/freebuff/device-keys → 拿 keyId.
 *
 * 与 rpcSession 同理:不构造头,交给 bun 侧官方形态实现.
 * 这一跳是签名前置 ---- 拿不到 keyId 则 session/admission/chat 都无法签名.
 *
 * @param {{ cfg: object, publicKey: string, timeoutMs?: number }} params
 * @returns {Promise<{ ok: boolean, status?: number, keyId?: string | null, body?: any, error?: string } | null>}
 */
export async function rpcRegisterDeviceKey(params: any) {
  const { cfg, publicKey, timeoutMs = 15_000 } = params
  try {
    const out: any = await callBun({ cfg, action: 'deviceKeys', publicKey }, timeoutMs)
    const result = out?.result || {}
    return {
      ok: result.status === 200 && Boolean(result.body?.keyId),
      status: result.status,
      keyId: result.body?.keyId || null,
      body: result.body ?? null,
      error: out?.error || null,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 释放会话(端口):DELETE /api/v1/freebuff/session.
 *
 *  必须带 x-freebuff-instance-id,否则上游 400 instance_required,
 * 槽位退不掉 → 账号一直被占(会拿到 purchase_claim_released / purchase_in_use).
 * 头与签名一律交给 bun 侧官方形态实现.
 *
 * @param {{ cfg: object, instanceId: string, timeoutMs?: number }} params
 * @returns {Promise<{ ok: boolean, status?: number, text?: string, error?: string } | null>}
 */
export async function rpcReleaseSession(params: any) {
  const { cfg, instanceId, timeoutMs = 20_000 } = params
  try {
    const out: any = await callBun({ cfg, action: 'release', instanceId }, timeoutMs)
    const result = out?.result || {}
    return {
      ok: result.status === 200,
      status: result.status,
      text: result.text ?? null,
      error: out?.error || null,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 副仓库是否可用(bun 存在且可执行).
 * @returns {Promise<boolean>} 可用为真
 */
export async function rpcAvailable() {
  try {
    const { hasBun } = await import('../../../cli-bridge/bridge.ts')
    return hasBun()
  } catch {
    return false
  }
}
