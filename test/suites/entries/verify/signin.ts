/**
 * 签到链路离线验证: 防抖判据 / 已签跳过 / 自动间隔, 全程零网络.
 *
 * 判据(可证伪):
 *   - 手动 18h 内第二次必须被拒(manualAllowed 返 false 且 remaining 正确);
 *   - 自动 25h 未到必须不触发(autoDue 返 false);
 *   - alreadySignedToday 对 todayCredited/todayUsed 任一为真都要返 true
 *     ---- 它是"不重复付费"的唯一闸门, 判错就是白花钱.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SignInStore, alreadySignedToday, MANUAL_COOLDOWN_HOURS, AUTO_INTERVAL_HOURS,
} from '../../../../src/web/store/signin/store.ts'

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-test-'))
const file = path.join(dir, 'signin.json')

// ── 1 初始态: 可签到, 自动到点 ────────────────────────────
{
  const s = new SignInStore(file)
  ok(s.manualAllowed().allowed === true, '首次必须允许手动签到')
  ok(s.autoDue() === true, '首次自动签到必须到点')
  ok(s.get().lastManualAt === null && s.get().lastAutoAt === null, '初始时间戳必须是 null')
}

// ── 2 手动防抖: 18h 内第二次被拒 ──────────────────────────
{
  const s = new SignInStore(file)
  const now = Date.now()
  s.markDone('manual', ['acct-a'], now)
  const justNow = s.manualAllowed(now + 60_000)
  ok(justNow.allowed === false, '1 分钟后必须仍在防抖窗口内')
  ok(justNow.remainMs > 0, '剩余时间必须为正')
  // 边界: 17.99h 仍拒, 18.01h 放行
  ok(s.manualAllowed(now + (MANUAL_COOLDOWN_HOURS - 0.01) * 3600_000).allowed === false, '17.99h 仍须拒')
  ok(s.manualAllowed(now + (MANUAL_COOLDOWN_HOURS + 0.01) * 3600_000).allowed === true, '18.01h 须放行')
}

// ── 3 落盘可重建: 换实例仍保留 ────────────────────────────
{
  const again = new SignInStore(file)
  ok(again.get().lastManualAt !== null, '防抖状态必须落盘(换实例仍在)')
  ok(again.get().perAccount['acct-a'] !== undefined, '逐账号记录必须落盘')
}

// ── 4 自动间隔 25h ───────────────────────────────────────
{
  const s = new SignInStore(file)
  const now = Date.now()
  s.markDone('auto', [], now)
  ok(s.autoDue(now + 60_000) === false, '自动签到 1 分钟后不得再触发')
  ok(s.autoDue(now + (AUTO_INTERVAL_HOURS - 0.01) * 3600_000) === false, '24.99h 仍不得触发')
  ok(s.autoDue(now + (AUTO_INTERVAL_HOURS + 0.01) * 3600_000) === true, '25.01h 须到点')
  ok(AUTO_INTERVAL_HOURS > 24, '自动间隔必须大于 24h(避开跨时区同日两次)')
}

// ── 5 alreadySignedToday: 不重复付费的唯一闸门 ────────────
{
  ok(alreadySignedToday({ todayCredited: true }) === true, 'todayCredited=true 必须判已签')
  ok(alreadySignedToday({ todayUsed: true }) === true, 'todayUsed=true 必须判已签')
  ok(alreadySignedToday({ todayCredited: false, todayUsed: false }) === false, '两者都 false 才可签')
  ok(alreadySignedToday(null) === false, '回执为 null 时不得判已签(由调用方按[状态未知]处理)')
  ok(alreadySignedToday({}) === false, '缺字段时不得判已签')
}

// ── 6 坏文件不拦启动 ─────────────────────────────────────
{
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, '{ this is not json')
  const s = new SignInStore(bad)
  ok(s.manualAllowed().allowed === true, '签到记录损坏时必须放行(最坏是允许提前签一次)')
  ok(s.get().lastManualAt === null, '损坏文件的残留字段不得被当有效值')
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(`签到防抖与判据验证通过(断言 ${n} 条)`)
