/**
 * 控制台首屏必须拿到[上次缓存的账号状态] ---- 冷启动回归.
 *
 * 背景(2026-10-06 用户报): 首次打开网页拿不到账号信息, 必须手动刷新一次才显示.
 *
 * 根因: 控制台账号表原先用 this.byKey.get(key) 读 runtime ---- 那是裸读 Map,
 * 绕过了懒创建与账本回灌. 而 freebucks / quota / lastProbe 只挂在[创建出来的]
 * runtime 上(由 _hydrateRuntime 从 /data/account-state.json 回灌). 服务重启后
 * byKey 是空的, 首屏于是把这三个字段全读成 null; 手动刷新那一跳会走 get()
 * 建出 runtime, 状态才出现.
 *
 * 判据(可证伪): 不调用任何预热入口, 直接 new AccountRuntimes(config) 然后 list();
 * 账本里有的 freebucks / quota / lastProbe 必须出现在行上.
 * 反向探针(实测过): 把 account-list.ts 的 runtimeFor 改回 self.byKey.get ---- 本
 * 文件立刻变红(freebucks=null, quota.byModel 键数=0).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../../../../../src/config.ts'
import { AccountRuntimes } from '../../../../../src/app-context.ts'

let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n += 1
}

const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..', '..')
const config = loadConfig()
const rt = new AccountRuntimes(config)
const keys = rt.allKeys()

if (!keys.length) {
  // 无账号时跳过: 这条判据的前提是[账本里有东西可回灌].
  console.log('冷启动账号状态验证跳过(本机无账号)')
  process.exit(0)
}

const ledger = rt.accountState.account(keys[0])
ok(ledger && typeof ledger === 'object', '账本里必须有首个账号的记录')

// 此刻 byKey 必须是冷的 ---- 否则这条判据测不到真实首屏那种时刻.
ok(rt.byKey.size === 0, `构造后 byKey 应为空(冷启动), got ${rt.byKey.size}`)

const rows = rt.list()
ok(rows.length === keys.length, `list() 行数必须与账号数一致, got ${rows.length}`)

/** 账本某字段存在时, 行上必须也拿得到(这就是"上次缓存的状态"). */
const carried = (field, got, have) => {
  if (!have) return
  ok(
    got != null,
    `账本里有 ${field}, 首屏行上也必须拿得到(冷启动丢状态 = 用户要手动刷新)`,
  )
}

carried('freebucks', rows[0].freebucks, !!ledger.freebucks)
carried('quota', rows[0].quota, !!ledger.quota)
carried('lastProbe', rows[0].lastProbe, !!ledger.lastProbe)

if (ledger.quota?.byModel) {
  ok(
    Object.keys(rows[0].quota?.byModel || {}).length > 0,
    '账本里有 quota.byModel, 首屏行上必须带出模型额度明细',
  )
}

// 回灌只读账本, 绝不发上游请求 ---- 与[零自动探测]不冲突.
ok(rt.byKey.size > 0, 'list() 之后 runtime 应已按需建立并完成回灌')

// 反例: runtimeFor 对不存在的 key 必须返回 null, 不抛(控制台靠它容错渲染).
ok(rt.runtimeFor('no-such-account-key') === null, 'runtimeFor 不存在的账号必须返回 null 而不是抛')
ok(rt.runtimeFor('') === null, 'runtimeFor 空 key 必须返回 null')

console.log(`控制台首屏冷启动账号状态验证通过(断言 ${n} 条)`)
void fs
