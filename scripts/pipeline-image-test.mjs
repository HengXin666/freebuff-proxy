#!/usr/bin/env node
/**
 * 镜像流水线：**真实构建 → 真实启动 → 真实探测**。
 *
 * 为什么要有它：镜像"能 build、能 push"不等于"能跑"。真实事故是——换了新镜像后
 * 用户环境里的容器起不来，删掉几个 /data/*.json 才恢复。本地 `docker build .`
 * 和 CI 的 smoke（mock 上游）都覆盖不到这条路径：它们要么没挂 /data，要么不真正
 * 启动容器。于是"镜像 + 旧数据目录"这个组合永远没人验过。
 *
 * 这个脚本把那条路径补上，且**完全离线**（固件里不放凭据，避免真连上游）：
 *
 *   1. build   构建镜像（--no-build 可跳过，直接测已有镜像）
 *   2. fixture 造数据目录：空目录 / 仓库当前 data/ 的副本 / 逐个把某个 JSON 写坏
 *   3. run     每个场景起一个容器（独立端口 + 独立挂载卷），等 /healthz
 *   4. assert  进程活着 + 健康检查通过 + 启动日志里的「数据文件自检」符合预期
 *              （损坏文件应当被点名；users.json 损坏应当**拒绝启动**并说明原因）
 *   5. report  逐场景 PASS/FAIL + 失败时打印容器日志尾部；有失败则退出码 1
 *
 * 用法：
 *   node scripts/pipeline-image-test.mjs                 # 构建 + 全场景
 *   node scripts/pipeline-image-test.mjs --no-build      # 只测已有镜像
 *   node scripts/pipeline-image-test.mjs --image ghcr.io/hengxin666/freebuff-proxy:latest
 *   node scripts/pipeline-image-test.mjs --keep          # 保留 fixture/容器便于排查
 *   node scripts/pipeline-image-test.mjs --with-credentials   # 带上真实凭据（会连上游，慎用）
 */

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL_IMAGE = 'freebuff-proxy-pipeline:local'
const CONTAINER_PORT = 8787
const BOOT_TIMEOUT_MS = 60_000

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const keep = has('--keep')
const skipBuild = has('--no-build')
const withCredentials = has('--with-credentials')
const image = valueOf('--image', LOCAL_IMAGE)
const dataSource = valueOf('--data', path.join(ROOT, 'data'))

/* ---------------- 小工具 ---------------- */
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })

const log = (...parts) => console.log(...parts)
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`

/** 找一个空闲端口（避免与宿主机上正在跑的服务撞车）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** GET 一个小接口，返回 {status, body}；连接失败返回 status 0。 */
function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }) })
    req.on('error', () => resolve({ status: 0, body: '' }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 数据目录固件 ---------------- */
/**
 * 兜底数据源：仓库/CI 里 `data/` 是 gitignore 的（本地运行数据，不入库），
 * 所以 CI 上拿不到真实 JSON。若因此跳过"损坏文件"场景，这道门禁就形同虚设
 * （真实故障恰恰是"损坏的文件 + 新镜像"）。这里就地合成一份**结构合法的最小
 * 数据集**，保证流水线在任何环境下都能跑满全部场景。
 */
function synthesizeDataSource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-src-'))
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

/** 仓库当前 data/ 里的 JSON（排除凭据与派生缓存）。 */
function listDataSourceFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !f.includes('.corrupt-'))
    .sort()
}

/**
 * 造一个挂载用的数据目录。
 * @param {{corrupt?: string|null, credentials?: boolean}} opts
 */
function makeFixture(name, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fbp-pipeline-${name}-`))
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const src = opts.sourceDir || dataSource
  const files = listDataSourceFiles(src)
  for (const f of files) {
    fs.copyFileSync(path.join(src, f), path.join(dataDir, f))
  }
  // 凭据单独控制：默认**不带**，保证流水线完全离线、不消耗任何上游额度。
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
  // 指向宿主机的本地 config（端口/数据目录都由 env 覆盖，配置本身不影响断言）
  const example = path.join(ROOT, 'config.example.yaml')
  if (fs.existsSync(example)) fs.copyFileSync(example, path.join(dataDir, 'config.yaml'))
  if (opts.corrupt) {
    // 写坏：截断到一半并追加非法字符——最接近"写盘被中断/版本不兼容"的真实形态
    const target = path.join(dataDir, opts.corrupt)
    fs.writeFileSync(target, '{"broken": tru')
  }
  if (opts.dirty) {
    // 脏条目：**合法 JSON、非法条目**——这是"更新镜像后起不来"的真实形态，
    // 截断式损坏反而永远测不到（语法错误走的是另一条分支）。
    fs.writeFileSync(path.join(dataDir, opts.dirty.file), opts.dirty.content)
  }
  return { dir, dataDir, files }
}

