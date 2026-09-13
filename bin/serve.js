#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { loadConfig } from '../src/config.js'
import { buildAppContext } from '../src/app-context.js'
import { startServer } from '../src/server.js'
import { configureLogger, logger } from '../src/util/log.js'
import { UserStore } from '../src/web/user-store.js'
import { WebSessionStore } from '../src/web/session-store.js'
import { LoginFlowManager } from '../src/web/login-flows.js'
import { ProxyStore } from '../src/web/proxy-store.js'
import { SettingsStore } from '../src/web/settings-store.js'
import { ModelStore } from '../src/web/model-store.js'
import { listAccounts } from '../src/auth-store.js'
import {
  dataFileAudit,
  invalidDataFiles,
  dirtyDataFiles,
} from '../src/util/json-store.js'

function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host || ''))
}

function parseConfigPath(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') return argv[i + 1]
  }
  return undefined
}

/**
 * 自重启子进程的端口等待：旧进程退出需要一点时间，轮询直到端口可绑定，
 * 避免子进程启动时撞上 EADDRINUSE（裸机/非 Docker 场景）。
 */
function waitForPortFree(host, port, timeoutMs) {
  const target =
    !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tryOnce = () => {
      const socket = net.connect({ host: target, port })
      const done = () => {
        socket.destroy()
        if (Date.now() < deadline) setTimeout(tryOnce, 250)
        else resolve()
      }
      socket.once('connect', done)
      socket.once('error', () => resolve()) // 端口已释放 → 可以接管
    }
    tryOnce()
  })
}

/**
 * 启动失败兜底：把"为什么起不来"直接写在日志最后一段。
 *
 * 起因是真实故障——镜像升级后容器起不来，用户只能靠"删几个 json 试试"恢复。
 * 根因是几个 store 在**构造期**直接抛（数据文件数组里混进 null 条目），那时
 * logDataFileAudit() 还没轮到执行，日志里既没有文件名字也没有处置办法。
 * 现在无论哪个阶段抛，都保证输出：错误本身 + 已登记的数据文件状态 +
 * 残留的写盘中间文件 + 可直接照做的处置命令。
 * @param {unknown} err
 */
function reportStartupFailure(err) {
  const detail = err instanceof Error ? err.stack || err.message : String(err)
  const lines = [
    '',
    '[freebuff-proxy] ✗ 启动失败（服务未能进入监听状态）',
    `  错误: ${err instanceof Error ? err.message : String(err)}`,
  ]

  const bad = invalidDataFiles()
  const dirty = dirtyDataFiles()
  if (bad.length) {
    lines.push('  数据文件损坏:')
    for (const f of bad) {
      lines.push(`    - ${f.file}`)
      lines.push(`      原因: ${f.reason}`)
      lines.push(`      处置: 停服后 mv ${f.file} ${f.file}.broken 再启动（程序会按默认值重建）`)
    }
  }
  if (dirty.length) {
    lines.push('  数据文件含非法条目（已自动丢弃，原文留证）:')
    for (const f of dirty) {
      lines.push(
        `    - ${f.file} — ${f.droppedReason}（丢弃 ${f.droppedEntries} 条）` +
          (f.droppedBackup ? `，留证: ${f.droppedBackup}` : ''),
      )
    }
  }

  // 写盘被中断的残留：*.tmp 是原子写的中间态，正常完成后不会留在盘上。
  try {
    const dataDir = loadConfig(parseConfigPath(process.argv.slice(2))).server.dataDir
    const tmps = fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))
    if (tmps.length) {
      lines.push('  残留的写盘中间文件（上次写盘被中断，可安全删除）:')
      for (const t of tmps) lines.push(`    - ${path.join(dataDir, t)}`)
    }
  } catch {
    // 数据目录读不了不影响诊断输出
  }

  if (!bad.length && !dirty.length) {
    lines.push(
      '  未发现明显的数据文件问题。请把上面的完整堆栈发给维护者；' +
        '临时处置：把 data/ 下的状态 JSON 逐个移走（保留 credentials/）以定位是哪一个。',
    )
  }
  lines.push(
    '  提示: 控制台「总览 → 数据文件自检」(/api/system/data-status) 也列出同样的信息。',
    '',
  )
  console.error(lines.join('\n'))
  console.error(detail)
}

