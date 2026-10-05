/**
 * 数据落盘路径: 凭据同目录的 sessions.json / account-state.json.
 *
 * 与凭据目录同目录: 同一个 dataDir 可能被两个服务共用(本仓库的 data/ 与上层
 * rotator 的 ../data/), 句柄索引跟着凭据走才不会各自持有一份互相看不见的孤儿;
 * 也满足"删容器不丢数据"的 /data 约定.
 *
 * 三个都导出: app-context 的构造函数要用它们建句柄库与账本, 避免出现第二份
 * 路径判据.
 */
import path from 'node:path'
import { resolveCredentialsDir } from '../../auth-store.ts'

/**
 * 会话句柄索引(sessions.json)落盘位置.
 *
 * 与凭据目录同目录: 同一个 dataDir 可能被两个服务共用(本仓库的
 * data/ 与上层 rotator 的 ../data/), 句柄索引跟着凭据走才不会各自
 * 持有一份互相看不见的孤儿; 也满足"删容器不丢数据"的 /data 约定.
 * @param {import('../../config.ts').ProxyConfig} config 已加载配置
 * @returns {string} sessions.json 的绝对路径
 */
export function resolveSessionIndexPath(config: any): string {
  return path.join(accountStateDir(config), 'sessions.json')
}

/**
 * 账号状态账本(account-state.json)落盘位置----与 sessions.json / 凭据同目录,
 * 同样满足"删容器不丢数据"的 /data 约定.
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
