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

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { callBun } from '../../cli-bridge/bridge.mjs'
import { createDeviceKeyRecord } from './device-signing.js'

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
  const host = config?.upstream?.apiBase || 'https://www.codebuff.com'
  if (p) {
    let dk = null
    try {
      dk = JSON.parse(await readFile(p, 'utf8'))
    } catch {
      dk = null
    }
    /**
     * 密钥文件不存在时**就地生成**（纯本地 IO，不发任何请求）。
     *
     * ⚠️ Docker 上这是必经之路：/data 是全新卷，密钥文件从来没有过。
     * 而生成它的 `DeviceSigner.ensureKey()` 只在 **Node 路径**被调用
     * （apiFetch → headersFor）；session 走 bun 通道时压根不经过它 →
     * 文件永远不会被创建 → bun 侧既没有密钥也没有 keyId → 死锁。
     * 这里在装配 cfg 时就保证原料存在，把死锁从根上解开。
     */
    if (!dk || typeof dk !== 'object' || !dk.privateKey || !dk.publicKey) {
      dk = createDeviceKeyRecord()
      try {
        await mkdir(dirname(p), { recursive: true })
        await writeFile(p, JSON.stringify(dk, null, 2), { mode: 0o600 })
        logger.info('device key generated for account', { path: p })
      } catch {
        // 落盘失败不阻塞：本次仍发请求（无签名），下次重试
      }
    }
    if (dk) {
      /**
       * scope 的主机随实际 apiBase 走：本地镜像对照时也要拼对，
       * 否则取不到 keyId → 退化成不签名（与客户端不一致）。
       */
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
      /**
       * 公钥是 bun 侧**惰性注册**的原料。
       *
       * Docker 全新卷上 `registrations` 为空（有密钥、没注册过），
       * bun 侧见此会用这个公钥自己注册一个 keyId —— 否则 session GET
       * 将不带签名，而它是抓包里唯一必签的端点。
       */
      cfg.publicKey =
        typeof dk.publicKey === 'string' && dk.publicKey ? dk.publicKey : null
    }
  }
  /**
   * ⚠️ 兜底**必须在 try 之外**。
   *
   * 第一版把它写在读主密钥的那个 `try` 里 —— 主密钥文件不存在时
   * （本仓库当前的真实状态：`data/device-keys/` 只有调试残留，
   * 唯独没有账号自己的文件）`readFile` 直接抛，
   * 于是**整个兜底块被 catch 跳过**，keyId 依旧是 null。
   * 实测确认：兜底跑完 keyId 仍为 null，等于没写。
   *
   * 这正是 docs/reverse/21 §21.5 那条教训的复现：
   * 「通道接上 ≠ 通道生效，失败会静默回落」。
   * 适用于兜底路径的同一条纪律：**兜底自己失败时也要看得见**，
   * 绝不能和"主路径失败"共用同一个 catch。
   */
  if (!cfg.keyId) {
    const official = await readOfficialDeviceKey(host, cfg.userId)
    if (official) {
      cfg.keyId = official.keyId
      cfg.privateKey = normalizePrivateKeyForBun(official.privateKey)
    }
  }
  return cfg
}

/**
 * 读官方桌面客户端**已注册**的设备密钥（只读，best-effort）。
 *
 * 官方客户端自己把注册结果落在 `~/.config/freebuff-desktop/
 * state.json.device-key.json`，且 scope 就是
 * `<host> user:<userId>` —— 与本项目约定的 scope 格式完全一致，
 * 因此可以逐字复用，**不需要再发一次 device-keys 注册请求**。
 *
 * @param {string} host 上游 API 主机（随 config 走，支持本地镜像对照）
 * @param {string | null} userId 账号用户 id
 * @returns {Promise<{ keyId: string, privateKey: string } | null>}
 */
async function readOfficialDeviceKey(host, userId) {
  if (!userId) return null
  try {
    const p = join(
      homedir(),
      '.config/freebuff-desktop/state.json.device-key.json',
    )
    const dk = JSON.parse(await readFile(p, 'utf8'))
    const keyId =
      dk.registrations?.[`${host} user:${userId}`] ||
      dk.registrations?.[`https://www.codebuff.com user:${userId}`] ||
      null
    if (!keyId || typeof dk.privateKey !== 'string' || !dk.privateKey) return null
    return { keyId, privateKey: dk.privateKey }
  } catch {
    // 官方客户端未安装 / 文件不可读：不是错误路径，照旧不签名
    return null
  }
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

/**
 * 注册设备公钥（**端口**）：POST /api/v1/freebuff/device-keys → 拿 keyId。
 *
 * 与 rpcSession 同理：不构造头，交给 bun 侧官方形态实现。
 * 这一跳是**签名前置** —— 拿不到 keyId 则 session/admission/chat 都无法签名。
 *
 * @param {{ cfg: object, publicKey: string, timeoutMs?: number }} params
 * @returns {Promise<{ ok: boolean, status?: number, keyId?: string | null, body?: any, error?: string } | null>}
 */
export async function rpcRegisterDeviceKey(params) {
  const { cfg, publicKey, timeoutMs = 15_000 } = params
  try {
    const out = await callBun({ cfg, action: 'deviceKeys', publicKey }, timeoutMs)
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
 * 释放会话（**端口**）：DELETE /api/v1/freebuff/session。
 *
 * ⚠️ 必须带 `x-freebuff-instance-id`，否则上游 400 `instance_required`，
 * 槽位退不掉 → 账号一直被占（会拿到 purchase_claim_released / purchase_in_use）。
 * 头与签名一律交给 bun 侧官方形态实现。
 *
 * @param {{ cfg: object, instanceId: string, timeoutMs?: number }} params
 * @returns {Promise<{ ok: boolean, status?: number, text?: string, error?: string } | null>}
 */
export async function rpcReleaseSession(params) {
  const { cfg, instanceId, timeoutMs = 20_000 } = params
  try {
    const out = await callBun({ cfg, action: 'release', instanceId }, timeoutMs)
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

/** 副仓库是否可用（bun 存在且可执行）。 */
export async function rpcAvailable() {
  try {
    const { hasBun } = await import('../../cli-bridge/bridge.mjs')
    return hasBun()
  } catch {
    return false
  }
}
