/**
 * 数据落盘路径: 凭据同目录的 sessions.json / account-state.json.
 *
 * 从 app-context.js 按职责切出. 必须和凭据目录放一起: 同一个 dataDir 可能被
 * 两个服务共用(本仓库的 data/ 与上层 rotator 的 ../data/), 句柄索引跟着凭据走
 * 才不会各自持有一份互相看不见的孤儿; 也保证"删容器不丢数据"的 /data 约定.
 *
 * 三个都导出: app-context 的构造函数要用它们建句柄库与账本. 历史教训是把它们
 * 留成模块私有的副本, 于是同一份路径判据在仓库里存在两份, 改一处漏一处.
 */
import path from 'node:path'
import { resolveCredentialsDir } from '../../auth-store.ts'

/**
 * 会话句柄索引(sessions.json)落盘位置.
 *
 * 必须和凭据目录放一起:同一个 dataDir 可能被两个服务共用(本仓库的
 * data/ 与上层 rotator 的 ../data/),句柄索引跟着凭据走才不会各自
 * 持有一份互相看不见的孤儿;也保证"删容器不丢数据"的 /data 约定成立.
 * @param {import('../../config.ts').ProxyConfig} config 已加载配置
 * @returns {string} sessions.json 的绝对路径
 */
export function resolveSessionIndexPath(config: any): string {
  return path.join(accountStateDir(config), 'sessions.json')
}

/**
 * 账号状态账本(account-state.json)落盘位置----与 sessions.json / 凭据同目录,
 * 同样是"删容器不丢数据"的 /data 约定.
 * @param {import('../../config.ts').ProxyConfig} config 已加载配置
 * @returns {string} account-state.json 的绝对路径
 */
export function resolveAccountStatePath(config: any): string {
  return path.join(accountStateDir(config), 'account-state.json')
}

/**
 * 凭据目录的父目录(= /data);凭据目录本身不叫 credentials 时就用它自己.
 * @param {import('../../config.ts').ProxyConfig} config 已加载配置
 * @returns {string} 数据目录
 */
export function accountStateDir(config: any): string {
  const credDir = resolveCredentialsDir(config)
  const parent = path.dirname(credDir)
  return path.basename(credDir) === 'credentials' ? parent : credDir
}
