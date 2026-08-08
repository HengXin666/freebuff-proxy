#!/usr/bin/env node
import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.js'
import { buildAppContext } from '../src/app-context.js'
import { listAccounts, resolveCredentialsDir } from '../src/auth-store.js'
import { UserStore } from '../src/web/user-store.js'
import { configureLogger } from '../src/util/log.js'

function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host || ''))
}

function parseConfigPath(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') return argv[i + 1]
  }
  return undefined
}

function printIssues(issues) {
  if (!issues.length) {
    console.log('doctor: all checks passed')
    return
  }
  console.log('doctor: issues')
  for (const i of issues) console.log(' -', i)
}

async function main() {
  const config = loadConfig(parseConfigPath(process.argv.slice(2)))
  configureLogger(config.logging)

  const issues = []
  const dir = resolveCredentialsDir(config)
  console.log(
    'config path:',
    config._configPath,
    config._configExists ? '(found)' : '(missing, using defaults)',
  )
  console.log('data dir:', config.server.dataDir)
  console.log(
    'credentials dir:',
    dir,
    fs.existsSync(dir) ? '(found)' : '(missing)',
  )
  console.log('api_base:', config.upstream.apiBase)
  console.log('login_base:', config.upstream.loginBase)
  console.log(
    'proxy:',
    config.upstream.proxy ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      '(none)',
  )

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
  try {
    const me = await ctx.upstream.me(['id', 'email'])
    console.log('GET /api/v1/me: OK', me)
  } catch (err) {
    issues.push(
      `GET /api/v1/me failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  try {
    const session = await ctx.upstream.freebuffSession('GET')
    console.log('GET /api/v1/freebuff/session:', session?.status || session)
  } catch (err) {
    issues.push(
      `GET freebuff session failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  printIssues(issues)
  if (issues.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err)
  process.exitCode = 1
})
