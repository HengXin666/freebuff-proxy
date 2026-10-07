/**
 * 副仓库(cli-bridge)RPC 客户端  --  薄封装, 零协议代码.
 *
 * 上游请求的协议实现只有一份, 在 cli-bridge/(bun 执行). 主服务(Node)把请求委托
 * 给它执行, 再把结果透传给下游(相当于一个 RPC).
 *
 * 本文件只保留 buildRpcCfg ---- 用主服务凭据装配副仓库需要的 cfg; 它与"本机密钥
 * 文件在哪"强耦合. 六个纯转发端口见 rpc/ports.ts.
 *
 * 见 .agents/notes/implemented/architecture/2026-10-03-official-channel-rpc-delegation.md
 * 与 docs/reverse/17-current-status-and-gaps.md
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { logger } from '../../util/log.ts'
import { createDeviceKeyRecord } from '../device/device-signing.ts'

export {
  rpcAvailable,
  rpcChat,
  rpcRegisterDeviceKey,
  rpcReleaseSession,
  rpcReuse,
  rpcSession,
} from './ports.ts'

/**
 * RPC cfg 的初始字段(含出网出口).
 *
 * 出口必须随 cfg 下传: 漏掉时 session/catalog 走代理, 而官方 chat 在 bun 里
 * 裸 fetch ---- 同进程两个出口, 上游看到的是后者(issue #5 的形态).
 * 见 .agents/notes/implemented/architecture/2026-10-07-unified-upstream-egress.md
 *
 * @param {any} upstream 主服务 createUpstreamClient 的返回值
 * @param {any} config 主服务 config
 * @returns {any} cfg 初始字段
 */
function baseRpcCfg(upstream: any, config: any): any {
  return {
    token: upstream.token,
    userId: upstream.accountId || null,
    // 官方 chat 8 头里没有 install-id,chat 那一跳不需要它
    installId: null,
    keyId: null,
    privateKey: null,
    timeZone: config?.upstream?.timeZone || 'Asia/Shanghai',
    proxy: upstream?.egress?.bunProxy ?? null,
  }
}

/**
 * 用主服务的 upstream 客户端构造副仓库需要的 cfg.
 *
 * 主服务的设备密钥是落盘文件(data/device-keys/<accountKey>.json),
 * 副仓库需要的是里面的 keyId / privateKey ---- 这里读出来转成副仓库形态.
 *
 * @param {object} upstream 主服务 createUpstreamClient 的返回值
 * @param {object} config 主服务 config
 * @returns {Promise<object|null>} null 表示拿不到凭据(调用方应回落 legacy)
 */
export async function buildRpcCfg(upstream: any, config: any = {}) {
  if (!upstream?.token) return null
  const cfg: any = baseRpcCfg(upstream, config)
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
     * 密钥文件不存在时就地生成(纯本地 IO,不发任何请求).
     *
     *  Docker 上这是必经之路:/data 是全新卷,密钥文件从来没有过.
     * 而生成它的 DeviceSigner.ensureKey() 只在 Node 路径被调用
     * (apiFetch → headersFor);session 走 bun 通道时压根不经过它 →
     * 文件永远不会被创建 → bun 侧既没有密钥也没有 keyId → 死锁.
     * 这里在装配 cfg 时就保证原料存在,把死锁从根上解开.
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
       * scope 的主机随实际 apiBase 走:本地镜像对照时也要拼对, 取不到 keyId
       * 就会退化成不签名(与客户端不一致).
       */
      cfg.keyId =
        dk.registrations?.[`${host} user:${cfg.userId}`] ||
        dk.registrations?.[`https://www.codebuff.com user:${cfg.userId}`] ||
        null
      /**
       * 私钥格式契约:主服务落盘的是 PEM
       * (privateKeyEncoding: { type:'pkcs8', format:'pem' }),
       * 而 cli-bridge 的 derFromB64u() 要的是 base64url 裸 DER; 直接透传会让
       * bun 侧 atob() 抛错, 整个 bun 请求失败并静默回落 Node.
       *
       * 这里做一次格式归一: PEM → 剥头尾 → base64 → base64url; 已经是
       * base64url 的原样透传. 见 .agents/notes/implemented/bug-fix/2026-10-03-session-via-bun-port.md
       */
      cfg.privateKey = normalizePrivateKeyForBun(dk.privateKey)
      /**
       * 公钥是 bun 侧惰性注册的原料.
       *
       * Docker 全新卷上 registrations 为空(有密钥,没注册过), bun 侧见此会用这个
       * 公钥自己注册一个 keyId; 没有签名时 session GET 将不带签名, 而它是抓包里
       * 唯一必签的端点.
       */
      cfg.publicKey =
        typeof dk.publicKey === 'string' && dk.publicKey ? dk.publicKey : null
    }
  }
  /**
   * 兜底必须在读主密钥的 try 之外: 主密钥文件不存在时 readFile 抛错, 若与主路径
   * 共用同一个 catch, 兜底块会被跳过, keyId 依旧是 null.
   *
   * 同一条纪律适用于兜底路径: 兜底自己失败时也要看得见.
   * 见 docs/reverse/21 §21.5[通道接上 ≠ 通道生效,失败会静默回落].
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
 * 私钥格式归一:PEM / base64 / base64url → base64url 裸 DER(bun 侧要的).
 *
 * @param {string | null | undefined} raw 原始私钥
 * @returns {string | null} base64url 裸 DER;无法归一返回 null
 */
function normalizePrivateKeyForBun(raw: any) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let s = raw.trim()
  // PEM:剥掉头尾与所有换行
  if (s.includes('-----BEGIN')) {
    s = s
      .replace(/-----BEGIN [A-Z ]+-----/g, '')
      .replace(/-----END [A-Z ]+-----/g, '')
      .replace(/\s+/g, '')
  }
  // 已经是 base64url(含 - 或 _)→ 原样
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s
  // 标准 base64 → base64url
  if (/^[A-Za-z0-9+/=]+$/.test(s)) {
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return null
}

/**
 * 读官方桌面客户端已注册的设备密钥(只读,best-effort).
 *
 * 官方客户端自己把注册结果落在 ~/.config/freebuff-desktop/
 * state.json.device-key.json,且 scope 就是
 * <host> user:<userId> ---- 与本项目约定的 scope 格式完全一致,
 * 因此可以逐字复用,不需要再发一次 device-keys 注册请求.
 *
 * @param {string} host 上游 API 主机(随 config 走,支持本地镜像对照)
 * @param {string | null} userId 账号用户 id
 * @returns {Promise<{ keyId: string, privateKey: string } | null>} 拿不到返回 null
 */
async function readOfficialDeviceKey(host: any, userId: any) {
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
    // 官方客户端未安装 / 文件不可读:不是错误路径,照旧不签名
    return null
  }
}