/* ---------------- 容器编排 ---------------- */
async function startContainer({ name, image, dataDir, port }) {
  run('docker', ['rm', '-f', name])
  const args = [
    'run', '-d',
    '--name', name,
    '-e', 'FREEBUFF_PROXY_DATA_DIR=/data',
    '-e', 'FREEBUFF_PROXY_CONFIG=/data/config.yaml',
    '-e', 'FREEBUFF_PROXY_HOST=0.0.0.0',
    '-e', `FREEBUFF_PROXY_PORT=${CONTAINER_PORT}`,
    '-e', 'ADMIN_PASSWORD=pipeline-admin-pw',
    // 容器内 127.0.0.1 是容器自己；这里没有凭据也就不需要代理
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

function containerState(name) {
  const res = run('docker', [
    'inspect', name,
    '--format', '{{.State.Status}}|{{.State.ExitCode}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}',
  ])
  if (res.status !== 0) return { status: 'missing', exitCode: null, health: '' }
  const [status, exitCode, health] = String(res.stdout).trim().split('|')
  return { status, exitCode: Number(exitCode), health }
}

function containerLogs(name) {
  const res = run('docker', ['logs', name])
  return `${res.stdout || ''}${res.stderr || ''}`
}

function stopContainer(name) {
  run('docker', ['rm', '-f', name])
}

/**
 * 在容器内用 admin 账号打一次真实登录，返回 Set-Cookie。
 *
 * 为什么必须在**容器里**做：宿主侧端口映射下 cookie 的 Secure/Domain 判定
 * 与浏览器不同，映射后取不到 cookie 会误报"登录坏了"。容器内 127.0.0.1
 * 就是应用本身，等价于用户在本机浏览器打开控制台。失败返回 null。
 */
function loginInsideContainer(name) {
  const body = JSON.stringify({ username: 'admin', password: 'pipeline-admin-pw' })
  const cmd =
    "wget -qO- -S --header='Content-Type: application/json' --post-data='" +
    body +
    "' http://127.0.0.1:${FREEBUFF_PROXY_PORT:-8787}/api/auth/login 2>&1 | head -30"
  const r = run('docker', ['exec', name, 'sh', '-c', cmd])
  const out = String(r.stdout || '') + String(r.stderr || '')
  const m = out.match(/Set-Cookie:\s*(fb_session=[^;\r\n]+)/i)
  return m ? m[1] : null
}

/**
 * 在容器内请求一个需要登录的接口，返回 HTTP 状态码（0 = 连不上/没输出）。
 *
 * **这条断言是必须的**：数据文件自检接口曾因 `path` 变量遮蔽 node:path 而直接
 * 500（真实用户故障），只测 /healthz 完全看不出来。
 */
function probeAuthedEndpoint(name, cookie, endpoint) {
  const cmd = "wget -qO- -S --header='Cookie: " + cookie +
    "' http://127.0.0.1:${FREEBUFF_PROXY_PORT:-8787}" + endpoint + " 2>&1 | head -30"
  const r = run('docker', ['exec', name, 'sh', '-c', cmd])
  const out = String(r.stdout || '') + String(r.stderr || '')
  const m = out.match(/HTTP\/\S+\s+(\d{3})/)
  return m ? Number(m[1]) : 0
}

/**
 * 删除 fixture 目录。
 *
 * **不能直接 rmSync**：容器以 root 启动，entrypoint 会把 /data chown 给 node(1000)。
 * 本地开发机 uid 恰好是 1000（chown 等价于没变），但 CI runner 不是——宿主侧删除
 * 会 EACCES，而它发生在 finally 里，会把整条流水线带崩（v1.12.0 的 CI 实测）。
 * 所以优先借一个 root 容器删（用刚构建的镜像，不额外拉取），失败再退回本地删除。
 * 任何情况下都不得抛：清理失败只是留个临时目录，不该判流水线失败。
 */
function removeFixture(dir, image) {
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

/** 等容器稳定：要么监听成功（healthz 200），要么进程退出/崩溃。 */
async function waitForBoot(name, port, timeoutMs = BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let last = { status: 0 }
  while (Date.now() < deadline) {
    const st = containerState(name)
    if (st.status === 'missing' || st.status === 'exited' || st.status === 'dead') {
      return { up: false, state: st, probe: last }
    }
    last = await httpGet(`http://127.0.0.1:${port}/healthz`)
    if (last.status === 200) return { up: true, state: st, probe: last }
    await sleep(700)
  }
  return { up: false, state: containerState(name), probe: last, timeout: true }
}

/* ---------------- 场景 ---------------- */
/**
 * 场景表：
 *  - fresh          空 /data（首次启动）→ 必须正常起来
 *  - current-data   仓库当前 data/ 的副本（用户真实的"旧数据 + 新镜像"场景）
 *  - corrupt-<file> 逐个把某个 JSON 写坏。users.json 期望**拒绝启动**（保护账号），
 *                   其余期望"降级但能起"，且启动日志必须点名该文件
 */
function buildScenarios(files) {
  const scenarios = [
    { id: 'fresh', title: '空数据目录（首次启动）', expectUp: true },
    { id: 'current-data', title: '当前 data/ 副本（旧数据 + 新镜像）', expectUp: true },
  ]
  for (const f of files) {
    const critical = f === 'users.json'
    scenarios.push({
      id: `corrupt-${f.replace(/\.json$/, '')}`,
      title: `损坏 ${f}${critical ? '（期望拒绝启动：保护账号真源）' : '（期望降级启动 + 日志点名）'}`,
      expectUp: !critical,
      corrupt: f,
      expectLogMention: f,
      expectRefuse: critical,
    })
  }
  // 脏条目回归：数组里混进 null（JSON 合法、条目非法）曾让进程在监听端口之前
  // 就 TypeError 退出，而语法级自检一律报 ok —— 用户只能靠删 json 试错。
  // 期望：照常启动，且启动日志点名该文件与"非法条目"。
  scenarios.push({
    id: 'dirty-entries',
    title: '数组里混入 null 条目（真实故障形态；期望正常启动 + 日志点名）',
    expectUp: true,
    dirty: {
      file: 'web-sessions.json',
      content: JSON.stringify({ version: 1, sessions: [null] }, null, 2),
    },
    expectDirtyMention: '非法条目',
  })
  scenarios.push({
    id: 'bom-users',
    title: 'users.json 带 UTF-8 BOM（Windows 编辑器常见；期望正常启动）',
    expectUp: true,
    dirty: {
      file: 'users.json',
      content:
        '\uFEFF' +
        JSON.stringify(
          { version: 1, users: [{ username: 'admin', salt: 's', passwordHash: '00', role: 'admin', apiKey: 'k' }] },
          null,
          2,
        ),
    },
  })
  scenarios.push({
    id: 'dirty-login-flows',
    title: 'login-flows.json 混入 null 条目（期望正常启动 + 日志点名）',
    expectUp: true,
    dirty: {
      file: 'login-flows.json',
      content: JSON.stringify({ version: 1, flows: [null] }, null, 2),
    },
    expectDirtyMention: '非法条目',
  })
  return scenarios
}

async function runScenario(scenario, index, image) {
  const name = `fbp-pipe-${scenario.id}`.replace(/[^a-zA-Z0-9_.-]/g, '-')
  const fixture = makeFixture(scenario.id, {
    corrupt: scenario.corrupt || null,
    dirty: scenario.dirty || null,
    credentials: withCredentials,
    sourceDir: scenario.sourceDir,
  })
  const port = await freePort()
  const result = { id: scenario.id, title: scenario.title, ok: false, notes: [] }
  try {
    await startContainer({ name, image, dataDir: fixture.dataDir, port })
    const boot = await waitForBoot(name, port, scenario.expectUp ? BOOT_TIMEOUT_MS : 25_000)
    const logs = containerLogs(name)
    result.logs = logs

    if (scenario.expectRefuse) {
      // 应当**没有**监听成功，并且以非 0 退出（拒绝启动）
      const state = containerState(name)
      const refused = !boot.up && state.status === 'exited'
      const explained = /拒绝启动/.test(logs) && /users\.json/.test(logs)
      result.notes.push(`容器状态=${state.status} exit=${state.exitCode}`)
      result.notes.push(explained ? '日志给出了拒绝原因与处置办法' : red('日志缺少拒绝原因'))
      result.ok = refused && explained
      return result
    }

    if (!boot.up) {
      result.notes.push(red(`容器未进入健康状态（state=${boot.state?.status}, exit=${boot.state?.exitCode}, healthz=${boot.probe?.status}）`))
      return result
    }
    result.notes.push(`healthz 200（health=${boot.state?.health || 'n/a'}）`)
    if (scenario.expectLogMention) {
      const mentioned = logs.includes(scenario.expectLogMention) && /数据文件损坏/.test(logs)
      result.notes.push(mentioned ? '启动日志点名了损坏文件' : red('启动日志未点名损坏文件'))
      if (!mentioned) return result
    }
    if (scenario.expectDirtyMention) {
      const mentioned =
        logs.includes(scenario.expectDirtyMention) && !/启动失败/.test(logs)
      result.notes.push(mentioned ? '启动日志点名了非法条目（并正常启动）' : red('启动日志未点名非法条目'))
      if (!mentioned) return result
    }
    // 健康检查必须真过（Dockerfile 的 HEALTHCHECK 坑过一次）
    const hc = await waitForHealthcheck(name, 45_000)
    result.notes.push(hc ? 'Docker HEALTHCHECK 通过' : red('Docker HEALTHCHECK 未通过（新容器一直 health: starting）'))
    if (!hc) return result
    // 控制台接口可达（未登录应 401，说明 API 已挂载）
    const api = await httpGet(`http://127.0.0.1:${port}/api/system/data-status`)
    result.notes.push(api.status === 401 ? '控制台 API 已挂载（未登录 401）' : red(`控制台 API 异常（${api.status}）`))
    if (api.status !== 401) return result

    // 真实登录 + 打需要鉴权的接口。
    // 为什么必须有：**只测 /healthz 会漏掉"起来了但控制台接口 500"**——数据文件
    // 自检接口就曾因 api.js 里 `const path = url.pathname` 遮蔽了 node:path 模块，
    // 一路 500 到用户手里（真实故障）。这里在容器内真实登录，再逐个打关键接口。
    const cookie = loginInsideContainer(name)
    if (!cookie) {
      result.notes.push(red('容器内 admin 登录失败（拿不到会话 cookie）'))
      return result
    }
    result.notes.push('容器内 admin 登录成功')
    const authedPaths = [
      '/api/me',
      '/api/accounts',
      '/api/models',
      '/api/system/data-status',
      '/api/settings',
      '/api/proxy',
      '/api/users',
      '/api/overview',
    ]
    const failures = []
    for (const p of authedPaths) {
      const code = probeAuthedEndpoint(name, cookie, p)
      if (code !== 200) failures.push(`${p}=>${code || '无响应'}`)
    }
    if (failures.length) {
      result.notes.push(red(`控制台接口异常: ${failures.join(', ')}`))
      return result
    }
    result.notes.push(`控制台 ${authedPaths.length} 个接口全部 200`)

    result.ok = true
    return result
  } catch (err) {
    result.notes.push(red(String(err?.message || err)))
    return result
  } finally {
    stopContainer(name)
    if (keep) {
      result.notes.push(dim(`fixture 保留在 ${fixture.dir}`))
    } else {
      removeFixture(fixture.dir, image)
    }
    if (index >= 0) { /* 仅用于日志顺序 */ }
  }
}

/** Dockerfile HEALTHCHECK 的 start-period(15s)+interval(30s) 至少要等一轮。 */
async function waitForHealthcheck(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = containerState(name)
    if (st.health === 'healthy') return true
    if (st.status !== 'running') return false
    await sleep(2000)
  }
  return false
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const docker = run('docker', ['version', '--format', '{{.Server.Version}}'])
  if (docker.status !== 0) {
    console.error(red('Docker 不可用，镜像流水线无法运行'))
    process.exit(2)
  }
  log(dim(`docker ${String(docker.stdout).trim()}`))

  const targetImage = image
  if (!skipBuild) {
    log(`\n▶ 构建镜像 ${targetImage}`)
    const build = run('docker', ['build', '-t', targetImage, '.'], { cwd: ROOT, stdio: 'inherit' })
    if (build.status !== 0) {
      console.error(red('构建失败'))
      process.exit(1)
    }
  } else {
    log(`\n▶ 跳过构建，使用镜像 ${targetImage}`)
  }

  let source = dataSource
  let files = listDataSourceFiles(source)
  if (!files.length) {
    // CI / 全新 clone 没有 data/：合成一份，别让"损坏文件"场景被静默跳过
    source = synthesizeDataSource()
    files = listDataSourceFiles(source)
    log(dim(`数据源 ${dataSource} 为空（未跟踪/首次运行）→ 已合成 ${files.length} 个最小 JSON 作为基线`))
  }
  const scenarios = buildScenarios(files).map((s) => ({ ...s, sourceDir: source }))
  log(dim(`数据源: ${source}（${files.length} 个 JSON）· 凭据: ${withCredentials ? '带上（会连上游）' : '不带（离线）'}`))

  const results = []
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i]
    log(`\n▶ [${i + 1}/${scenarios.length}] ${s.title}`)
    const r = await runScenario(s, i, targetImage)
    for (const n of r.notes) log(`   ${n}`)
    log(`   ${r.ok ? green('PASS') : red('FAIL')}`)
    results.push(r)
  }

  const failed = results.filter((r) => !r.ok)
  log('\n' + '─'.repeat(60))
  for (const r of results) {
    log(`${r.ok ? green('✓') : red('✗')} ${r.id.padEnd(22)} ${r.title}`)
  }
  log(`\n${results.length - failed.length}/${results.length} 个场景通过`)

  if (failed.length) {
    for (const r of failed) {
      log(`\n=== ${r.id} 日志尾部 ===`)
      log(String(r.logs || '').split('\n').slice(-30).join('\n'))
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
