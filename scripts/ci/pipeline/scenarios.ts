/**
 * 场景表与单场景执行 -- 从 scripts/ci/pipeline-image-test.ts 按职责切出.
 *
 * 为什么 runScenario 要拆:它原本是 98 行的单函数, 同时管"起容器 / 判启动 /
 * 判日志 / 判健康检查 / 判接口 / 清理"六件事. 拆成 场景表 + 三个断言段之后,
 * 每条断言单独可读, 失败时能一眼定位是哪一段没过.
 *
 * 口径: 纯搬移, 不改行为, 不改任何一行 note 文案.
 */
import { dim, freePort, green, httpGet, log, red, run } from './lib/io.ts'
import { probeAuthedEndpoint, loginInsideContainer, waitForBoot, waitForHealthcheck } from './lib/probes.ts'
import { startContainer, stopContainer, containerState, containerLogs } from './lib/container.ts'
import { makeFixture, removeFixture } from './lib/fixtures.ts'
import { BOOT_TIMEOUT_MS } from './lib/paths.ts'

/**
 * 场景表.
 *
 * - fresh          空 /data(首次启动) -> 必须正常起来
 * - current-data   仓库当前 data/ 的副本(用户真实的"旧数据 + 新镜像"场景)
 * - corrupt-<file> 逐个把某个 JSON 写坏.users.json 期望拒绝启动(保护账号),
 *   其余期望"降级但能起",且启动日志必须点名该文件
 * @param {string[]} files 基准数据目录里的 JSON 文件名
 * @returns {Array<object>} 场景定义
 */
