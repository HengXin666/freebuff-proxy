#!/usr/bin/env node
/**
 * 服务入口: 只做启动编排, 实现按职责拆进 bin/serve/(cli-args / startup-report)
 * 与 bin/serve/boot/(数据自检 / 管理员引导 / 上游预热 / store 装配 / 生命周期).
 *
 * 顺序是刻意的, 每一步都有理由:
 *   参数 -> 自重启端口等待 -> users.json 准入 -> store 装配 -> 管理员引导 ->
 *   监听 -> 上游预热 -> 信号注册.
 * 上游预热必须排在监听之后: 上游可达与否绝不能决定"服务起不起来".
 */
import process from 'node:process'

import { loadConfig } from '../src/config.ts'
import { buildAppContext } from '../src/app-context.ts'
import { startServer } from '../src/server.ts'
import { configureLogger, logger } from '../src/util/log.ts'
import { parseConfigPath, waitForPortFree } from './serve/cli-args.ts'
import { reportStartupFailure } from './serve/startup-report.ts'
import { logDataFileAudit } from './serve/boot/data-audit.ts'
import { bootstrapAdmin } from './serve/boot/bootstrap-admin.ts'
import { startUpstreamWarmup } from './serve/boot/upstream-warmup.ts'
import { createLifecycle } from './serve/boot/lifecycle.ts'
import {
  bindIsSafe, createLoginFlows, createUserStore, openConsoleStores,
  preloadCatalogCache, rejectInvalidUserStore,
} from './serve/boot/stores.ts'

/** 启动编排:装配数据 / 引导管理员 / 监听端口 / 注册信号. */
async function main() {
  const config = loadConfig(parseConfigPath(process.argv.slice(2)))
  configureLogger(config.logging)

  // 自重启子进程:等旧进程释放端口后再走正常启动流程
  if (process.env.FREEBUFF_PROXY_RESTART_CHILD === '1') {
    logger.info('restart child starting; waiting for port to free', {
      host: config.server.host,
      port: config.server.port,
    })
    await waitForPortFree(config.server.host, config.server.port, 15_000)
  }

  const dataDir = config.server.dataDir
  const userStore = createUserStore(dataDir)
  // users.json 是登录凭据真源, 损坏时拒绝启动(理由见 rejectInvalidUserStore).
  if (rejectInvalidUserStore(userStore)) {
    process.exitCode = 1
    return
  }

  const { webSessions, proxyStore, settingsStore, modelStore } = openConsoleStores(dataDir, config)

  // First-run admin bootstrap (or env-driven rotation)
  bootstrapAdmin(userStore, config, dataDir)

  // 非回环监听且无任何凭据: 拒绝启动, 避免裸奔的公开代理
  if (!bindIsSafe(config, userStore)) {
    process.exitCode = 1
    return
  }

  const ctx: any = buildAppContext(config, {
    // 账号并发上限来自控制台设置(/data/settings.json,默认 1:1),实时生效
    getAccountConcurrency: () => settingsStore.get().accountMaxConcurrency,
    // 账号调度模式(控制台可调):'sticky'(默认,最少换号)| 'spread'(并发优先)
    getSchedulingMode: () => settingsStore.get().accountSchedulingMode,
    // 额度保护(控制台可调):空闲自动释放秒数 / 单请求新会话预算
    getSessionSettings: () => settingsStore.get(),
    // 自定义模型列表(前端[模型管理],覆盖内置目录),实时生效
    getCustomModels: () => modelStore.list(),
  })

  const loginFlows = createLoginFlows(dataDir, ctx, config)
  await preloadCatalogCache(dataDir)
  // 到这里 data/ 下的 JSON 已全部装载过一遍(控制面 6 个 + 句柄索引 + 账号账本
  // + 登录流程 + catalog 缓存),一次性把自检结果打到启动日志里.
  logDataFileAudit()

  let server: any = null
  const { shutdown, scheduleRestart } = createLifecycle({
    getServer: () => server,
    loginFlows,
    ctx,
  })

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

  // 端口已经在监听了 -- 现在才去碰上游(扫尾 + 身份自检).
  // 顺序是刻意的:上游可达与否绝不能决定"服务起不起来".
  startUpstreamWarmup({ ctx, settingsStore })

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
