/**
 * control 域组:身份 / 用户 / 设置 / 日志与数据 / 生命周期.
 *
 * 这些端点操作的是"这台代理服务自己"(谁能进来,怎么跑,现场怎么看),
 * 与"上游资源映射"(inventory 域组)分开.
 */
import { handlePublic as authPublic, handle as handleAuth } from './identity/auth.ts'
import { handle as handleUsers } from './identity/users.ts'
import { handle as handleSettings } from './settings.ts'
import { handle as handleAudit } from './audit.ts'
import { handle as handleLifecycle } from './lifecycle.ts'

/** 域处理器签名(dispatcher 只需要知道这一个形状). */
/**
 * @typedef {(method: string, route: string, req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse, user: any, ctx: any) => Promise<boolean>} DomainHandler
 */

/**
 * 需登录的域:顺序即匹配顺序.
 * @type {Record<string, DomainHandler>}
 */
export const DOMAINS = {
  users: handleUsers,
  settings: handleSettings,
  audit: handleAudit,
  lifecycle: handleLifecycle,
  auth: handleAuth,
}

export { authPublic }