export function buildScenarios(files) {
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
  // 脏条目回归:数组里混进 null(JSON 合法,条目非法)曾让进程在监听端口之前
  // 就 TypeError 退出,而语法级自检一律报 ok -- 用户只能靠删 json 试错.
  // 期望:照常启动,且启动日志点名该文件与"非法条目".
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

/**
 * 断言"应当拒绝启动"的场景:没有监听成功,且以非 0 退出.
 * @param {object} result 结果累加器
 * @param {object} boot waitForBoot 的结论
 * @param {string} logs 容器日志
 * @param {string} name 容器名
 * @returns {boolean} 是否通过
 */
function assertRefused(result, boot, logs, name) {
  const state = containerState(name, run)
  const refused = !boot.up && state.status === 'exited'
  const explained = /拒绝启动/.test(logs) && /users\.json/.test(logs)
  result.notes.push(`容器状态=${state.status} exit=${state.exitCode}`)
  result.notes.push(explained ? '日志给出了拒绝原因与处置办法' : red('日志缺少拒绝原因'))
  return refused && explained
}

/**
 * 断言正常启动的场景:健康检查真过 + 日志点名 + 控制台接口可达 + 真实登录后逐个接口 200.
 * @param {object} result 结果累加器
 * @param {object} boot waitForBoot 的结论
 * @param {string} logs 容器日志
 * @param {object} scenario 场景定义
 * @param {{name: string, port: number}} ctx 容器名与端口
 * @returns {Promise<boolean>} 是否通过
 */
async function assertHealthy(
  result, boot, logs, scenario, ctx,
) {
  if (!boot.up) {
    const detail = `state=${boot.state?.status}, exit=${boot.state?.exitCode}`
      + `, healthz=${boot.probe?.status}`
    result.notes.push(red(`容器未进入健康状态（${detail}）`))
    return false
  }
  result.notes.push(`healthz 200（health=${boot.state?.health || 'n/a'}）`)
  if (scenario.expectLogMention) {
    const mentioned = logs.includes(scenario.expectLogMention) && /数据文件损坏/.test(logs)
    result.notes.push(mentioned ? '启动日志点名了损坏文件' : red('启动日志未点名损坏文件'))
    if (!mentioned) return false
  }
  if (scenario.expectDirtyMention) {
    const mentioned =
      logs.includes(scenario.expectDirtyMention) && !/启动失败/.test(logs)
    result.notes.push(mentioned ? '启动日志点名了非法条目（并正常启动）' : red('启动日志未点名非法条目'))
    if (!mentioned) return false
  }
  // 健康检查必须真过(Dockerfile 的 HEALTHCHECK 坑过一次)
  const hc = await waitForHealthcheck(ctx.name, 45_000, run)
  result.notes.push(hc ? 'Docker HEALTHCHECK 通过' : red('Docker HEALTHCHECK 未通过（新容器一直 health: starting）'))
  if (!hc) return false
  // 控制台接口可达(未登录应 401,说明 API 已挂载)
  const api = await httpGet(`http://127.0.0.1:${ctx.port}/api/system/data-status`)
  result.notes.push(api.status === 401 ? '控制台 API 已挂载（未登录 401）' : red(`控制台 API 异常（${api.status}）`))
  if (api.status !== 401) return false
  return assertAuthedEndpoints(result, ctx.name)
}

/**
 * 真实登录后逐个打需要鉴权的接口.
 *
 * 为什么必须有:只测 /healthz 会漏掉"起来了但控制台接口 500" -- 数据文件
 * 自检接口就曾因 api.js 里 const path = url.pathname 遮蔽了 node:path 模块,
 * 一路 500 到用户手里(真实故障).
 * @param {object} result 结果累加器
 * @param {string} name 容器名
 * @returns {boolean} 是否全部 200
 */
function assertAuthedEndpoints(result, name) {
  const cookie = loginInsideContainer(name, run)
  if (!cookie) {
    result.notes.push(red('容器内 admin 登录失败（拿不到会话 cookie）'))
    return false
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
    const code = probeAuthedEndpoint(name, cookie, p, run)
    if (code !== 200) failures.push(`${p}=>${code || '无响应'}`)
  }
  if (failures.length) {
    result.notes.push(red(`控制台接口异常: ${failures.join(', ')}`))
    return false
  }
  result.notes.push(`控制台 ${authedPaths.length} 个接口全部 200`)
  return true
}

/**
 * 跑一个场景:造固件 -> 起容器 -> 断言 -> 清理.
 * @param {object} scenario 场景定义
 * @param {number} index 场景序号
 * @param {string} image 镜像名
 * @param {{withCredentials: boolean, keep: boolean, dataSource: string}} opts 运行选项
 * @returns {Promise<object>} 场景结果
 */
export async function runScenario(scenario, index, image, opts) {
  const name = `fbp-pipe-${scenario.id}`.replace(/[^a-zA-Z0-9_.-]/g, '-')
  const fixture = makeFixture(scenario.id, {
    corrupt: scenario.corrupt || null,
    dirty: scenario.dirty || null,
    credentials: opts.withCredentials,
    sourceDir: scenario.sourceDir,
  }, opts.dataSource)
  const port = await freePort()
  const result = { id: scenario.id, title: scenario.title, ok: false, notes: [] }
  try {
    await startContainer({ name, image, dataDir: fixture.dataDir, port }, run)
    const boot = await waitForBoot(name, port, run, scenario.expectUp ? BOOT_TIMEOUT_MS : 25_000)
    const logs = containerLogs(name, run)
    result.logs = logs

    if (scenario.expectRefuse) {
      result.ok = assertRefused(result, boot, logs, name)
      return result
    }
    result.ok = await assertHealthy(result, boot, logs, scenario, { name, port })
    return result
  } catch (err) {
    result.notes.push(red(String(err?.message || err)))
    return result
  } finally {
    stopContainer(name, run)
    if (opts.keep) {
      result.notes.push(dim(`fixture 保留在 ${fixture.dir}`))
    } else {
      removeFixture(fixture.dir, image, run, dim)
    }
    if (index >= 0) { /* 仅用于日志顺序 */ }
  }
}

/** 打印场景结果行(供主流程复用,避免主流程里出现重复格式). */
/**
 - 打印场景结果行(供主流程复用, 避免主流程里出现重复格式).
 - @param {{ok: boolean}} result 场景结果
 - @returns {void} 无返回值
 */
export function printResultLine(result) {
  log(`   ${result.ok ? green('PASS') : red('FAIL')}`)
}
