#!/usr/bin/env node
import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.ts'
import { buildAppContext } from '../src/app-context.ts'
import { listAccounts, resolveCredentialsDir } from '../src/auth-store.ts'
import { UserStore } from '../src/web/user-store.ts'
import { configureLogger } from '../src/util/log.ts'
import { printConfigSummary, printIssues, probeUpstream } from './doctor/report.ts'

/**
 - @param {unknown} host 监听地址
 - @returns {boolean} 是否回环地址
 */
function isLoopbackHost(host: any) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host || ''))
}

/**
 - @param {string[]} argv 命令行参数
 - @returns {string|undefined} --config 或 -c 后面的路径
 */
function parseConfigPath(argv: any) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') return argv[i + 1]
  }
  return undefined
}

/** 打印配置 / 账号 / 上游可达性, 并汇总问题. */
async function main() {
  const config = loadConfig(parseConfigPath(process.argv.slice(2)))
  configureLogger(config.logging)

  const issues = []
  const dir = resolveCredentialsDir(config)
  printConfigSummary(config, dir, fs.existsSync)

  const userStore = new UserStore(path.join(config.server.dataDir, 'users.json'))
  console.log(
    'web users:',
    userStore.all().map((u) => `${u.username}(${u.role})`).join(', ') || '(none)',
  )

  if (
    (config.server.apiKeys || []).length === 0 &&
    !isLoopbackHost(config.server.host) &&
    userStore.all().length === 0
  ) {
    issues.push(
      'no server.api_keys and no web users while binding a non-loopback host; set api_keys / create a user / bind loopback',
    )
  }

  const accounts = listAccounts(dir)
  if (!accounts.length) {
    console.log('accounts: (none — 在 Web 控制台添加账号或运行 npm run login)')
    return
  }
  console.log('accounts:', accounts.map((a) => a.email).join(', '))

  let ctx
  try {
    ctx = buildAppContext(config)
    console.log('sample account token: OK from', ctx.authSource)
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err))
    printIssues(issues)
    process.exitCode = 1
    return
  }

  await probeUpstream(ctx.upstream, issues)
  printIssues(issues)
  if (issues.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err)
  process.exitCode = 1
})
