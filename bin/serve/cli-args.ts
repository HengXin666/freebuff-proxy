/**
 * CLI 参数解析与端口等待 -- 从 bin/serve.ts 按职责切出.
 *
 *
 * 口径: 纯搬移, 不改行为. 每个函数的 JSDoc 原样保留.
 *
 * 注意: 本文件是 .ts, 会被 npm run typecheck 真正检查(不像 .js 只解析不检查),
 * 所以 JSDoc 必须是 TS 认得的格式(* 开头), 且类型要显式.
 */
import net from 'node:net'

/**
 * @param {string[]} argv 命令行参数
 * @returns {string | undefined} --config 或 -c 后面的路径
  - @param {any} argv 参数
*/
export function parseConfigPath(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') return argv[i + 1]
  }
  return undefined
}

/**
 * 自重启子进程的端口等待:旧进程退出需要一点时间,轮询直到端口可绑定,
 * 避免子进程启动时撞上 EADDRINUSE(裸机/非 Docker 场景).
 *
 * @param {string} host 监听地址
 * @param {number} port 监听端口
 * @param {number} timeoutMs 最长等待毫秒
 * @returns {Promise<void>} 端口释放或超时后 resolve
  - @param {any} host 参数
 - @param {any} port 参数
 - @param {any} timeoutMs 参数
*/
export function waitForPortFree(host: string, port: number, timeoutMs: number): Promise<void> {
  const target = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const deadline = Date.now() + timeoutMs
  return new Promise<void>((resolve) => {
    const tryOnce = (): void => {
      const socket = net.connect({ host: target, port })
      const done = (): void => {
        socket.destroy()
        if (Date.now() < deadline) setTimeout(tryOnce, 250)
        else resolve()
      }
      socket.once('connect', done)
      socket.once('error', () => resolve()) // 端口已释放, 可以接管
    }
    tryOnce()
  })
}