async function main() {
  const config = loadConfig(parseConfigPath(process.argv.slice(2)))
  configureLogger(config.logging)

  /**
   * 数据文件定点自检（启动横幅）：把 data/ 下每个 JSON 的装载结果打印一行。
   * 起因是真实故障——镜像升级后服务起不来，而日志里只有一行 warn，用户只能
   * 靠"删掉几个 json 就好了"这种试错。现在启动时**明确说清楚**：哪些文件正常、
   * 哪些缺失（首次启动）、哪些损坏以及怎么处置。
   */
  function logDataFileAudit() {
    const files = dataFileAudit()
    if (!files.length) return
    const bad = invalidDataFiles()
    const dirty = dirtyDataFiles()
    logger.info('data files checked', {
      total: files.length,
      ok: files.filter((f) => f.status === 'ok').length,
      missing: files.filter((f) => f.status === 'missing').length,
      invalid: bad.length,
      // 条目级问题（文件合法但丢过脏条目）：与"文件损坏"分开计数，处置办法也不同
      droppedEntries: dirty.reduce((n, f) => n + (f.droppedEntries || 0), 0),
    })
    for (const f of bad) {
      console.error(
        `[freebuff-proxy] ⚠ 数据文件损坏: ${f.file}\n` +
          `  原因: ${f.reason}\n` +
          `  处置: 停服后把该文件移走（mv ${f.file} ${f.file}.broken）再启动即可，\n` +
          `        程序会按默认值重建；要保留历史就先备份。控制台「总览 → 数据文件自检」也会列出。\n`,
      )
    }
    for (const f of dirty) {
      console.error(
        `[freebuff-proxy] ⚠ 数据文件含非法条目: ${f.file}\n` +
          `  原因: ${f.droppedReason}（丢弃 ${f.droppedEntries} 条）\n` +
          (f.droppedBackup ? `  原文留证: ${f.droppedBackup}\n` : '') +
          `  处置: 无需人工干预——坏条目已被丢弃，服务照常运行；\n` +
          `        想核对丢了什么就打开上面的留证文件。控制台「总览 → 数据文件自检」也会列出。\n`,
      )
    }
    if (bad.length || dirty.length) {
      logger.warn('data file problems detected (service continues in degraded mode)', {
        files: bad.map((f) => f.file),
        dirtyFiles: dirty.map((f) => f.file),
      })
    }
  }

  // 自重启子进程：等旧进程释放端口后再走正常启动流程
  if (process.env.FREEBUFF_PROXY_RESTART_CHILD === '1') {
    logger.info('restart child starting; waiting for port to free', {
      host: config.server.host,
      port: config.server.port,
    })
    await waitForPortFree(config.server.host, config.server.port, 15_000)
  }

  const dataDir = config.server.dataDir
  const userStore = new UserStore(path.join(dataDir, 'users.json'))
  /**
   * users.json 损坏**必须拒绝启动**，绝不能"当成还没有账号"继续跑：
   * ensureDefaultAdmin 会立刻新建一个 admin，用户看到的是"我的账号和密码全没了"；
   * 而实际上文件还在盘上（多半是被写坏/版本不兼容），把旧文件挪开就能重新引导。
   * 数据目录里的其它文件坏了都只是降级（各自有兜底），只有这一份是登录凭据真源，
   * 静默重建的代价远大于"暂停启动并把原因写清楚"。
   */
  if (userStore.loadStatus === 'invalid') {
    console.error(
      `\n[freebuff-proxy] 拒绝启动：数据文件损坏，不能安全引导管理员账号\n` +
        `  文件: ${userStore.file}\n` +
        `  原因: ${userStore.loadReason}\n\n` +
        `  为什么不能自动重建：users.json 是控制台登录凭据（哈希+API Key）的唯一真源。\n` +
        `  自动重建会新建一个 admin，让你以为"账号全丢了"，而原文件其实还在。\n\n` +
        `  请二选一后重启：\n` +
        `   1) 恢复原文件：把备份/旧版本复制回 ${userStore.file}\n` +
        `   2) 重新引导：mv ${userStore.file} ${userStore.file}.broken 后重启\n` +
        `      （全新管理员密码会打印在日志里；ADMIN_PASSWORD 也可直接指定）\n`,
    )
    process.exitCode = 1
    return
  }
  const webSessions = new WebSessionStore(
    path.join(dataDir, 'web-sessions.json'),
    (config.web.sessionTtlHours || 24 * 7) * 3600 * 1000,
  )
  // 前端「代理设置」管理的全局代理池（优先于 config.yaml 的 upstream.proxies）
  const proxyStore = new ProxyStore(path.join(dataDir, 'proxies.json'))
  const settingsStore = new SettingsStore(path.join(dataDir, 'settings.json'))
  // 前端「模型管理」管理的自定义模型列表（覆盖/扩展内置目录）
  const modelStore = new ModelStore(path.join(dataDir, 'custom-models.json'))
  if (proxyStore.list().length) {
    config.upstream.proxies = proxyStore.list()
  }

  // First-run admin bootstrap (or env-driven rotation)
  const admin = userStore.ensureDefaultAdmin(
    config.users.defaultAdminUsername,
    config.users.defaultAdminPassword || null,
  )
  // 密码来源：env(ADMIN_PASSWORD) / users.default_admin_password(config.yaml) /
  // generated(随机，仅首次启动打印一次)。issue #9：旧日志只说
  // "password from env"，用户既不知道密码是什么、也分不清是不是 env 生效，
  // 只能干瞪眼看不出"管理员无法登录"的原因——这里必须把来源和找回方式写清楚。
  const adminPasswordSource = process.env.ADMIN_PASSWORD
    ? 'env'
    : config.users.defaultAdminPassword
      ? 'config'
      : 'generated'
  if (admin.created) {
    if (admin.password) {
      logger.info(
        'default admin created — credentials shown once in logs below',
        { username: admin.username, passwordSource: adminPasswordSource },
      )
      // Visible in `docker compose logs` for one-click onboarding
      console.log(
        `\n[freebuff-proxy] 首次启动：已创建管理员账号\n` +
          `  登录地址: http://<host>:${config.server.port}/\n` +
          `  用户名:   ${admin.username}\n` +
          `  密码:     ${admin.password}\n` +
          (adminPasswordSource === 'generated'
            ? `  （ADMIN_PASSWORD 未设置或为空 → 已随机生成，只在首次启动时打印这一次）\n` +
              `  请立即登录并修改密码，并把 ADMIN_PASSWORD 写进 .env 以免下次重装丢失。\n`
            : `  （密码来自 ADMIN_PASSWORD 环境变量）\n`),
      )
    } else {
      logger.info('default admin ensured (password from env)', {
        username: admin.username,
        passwordSource: adminPasswordSource,
      })
    }
  } else if (admin.rotated) {
    logger.info('default admin password rotated from env/config', {
      username: admin.username,
      passwordSource: adminPasswordSource,
    })
  } else if (admin.error) {
    logger.warn('ADMIN_PASSWORD/default_admin_password rejected — admin password unchanged', {
      username: admin.username,
      error: admin.error,
    })
  }
  // 已存在管理员且没给密码：把"怎么找回/重置"写进日志，避免重复开 issue。
  if (!admin.created && !admin.password && adminPasswordSource === 'generated') {
    logger.warn(
      'admin password is not printed again — reset by setting ADMIN_PASSWORD or editing users.default_admin_password',
      { username: admin.username, users: path.join(dataDir, 'users.json') },
    )
  }

  if (
    (config.server.apiKeys || []).length === 0 &&
    !isLoopbackHost(config.server.host) &&
    userStore.all().length === 0
  ) {
    console.error(
      'Refuse to serve: no server.api_keys and no web users while binding a non-loopback host.\n' +
        'Set server.api_keys, create a web user, or bind 127.0.0.1 / localhost / ::1.',
    )
    process.exitCode = 1
    return
  }

  const ctx = buildAppContext(config, {
    // 账号并发上限来自控制台设置（/data/settings.json，默认 1:1），实时生效
    getAccountConcurrency: () => settingsStore.get().accountMaxConcurrency,
    // 账号调度模式（控制台可调）：'sticky'（默认，最少换号）| 'spread'（并发优先）
    getSchedulingMode: () => settingsStore.get().accountSchedulingMode,
    // 额度保护（控制台可调）：空闲自动释放秒数 / 单请求新会话预算
    getSessionSettings: () => settingsStore.get(),
    // 自定义模型列表（前端「模型管理」，覆盖内置目录），实时生效
    getCustomModels: () => modelStore.list(),
  })
  // 启动扫尾：把上次进程遗留 / 上次释放失败的上游会话句柄 DELETE 掉。
  // 进程退出时内存里的 instanceId 就没了，不扫的话这些会话就是"无法寻址的
  // 计费孤儿"，会一直占着该账号的上游会话槽位（早退不退 Freebucks，见
  // docs/account-scheduling-and-refund.md §3）。
  try {
    const sweep = await ctx.runtimes.cleanupOrphanSessions()
    if (sweep.cleaned || sweep.failed || sweep.skipped) {
      logger.info('leftover session sweep on startup', sweep)
    }
  } catch (err) {
    logger.warn('leftover session sweep failed (continuing)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (ctx.authEmail) {
    logger.info('upstream auth ready', {
      account: ctx.authEmail,
      accounts: ctx.runtimes.list().map((a) => a.email),
    })
    try {
      const me = await ctx.upstream.me(['id', 'email'])
      logger.info('upstream identity ok', { id: me.id, email: me.email })
    } catch (err) {
      logger.warn('upstream /api/v1/me check failed (continuing)', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } else {
    logger.info('no Freebuff accounts yet — add one from the web console', {
      credentialsDir: ctx.runtimes.dir,
    })
  }

  const loginFlows = new LoginFlowManager({
    file: path.join(dataDir, 'login-flows.json'),
    credentialsDir: ctx.runtimes.dir,
    config,
    // 浏览器登录回调也是写凭据的入口：记「凭证更新时间」到账号账本。
    onCredentialSaved: (key) => ctx.runtimes.markCredentialUpdated(key),
  })
  // catalog 运行时缓存是**懒加载**的（第一次用到模型才读）。这里先按 dataDir
  // 切路径并读一次，一是保证 /v1/models 与内置目录一致（原来由 startServer 里的
  // 异步分支兜底，容器里可能晚于首个请求），二是让"缓存损坏"能出现在下面的自检里。
  try {
    const { applyCatalogCache } = await import('../src/model.js')
    applyCatalogCache(dataDir)
  } catch (err) {
    logger.warn('catalog cache preload skipped', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // 到这里 data/ 下的 JSON 已全部装载过一遍（控制面 6 个 + 句柄索引 + 账号账本
  // + 登录流程 + catalog 缓存），一次性把自检结果打到启动日志里。
  logDataFileAudit()

  let server = null
  const shutdown = async (signal) => {
    logger.info('shutting down', { signal })
    loginFlows.shutdown()
    try {
      // strict：等到每条上游会话真的 DELETE 掉（或退避重试耗尽）再退出。
      // 退出即失去内存里的 instanceId，不严格释放就会留下占着槽位的孤儿；
      // 失败的句柄已落盘 sessions.json，下次启动扫尾继续删。
      const rel = await ctx.runtimes.shutdown({ strict: true })
      if (rel && rel.failed && rel.failed.length) {
        logger.warn('sessions still live at shutdown (handles persisted)', {
          failed: rel.failed.length,
        })
      }
    } catch (err) {
      logger.warn('session shutdown error', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (server) {
      server.close(() => process.exit(0))
      // 重启场景下立即断开存量连接，让端口尽快释放给子进程
      server.closeAllConnections?.()
    } else {
      process.exit(0)
    }
    setTimeout(() => process.exit(0), 3000).unref()
  }

  /**
   * 前端「重启服务」：spawn 一个 detached 子进程（等待端口释放后接管），
   * 然后当前进程优雅退出。Docker 场景下容器主进程退出会触发 restart 策略
   * 整容器重建；裸机场景由子进程无缝接管。
   */
  function scheduleRestart() {
    const child = spawn(
      process.execPath,
      process.argv.slice(1),
      {
        detached: true,
        stdio: 'inherit',
        env: { ...process.env, FREEBUFF_PROXY_RESTART_CHILD: '1' },
      },
    )
    child.unref()
    logger.info('restart scheduled via web console', { pid: child.pid })
    shutdown('restart').catch((err) => {
      logger.error('graceful shutdown during restart failed', {
        error: err instanceof Error ? err.stack || err.message : String(err),
      })
      process.exit(1)
    })
  }

  server = await startServer({
    config,
    runtimes: ctx.runtimes,
    authToken: ctx.authToken,
    authSource: ctx.authSource,
    authEmail: ctx.authEmail,
    upstream: ctx.upstream,
    sessions: ctx.sessions,
    userStore,
    webSessions,
    loginFlows,
    proxyStore,
    settingsStore,
    modelStore,
    restart: scheduleRestart,
  })

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  try {
    reportStartupFailure(err)
  } catch {
    // 诊断本身失败也必须把原始错误打出来
    console.error(err instanceof Error ? err.stack || err.message : err)
  }
  process.exitCode = 1
})
