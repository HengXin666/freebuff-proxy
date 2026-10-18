/**
 * 官方客户端登录态的读取(只读 best-effort).
 *
 * install-id 是桌面端身份组的一项:桌面客户端把它写在自己的 state.json 里,会话请求
 * 按"有则带"发.Node 的会话装配与 bun 的会话请求都从这里取同一个值,同一场会话不会
 * 出现两个身份.见
 * .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md.
 *
 * 从 src/upstream/client/bun-channel.ts 拆出(那个文件另有 300 行上限).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 读官方客户端登录态里的 installId(只读 best-effort).
 *
 * @returns {string | null} installId;读不到返回 null
 */
export function installIdFromClientState(): string | null {
  try {
    const p = join(homedir(), '.config/freebuff-desktop/state.json')
    const st = JSON.parse(readFileSync(p, 'utf8'))
    return typeof st?.installId === 'string' ? st.installId : null
  } catch {
    return null
  }
}

/**
 * 解析桌面端安装身份(会话请求共用一份): 环境变量优先, 回落官方客户端登录态.
 *
 * 环境变量优先: 容器部署没有官方客户端目录, 由部署侧用 FREEBUFF_INSTALL_ID 注入;
 * 本机跑官方客户端时直接复用 state.json 里的同一个值 -- Node 的会话装配与 bun 的
 * 会话请求都走这里, 同一场会话不会出现两个身份. 读不到返回 null, 调用方整头省略.
 *
 * @returns {string | null} installId;两处都读不到返回 null
 */
export function resolveInstallId(): string | null {
  const fromEnv = (process.env.FREEBUFF_INSTALL_ID || '').trim()
  return fromEnv || installIdFromClientState()
}
