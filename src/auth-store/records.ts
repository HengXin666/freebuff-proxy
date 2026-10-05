/**
 * 账号记录的形状归一 + 上游鉴权头 + 本机指纹.
 *
 * 从 src/auth-store.ts 拆出(原 392 行单文件).
 */
import os from 'node:os'
import { createHash } from 'node:crypto'

/**
 * 账号记录(运行时形态).
 */
export interface FreebuffUser {
  id?: string
  email: string
  name?: string
  authToken: string
  fingerprintId?: string
  fingerprintHash?: string
  proxy?: string | null
}

/**
 * Runtime format is bare user object.
 * Migrate-only: also accept legacy { default: user }.
 *
 * @param {any} raw 磁盘上的原始对象
 * @returns {FreebuffUser | null} 归一后的账号;不合法返回 null
 */
export function coerceUser(raw: any): FreebuffUser | null {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.authToken !== 'string' || !raw.authToken) return null
  if (typeof raw.email !== 'string' || !raw.email.includes('@')) return null
  return {
    id: raw.id,
    email: String(raw.email).trim().toLowerCase(),
    name: raw.name,
    authToken: raw.authToken,
    fingerprintId: raw.fingerprintId,
    fingerprintHash: raw.fingerprintHash,
    /** 可选:该账号专属出网代理,如 http://user:pass@127.0.0.1:7890 */
    proxy: typeof raw.proxy === 'string' && raw.proxy.trim() ? raw.proxy.trim() : null,
  }
}

/**
 * 上游鉴权头 -- 只发 Bearer(x-codebuff-api-key 不作为官方形态的一部分).
 * 调用点统一走本函数, 不必各自拼头.
 *
 * @param {string} token 上游 token
 * @returns {{ Authorization: string }} 鉴权头
 */
export function freebuffAuthHeaders(token: string): { Authorization: string } {
  return {
    Authorization: `Bearer ${token}`,
  }
}

/**
 * 生成与本机绑定的指纹 id(登录时提交给上游).
 *
 * @returns {string} enhanced-<sha256 base64url>
 */
export function generateFingerprintId(): string {
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || '',
    String(os.cpus().length),
    os.userInfo().username,
  ]
  const macs: string[] = []
  const nets = os.networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00') {
        macs.push(n.mac)
      }
    }
  }
  parts.push(...macs.sort())
  const hash = createHash('sha256').update(parts.join('|')).digest('base64url')
  return `enhanced-${hash}`
}
