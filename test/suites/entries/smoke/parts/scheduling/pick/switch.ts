/**
 * scheduling: 每账号调度开关
 *
 * 关掉某个账号的[调度]开关后, 它不进候选, 不被选号, 不 admit; 已买断的会话
 * 句柄不动; 开关落盘并在新进程里读回.
 *
 * 判据(可证伪): 把 candidateKeys 里的 this.schedulingEnabled(key) 那行删掉,
 * 本文件立刻变红 ---- 被关掉的账号会重新出现在 order 里.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sched-switch-'))
saveAccountUser(dir, { id: 'sa', email: 'sa@example.com', authToken: 'token-sa' })
saveAccountUser(dir, { id: 'sb', email: 'sb@example.com', authToken: 'token-sb' })

const config = loadConfig()
config.server.credentialsDir = dir
config.upstream.credentialsDir = dir
// 不可达: 只测选号与落盘, 不真连上游.
config.upstream.apiBase = 'http://127.0.0.1:1'
config.session.pollIntervalSec = 3600

const runtimes = new AccountRuntimes(config)
const MODEL = 'deepseek/deepseek-v4-flash'

// 默认: 两个账号都参与调度.
assert.equal(runtimes.schedulingEnabled('sa'), true, '默认必须参与调度')
assert.equal(runtimes.schedulingEnabled('sb'), true, '默认必须参与调度')
assert.deepEqual(
  runtimes.candidateKeys(MODEL).sort(),
  ['sa', 'sb'],
  '默认两个账号都进候选',
)

// 关掉 sa: 它必须从候选里彻底消失(不是排到最后).
runtimes.setSchedulingEnabled('sa', false)
assert.equal(runtimes.schedulingEnabled('sa'), false)
const afterOff = runtimes.candidateKeys(MODEL)
assert.ok(!afterOff.includes('sa'), `被关闭的账号不得进候选, got ${JSON.stringify(afterOff)}`)
assert.ok(afterOff.includes('sb'), '未关闭的账号仍要进候选')

// 控制台行必须带这个字段(前端开关的数据源), 且与选号判据同源.
const rowA = runtimes.list().find((x) => x.key === 'sa')
assert.equal(rowA.schedulingEnabled, false, '账号行必须带上调度开关状态')
assert.equal(runtimes.list().find((x) => x.key === 'sb').schedulingEnabled, true)

// 重新打开: 立刻回到候选.
runtimes.setSchedulingEnabled('sa', true)
assert.equal(runtimes.schedulingEnabled('sa'), true)
assert.ok(
  runtimes.candidateKeys(MODEL).includes('sa'),
  '重新打开后该账号必须回到候选',
)

// 落盘 + 重启读回: 关掉 sa 后 flush, 新的 AccountRuntimes 仍认为它是关闭的.
runtimes.setSchedulingEnabled('sa', false)
runtimes.flushState()
const stateFile = path.join(dir, 'account-state.json')
assert.ok(fs.existsSync(stateFile), '开关必须落盘到 account-state.json')
const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
assert.equal(
  persisted.accounts.sa.schedulingEnabled,
  false,
  '盘上必须记着 schedulingEnabled=false',
)

await runtimes.shutdown()

const restarted = new AccountRuntimes(config)
assert.equal(restarted.schedulingEnabled('sa'), false, '重启后开关必须仍然生效')
assert.ok(
  !restarted.candidateKeys(MODEL).includes('sa'),
  '重启后被关闭的账号仍不得进候选',
)
await restarted.shutdown()

fs.rmSync(dir, { recursive: true, force: true })
console.log('每账号调度开关验证通过')
