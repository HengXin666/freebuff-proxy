/**
 * 容器编排与小工具 -- 从 scripts/ci/pipeline-image-test.mjs 按职责切出.
 *
 * 口径: 纯搬移, 不改行为. 原有的坑注释原样保留.
 */
import { CONTAINER_PORT } from './paths.mjs'

/**
 * 起一个被测容器(独立端口 + 独立挂载卷).
 * @param {{name: string, image: string, dataDir: string, port: number}} opts 容器参数
 * @param {(cmd: string, args: string[], opts?: object) => {status: number|null,
 *   stdout?: string, stderr?: string}} run 子进程执行器
 * @returns {Promise<number>} 映射到宿主机的端口
 */
/**
 - 起一个被测容器(独立端口 + 独立挂载卷).
 - @param {{name: string, image: string, dataDir: string, port: number}} opts 容器参数
 - @param {(cmd: string, args: string[], o?: object) => {status: number|null, stdout?: string, stderr?: string}} run
 - 子进程执行器
 - @returns {Promise<number>} 映射到宿主机的端口
 */
export async function startContainer(opts, run) {
  const { name, image, dataDir, port } = opts
  run('docker', ['rm', '-f', name])
  const args = [
    'run', '-d',
    '--name', name,
    '-e', 'FREEBUFF_PROXY_DATA_DIR=/data',
    '-e', 'FREEBUFF_PROXY_CONFIG=/data/config.yaml',
    '-e', 'FREEBUFF_PROXY_HOST=0.0.0.0',
    '-e', `FREEBUFF_PROXY_PORT=${CONTAINER_PORT}`,
    '-e', 'ADMIN_PASSWORD=pipeline-admin-pw',
    // 容器内 127.0.0.1 是容器自己;这里没有凭据也就不需要代理
    '-p', `127.0.0.1:${port}:${CONTAINER_PORT}`,
    '-v', `${dataDir}:/data`,
    image,
  ]
  const res = run('docker', args)
  if (res.status !== 0) {
    throw new Error(`docker run 失败: ${(res.stderr || res.stdout || '').trim()}`)
  }
  return port
}

/**
 * 读容器状态.
 * @param {string} name 容器名
 * @param {(cmd: string, args: string[], opts?: object) => {status: number|null, stdout?: string}} run 子进程执行器
 * @returns {{status: string, exitCode: number|null, health: string}} 状态
 */
export function containerState(name, run) {
  const res = run('docker', [
    'inspect', name,
    '--format', '{{.State.Status}}|{{.State.ExitCode}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}',
  ])
  if (res.status !== 0) return { status: 'missing', exitCode: null, health: '' }
  const [status, exitCode, health] = String(res.stdout).trim().split('|')
  return { status, exitCode: Number(exitCode), health }
}

/**
 * 读容器日志(stdout + stderr).
 * @param {string} name 容器名
 * @param {(cmd: string, args: string[], opts?: object) => {status: number|null,
 *   stdout?: string, stderr?: string}} run 子进程执行器
 * @returns {string} 日志全文
 */
export function containerLogs(name, run) {
  const res = run('docker', ['logs', name])
  return `${res.stdout || ''}${res.stderr || ''}`
}

/**
 * 删除容器.
 * @param {string} name 容器名
 * @param {(cmd: string, args: string[], opts?: object) => {status: number|null}} run 子进程执行器
 * @returns {void} 无返回值
 */
export function stopContainer(name, run) {
  run('docker', ['rm', '-f', name])
}
