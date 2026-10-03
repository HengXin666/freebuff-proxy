/**
 * 副仓库（cli-bridge）RPC 客户端 —— **薄封装，零协议代码**。
 *
 * 设计原则：上游请求的协议实现**只有一份**，在 `cli-bridge/`（bun 执行）。
 * 主服务（Node）不复制那套逻辑，而是把请求**委托**给它执行，再把结果
 * 透传给下游。这就是用户要的「主侧请求到副侧，副侧直接透传自己逻辑，
 * 相当于一个 RPC」。
 *
 * 为什么不直接在 Node 里再实现一遍：
 *   - 两份实现必然漂移，且官方形态一旦变化要改两处；
 *   - cli-bridge 用 bun 执行，TLS 栈与官方客户端同源；
 *   - 2026-10-03 的 200 + 工具调用是在副仓库实测出来的，
 *     重复实现等于把已验证的逻辑丢掉重写。
 *
 * 见 docs/reverse/17-current-status-and-gaps.md。
 */

import { readFile } from 'node:fs/promises'
import { callBun } from '../../cli-bridge/bridge.mjs'

/**
 * 用主服务的 upstream 客户端构造副仓库需要的 cfg。
 *
 * 主服务的设备密钥是**落盘文件**（data/device-keys/<accountKey>.json），
 * 副仓库需要的是里面的 keyId / privateKey —— 这里读出来转成副仓库形态。
 *
 * @param {object} upstream 主服务 createUpstreamClient 的返回值
 * @param {object} config 主服务 config
 * @param {string} accountKey 凭据文件名（账号 key）
 * @returns {Promise<object|null>} null 表示拿不到凭据（调用方应回落 legacy）
 */

/**
 * 私钥格式归一：PEM / base64 / base64url → **base64url 裸 DER**（bun 侧要的）。
 *
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
function normalizePrivateKeyForBun(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let s = raw.trim()
  // PEM：剥掉头尾与所有换行
  if (s.includes('-----BEGIN')) {
    s = s
      .replace(/-----BEGIN [A-Z ]+-----/g, '')
      .replace(/-----END [A-Z ]+-----/g, '')
      .replace(/\s+/g, '')
  }
  // 已经是 base64url（含 - 或 _）→ 原样
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s
  // 标准 base64 → base64url
  if (/^[A-Za-z0-9+/=]+$/.test(s)) {
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return null
}

export async function buildRpcCfg(upstream, config = {}) {
  if (!upstream?.token) return null
  const cfg = {
    token: upstream.token,
    userId: upstream.accountId || null,
    // 官方 chat 8 头里没有 install-id，chat 那一跳不需要它
    installId: null,
    keyId: null,
    privateKey: null,
    timeZone: config?.upstream?.timeZone || 'Asia/Shanghai',
  }
  const p = upstream.deviceKeyPath
  if (p) {
    try {
      const dk = JSON.parse(await readFile(p, 'utf8'))
      /**
       * scope 的主机随实际 apiBase 走：本地镜像对照时也要拼对，
       * 否则取不到 keyId → 退化成不签名（与客户端不一致）。
       */
      const host = config?.upstream?.apiBase || 'https://www.codebuff.com'
      cfg.keyId =
        dk.registrations?.[`${host} user:${cfg.userId}`] ||
        dk.registrations?.[`https://www.codebuff.com user:${cfg.userId}`] ||
        null
      /**
       * ⚠️ 私钥格式契约：主服务落盘的是 **PEM**
       * （`privateKeyEncoding: { type:'pkcs8', format:'pem' }`），
       * 而 cli-bridge 的 `derFromB64u()` 要的是 **base64url 裸 DER**。
       * 直接透传会让 bun 侧 `atob()` 抛
       * "The string contains invalid characters." —— 整个 bun 请求失败，
       * 静默回落 Node（表现就是"通道没生效"）。
       *
       * 这里做一次格式归一（**适配，不是重写签名逻辑**）：
       * PEM → 剥头尾 → base64 → base64url。已经是 base64url 的原样透传。
       */
      cfg.privateKey = normalizePrivateKeyForBun(dk.privateKey)
    } catch {
      // 无设备密钥也能发（副仓库退化为不签名），不阻塞
    }
  }
  return cfg
}

/**
 * 委托副仓库执行 **startRun + chat**（不 admission）。
 *
 * 用于主服务已持有会话（instanceId）的场景：副仓库自己按 desktop 世代
 * startAgentRun，再用官方形态发 chat。主服务因此**不需要**知道 agent 世代、
 * 官方工具集、官方 system 的任何细节 —— 那些只在副仓库里有一份。
 *
 * @param {object} params 同 rpcChat，但不需要 runId
 * @returns {Promise<{ ok: boolean, status?: number, text?: string, runId?: string, model?: object, error?: string }>}
 */
export async function rpcReuse(params) {
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

  const out = await callBun(
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
 * 委托副仓库执行 chat 那一跳。
 *
 * 主服务已持有会话（instanceId）与 run（runId），这里**不重复 admission**，
 * 只委托最后一步，避免多买一次会话（一次 admit = 买断一小时）。
 *
 * @param {object} params
 * @param {object} params.cfg 副仓库需要的凭据配置 { token, userId, installId, keyId, privateKey, timeZone }
 * @param {string} params.instanceId 会话实例 id（主服务已有）
 * @param {string} params.runId agent run id（主服务已有）
 * @param {string} params.modelKey 目录 key（m-xxx）或 handle（fbm1.xxx）
 * @param {any[]} params.messages 消息（system 由副仓库用官方模板生成）
 * @param {any[]} [params.tools]
 * @param {'worker'|'manager'} [params.layer]
 * @param {string|null} [params.reasoningEffort]
 * @param {boolean} [params.stream]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{ ok: boolean, status?: number, text?: string, model?: object, error?: string }>}
 */
export async function rpcChat(params) {
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

  const out = await callBun(
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
 * 会话读取（**端口**）：GET /api/v1/freebuff/session。
 *
 * 为什么必须走这个端口而不是在主服务里自己拼头：
 * Node 的内置 fetch 会强制带上 `accept-language` 与 `sec-fetch-mode`
 * （后者是 forbidden header，设不掉），而客户端（bun）不带 ——
 * 在主服务里"补头/删头"永远补不到完全一致，只有让请求跑在 bun 上才行。
 * 官方形态的实现只有一份，在 `cli-bridge/`；本文件不复制它。
 *
 * 见 docs/reverse/21 §21.3（客户端真值）与 §21.5（对齐状态）。
 *
 * @param {{ cfg: object, timeoutMs?: number }} params
 * @returns {Promise<{ ok: boolean, status?: number, body?: any, error?: string } | null>}
 *   null = bun 不可用，调用方应回落到主服务自己的实现
 */
export async function rpcSession(params) {
  const { cfg, timeoutMs = 30_000 } = params
  try {
    const out = await callBun({ cfg, action: 'session' }, timeoutMs)
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

/** 副仓库是否可用（bun 存在且可执行）。 */
export async function rpcAvailable() {
  try {
    const { hasBun } = await import('../../cli-bridge/bridge.mjs')
    return hasBun()
  } catch {
    return false
  }
}
