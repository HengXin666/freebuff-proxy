/**
 * 副仓库(cli-bridge)RPC 端口  --  主服务侧不复制任何协议代码, 只委托.
 *
 * 六个端口把请求委托给副仓库执行, 再把回执透传给下游. 极薄的转发, 变更节奏只跟
 * 副仓库的 action 名走. 凭据装配(buildRpcCfg)在 official-rpc.ts.
 *
 * 上游请求的协议实现只有一份, 在 cli-bridge/(bun 执行); 主服务(Node)只委托.
 *
 * 见 docs/reverse/17-current-status-and-gaps.md.
 */
import { callBun, callBunStream } from '../../../cli-bridge/bridge.ts'

/**
 * 委托副仓库执行 startRun + chat(不 admission).
 *
 * 用于主服务已持有会话(instanceId)的场景:副仓库自己按 desktop 世代
 * startAgentRun,再用官方形态发 chat.主服务因此不需要知道 agent 世代,
 * 官方工具集,官方 system 的任何细节 ---- 那些只在副仓库里有一份.
 *
 * 两种模式:
 *   - 默认(整份): 等 bun 收完整条上游流, 返回 text. 供离线对比/非流式调用方.
 *   - 流式(onLine / onChunk): 上游字节按行边收边交, 主服务可立刻下发 ---- 这是
 *     "整段缓冲"的根治点(旧实现恒走整份, 长回复必然撞穿 45s 调度预算).
 *
 * @param {object} params 同 rpcChat,但不需要 runId;流式另加 onLine / onError
 * @returns {Promise<any>} 结果(ok / status / text / runId / model / error / streamed)
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
    /** 官方工具注入名单(undefined = 未配置 = 全注入). 见 signals/official-tool-select.ts. */
    officialToolNames = undefined,
    /** 每收一行调用一次(不含行尾换行符). 给了它就切到流式通道. */
    onLine = null,
    onError = null,
    /** 上游状态行到达时调用一次(下游可在提交响应头之前拿到真实状态码). */
    onStatus = null,
  } = params

  const payload: any = {
    cfg,
    action: 'reuse',
    modelKey,
    instanceId,
    messages,
    tools,
    layer,
    reasoningEffort,
    stream,
  }
  // 官方工具注入名单是可选字段: 不传时 bun 侧按[未配置 = 全注入]处理,
  // 所以只在真的配置过时才塞进 payload(少一个字段就少一处形态差异).
  if (params.officialToolNames !== undefined) {
    payload.officialToolNames = params.officialToolNames
  }

  if (typeof onLine === 'function') {
    return await rpcReuseStreaming({ ...payload, streamStdout: true }, { timeoutMs, onLine, onError, onStatus })
  }

  const out: any = await callBun(payload, timeoutMs)

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
 * rpcReuse 的流式分支: 上游字节按行边收边交.
 *
 * 与整份分支的差别只有"不把 stdout 攒成一整块": onLine 每拿到一行就交出去,
 * 主服务因此能在上游首字节到达时就下发, 而不是等整篇回复生成完.
 *
 * @param {object} payload 已带 streamStdout 的 bun 入参
 * @param {{ timeoutMs: number, onLine: (line: string) => void, onError: any, onStatus: any }} opts 回调
 * @returns {Promise<object>} 与整份分支同形的结果对象(含 streamed 标记)
 */
function rpcReuseStreaming(payload: any, opts: any): Promise<any> {
  const { timeoutMs, onLine, onError, onStatus } = opts
  return new Promise((resolve) => {
    let status: number | null = null
    let model: any = null
    let runId: string | null = null

    callBunStream(payload, {
      timeoutMs,
      onLine: (line: string) => {
        // 状态行是控制信息(不属于响应正文): 解析出来给调用方, 不交给下游.
        if (line.startsWith('@')) {
          try {
            status = JSON.parse(line.slice(1))?.status ?? null
          } catch { /* 忽略畸形状态行 */ }
          if (status != null && typeof onStatus === 'function') onStatus(status)
          return
        }
        onLine(line)
      },
      onSummary: (out: any) => {
        resolve({
          ok: (out?.chat?.status ?? status) === 200,
          status: out?.chat?.status ?? status,
          runId: out?.startRun?.runId || null,
          model: out?.model ?? null,
          error: out?.error ?? null,
          text: '',
          streamed: true,
        })
      },
      onError: (err: Error) => {
        if (typeof onError === 'function') onError(err)
        resolve({ ok: false, status, runId, model, error: err.message, text: '', streamed: true })
      },
    })
  })
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
 * 走这个端口而非在主服务里自己拼头: Node 的内置 fetch 会强制带上
 * accept-language 与 sec-fetch-mode(后者是 forbidden header, 设不掉), 而客户端
 * (bun)不带 ---- 在主服务里"补头/删头"补不到完全一致, 只有让请求跑在 bun 上.
 * 官方形态的实现只有一份, 在 cli-bridge/.
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
 * 带 x-freebuff-instance-id: 缺该头时上游回 400 instance_required,
 * 槽位退不掉(账号会一直被占, 拿到 purchase_claim_released / purchase_in_use).
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
