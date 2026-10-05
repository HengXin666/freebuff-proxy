/**
 * 数据目录固件 -- 从 scripts/ci/pipeline-image-test.ts 按职责切出.
 *
 *
 * 口径: 纯搬移, 不改行为.
 */
import fs from 'node:fs'
import path from 'node:path'
import { makeTempDir } from './io.ts'
import { ROOT } from './paths.ts'

/**
 * 就地合成一份结构合法的最小数据集.
 * @returns {string} 合成的数据源目录
 */
export function synthesizeDataSource() {
  const dir = makeTempDir('fbp-src-')
  /** @type {Record<string, any>} */
  const seed = {
    'users.json': { version: 1, users: [] },
    'web-sessions.json': { version: 1, sessions: [] },
    'settings.json': { version: 1 },
    'proxies.json': { version: 1, proxies: [] },
    'custom-models.json': { version: 1, models: [], hidden: [] },
    'account-state.json': { version: 1, accounts: {} },
    'sessions.json': { version: 1, sessions: [], orphans: [] },
    'login-flows.json': { version: 1, flows: [] },
  }
  for (const [name, body] of Object.entries(seed)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body, null, 2))
  }
  return dir
}

/**
 * 仓库当前 data/ 里的 JSON(排除凭据与派生缓存).
 * @param {string} dir 数据目录
 * @returns {string[]} JSON 文件名(已排序)
 */
export function listDataSourceFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !f.includes('.corrupt-'))
    .sort()
}

/**
 * 造一个挂载用的数据目录.
 * @param {string} name 场景名(进临时目录名)
 * @param {{corrupt?: string|null, dirty?: {file: string, content: string}|null,
 *   credentials?: boolean, sourceDir?: string}} [opts] 固件选项
 * @param {string} dataSource 基准数据源目录
 * @returns {{dir: string, dataDir: string, files: string[]}} 固件目录信息
 */
export function makeFixture(name, opts = {}, dataSource) {
  const dir = makeTempDir(`fbp-pipeline-${name}-`)
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const src = opts.sourceDir || dataSource
  const files = listDataSourceFiles(src)
  for (const f of files) {
    fs.copyFileSync(path.join(src, f), path.join(dataDir, f))
  }
  // 凭据单独控制:默认不带,保证流水线完全离线,不消耗任何上游额度.
  const credSrc = path.join(src, 'credentials')
  if (opts.credentials && fs.existsSync(credSrc)) {
    const dst = path.join(dataDir, 'credentials')
    fs.mkdirSync(dst, { recursive: true })
    for (const f of fs.readdirSync(credSrc)) {
      fs.copyFileSync(path.join(credSrc, f), path.join(dst, f))
    }
  } else {
    fs.mkdirSync(path.join(dataDir, 'credentials'), { recursive: true })
  }
  // 指向宿主机的本地 config(端口/数据目录都由 env 覆盖,配置本身不影响断言)
  const example = path.join(ROOT, 'config.example.yaml')
  if (fs.existsSync(example)) fs.copyFileSync(example, path.join(dataDir, 'config.yaml'))
  if (opts.corrupt) {
    // 写坏:截断到一半并追加非法字符 -- 最接近"写盘被中断/版本不兼容"的真实形态
    const target = path.join(dataDir, opts.corrupt)
    fs.writeFileSync(target, '{"broken": tru')
  }
  if (opts.dirty) {
    // 脏条目:合法 JSON,非法条目 -- 这是"更新镜像后起不来"的真实形态,
    // 截断式损坏反而永远测不到(语法错误走的是另一条分支).
    fs.writeFileSync(path.join(dataDir, opts.dirty.file), opts.dirty.content)
  }
  return { dir, dataDir, files }
}

/**
 * 删除 fixture 目录.
 *
 * 不能直接 rmSync:容器以 root 启动,entrypoint 会把 /data chown 给 node(1000).
 * 本地开发机 uid 恰好是 1000(chown 等价于没变),但 CI runner 不是 -- 宿主侧删除
 * 所以优先借一个 root 容器删(用刚构建的镜像,不额外拉取),失败再退回本地删除.
 * 任何情况下都不得抛:清理失败只是留个临时目录,不该判流水线失败.
 * @param {string} dir fixture 目录
 * @param {string} image 已构建的镜像名
 * @param {(cmd: string, args: string[], opts?: object) => {status: number|null,
 *   stdout?: string, stderr?: string}} run 子进程执行器
 * @param {(s: string) => string} dim 灰色格式化
 * @returns {void} 无返回值
 */
export function removeFixture(dir, image, run, dim) {
  try {
    const r = run('docker', [
      'run', '--rm', '--entrypoint', 'rm',
      '-v', `${dir}:/x`,
      image, '-rf', '/x',
    ])
    if (r.status === 0) return
  } catch {
    // 落到下面的本地删除
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.warn(dim(`fixture 清理失败（不影响结论）: ${dir} — ${err?.code || err}`))
  }
}
