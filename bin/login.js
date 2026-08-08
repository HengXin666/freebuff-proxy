#!/usr/bin/env node
import process from 'node:process'
import { loadConfig } from '../src/config.js'
import {
  generateFingerprintId,
  saveAccountUser,
  resolveCredentialsDir,
} from '../src/auth-store.js'
import { createUpstreamClient } from '../src/upstream/client.js'
import { configureLogger } from '../src/util/log.js'

function parseConfigPath(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') return argv[i + 1]
  }
  return undefined
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const config = loadConfig(parseConfigPath(process.argv.slice(2)))
  configureLogger(config.logging)

  const dir = resolveCredentialsDir(config)
  const fingerprintId = generateFingerprintId()
  const upstream = createUpstreamClient(config, '')
  console.log('Requesting login URL…')
  console.log(`Will save to: ${dir}/<账号ID>.json（GitHub/Google 同邮箱不会互相覆盖）`)
  const code = await upstream.loginCode(fingerprintId)
  console.log('\nOpen this URL in a browser and sign in:\n')
  console.log(code.loginUrl)
  console.log('\nWaiting for login…')

  const started = Date.now()
  const timeoutMs = 5 * 60 * 1000
  while (Date.now() - started < timeoutMs) {
    await sleep(5000)
    const st = await upstream.loginStatus({
      fingerprintId,
      fingerprintHash: code.fingerprintHash,
      expiresAt: code.expiresAt,
    })
    if (st?.user?.authToken) {
      const saved = saveAccountUser(dir, st.user)
      console.log(`\nLogged in as ${saved.user.name || saved.user.email} (id=${saved.user.id || '-'})`)
      console.log(`Saved ${saved.path}`)
      return
    }
    process.stdout.write('.')
  }
  console.error('\nLogin timed out')
  process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err)
  process.exitCode = 1
})
