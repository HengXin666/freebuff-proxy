/**
 * inventory 域组:账号 / 模型 / 代理 ---- 控制台里"被管理对象"的读写面.
 *
 * 与 control 域组的分界:control 管的是"这台服务自己的账号,设置,日志,
 * 生命周期",inventory 管的是"上游资源在这个代理里的映射".
 */
import { handle as handleAccounts } from './accounts/index.ts'
import { handle as handleModels } from './models/index.ts'
import { handle as handleProxy } from './proxy.ts'

/** 域处理器签名(dispatcher 只需要知道这一个形状). */
/**
 * @typedef {(method: string, route: string, req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse, user: any, ctx: any) => Promise<boolean>} DomainHandler
 */

/** 本组域:顺序即匹配顺序. */
/** @type {Record<string, DomainHandler>} */
export const DOMAINS = {
  accounts: handleAccounts,
  models: handleModels,
  proxy: handleProxy,
}
