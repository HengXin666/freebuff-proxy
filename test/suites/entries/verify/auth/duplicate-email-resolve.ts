/**
 * 凭据解析: 同邮箱多身份必须给出确定结果, 不得因[命中多个]而返回 null.
 *
 * 背景: 账号 key 用 Freebuff 用户 id, 所以同一邮箱用 GitHub / Google 各登录一次
 * 是两个独立账号(同邮箱不互斥). 旧行为是[兜底扫描命中多个 -> 返回 null],
 * 调用方(转发链路)于是报 401 Account not found ---- 账号明明在控制台列表里,
 * 却一个都用不了, 用户看到的是[账号被隐藏/被覆盖了].
 *
 * 本套件不碰网络与 mock: 只测文件级的解析契约.
 * 判据(可证伪): 把 src/auth-store/accounts.ts 里的确定化排序改回
 * [命中多个即 return null] -> 本文件第 (3) 组断言即红.
 */
import { listAccounts, readAccountUser, saveAccountUser } from '../../../../../src/auth-store.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-dup-resolve-'))
try {
  saveAccountUser(dir, { id: 'github-u1', email: 'Same@Example.com', authToken: 't-gh' })
  saveAccountUser(dir, { id: 'google-u1', email: 'same@example.com', authToken: 't-go' })

  // -- (1) 同邮箱两个身份各自独立落盘 ---------------------------------------
  const files = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()
  ok(
    files.join(',') === 'github-u1.json,google-u1.json',
    '同邮箱不同 id 必须各存一份, got ' + JSON.stringify(files),
  )

  // -- (2) 按 id 读必须精确命中, 不得串到同邮箱的另一个 ----------------------
  const gh = readAccountUser(dir, 'github-u1')
  const go = readAccountUser(dir, 'google-u1')
  ok(!!gh, '同邮箱并存时按 id 读取不得返回 null(旧行为即此, 表现为 401)')
  ok(!!go, '同邮箱并存时按 id 读取不得返回 null(旧行为即此, 表现为 401)')
  ok(gh.id === 'github-u1' && gh.authToken === 't-gh', '精确 id 命中不得串号, got ' + gh?.id)
  ok(go.id === 'google-u1' && go.authToken === 't-go', '精确 id 命中不得串号, got ' + go?.id)

  // -- (3) 只能靠兜底扫描命中(目录里没有 email.json)时必须有确定结果 --------
  // 这条才是被修的那条路径: 直接文件不存在 -> 扫描目录 -> 命中两个同邮箱文件.
  // 旧行为在这里返回 null, 调用方于是 401(账号在列表里却用不了).
  const byEmail = readAccountUser(dir, 'same@example.com')
  ok(!!byEmail, '按邮箱兜底扫描命中多个时必须给出确定结果(旧行为: null -> 401)')
  ok(
    (byEmail?.id ?? '') === 'github-u1' || (byEmail?.id ?? '') === 'google-u1',
    '必须挑到其中一个真实身份, got ' + byEmail?.id,
  )

  // -- (3b) 重复读必须稳定(不依赖 readdir 顺序) ------------------------------
  const first = readAccountUser(dir, 'same@example.com')?.id ?? null
  for (let i = 0; i < 5; i++) {
    ok(
      (readAccountUser(dir, 'same@example.com')?.id ?? null) === first,
      '按邮箱解析必须确定(同输入同输出), 否则每次重启挑到不同的号',
    )
    ok(
      readAccountUser(dir, 'google-u1')?.id === 'google-u1',
      '按 id 解析在重复读之间必须稳定',
    )
  }

  // -- (4) 列表仍是两行(不因解析确定化而合并身份) --------------------------
  const rows = listAccounts(dir)
  ok(rows.length === 2, '同邮箱两个身份都必须在列表里, got ' + rows.length)
  ok(
    rows.filter((r: any) => r.email === 'same@example.com').length === 2,
    '两行都属于同一邮箱(控制台据此挂[同邮箱]标注)',
  )

  // -- (4b) 平局排序必须按账号 key, 不按文件名 ------------------------------
  // 命中后 readAccountUser 会把文件重命名成 <key>.json; 若平局按文件名排,
  // 同一个邮箱查询就会在重命名前后挑到不同身份(评审指出).
  // 判据(可证伪): 排序改回 a.full.localeCompare(b.full) -> 断言红.
  {
    const tieDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-dup-tie-'))
    try {
      // 故意让文件名顺序与 key 顺序相反: bbbb.json=id-aaa, aaaa.json=id-bbb
      fs.writeFileSync(path.join(tieDir, 'bbbb.json'),
        JSON.stringify({ id: 'id-aaa', email: 'tie@example.com', authToken: 't1' }))
      fs.writeFileSync(path.join(tieDir, 'aaaa.json'),
        JSON.stringify({ id: 'id-bbb', email: 'tie@example.com', authToken: 't2' }))
      const pick1 = readAccountUser(tieDir, 'tie@example.com')?.id ?? null
      const pick2 = readAccountUser(tieDir, 'tie@example.com')?.id ?? null
      const pick3 = readAccountUser(tieDir, 'tie@example.com')?.id ?? null
      ok(pick1 === 'id-aaa', '平局必须按账号 key 取最小的那个, got ' + pick1)
      ok(pick1 === pick2 && pick2 === pick3,
        '同一个邮箱重复查询必须稳定(重命名前后不得换身份), got ' + [pick1, pick2, pick3].join(','))
      // 另一个身份仍能按自己的 id 精确读回
      ok(readAccountUser(tieDir, 'id-bbb')?.id === 'id-bbb',
        '同邮箱的另一个身份必须仍可按 id 读到')
      // 评审指出: 命中后的重命名会把一个候选从[小写/邮箱命中]提升为[精确命中],
      // 若平局不优先取[已在目标名上]的那个, 上面的 pick 会在这一轮之后换身份.
      const after = readAccountUser(tieDir, 'tie@example.com')?.id ?? null
      ok(after === pick1,
        '重命名之后再按邮箱查必须仍是同一个身份, got ' + after + ' 期望 ' + pick1)
      ok(readAccountUser(tieDir, 'id-aaa')?.id === 'id-aaa',
        '重命名后的精确命中必须仍落在被选中的那个身份上')
    } finally {
      fs.rmSync(tieDir, { recursive: true, force: true })
    }
  }

  // -- (5) 无 id 的旧文件与有 id 的文件同邮箱: 也必须有确定结果 --------------
  saveAccountUser(dir, { email: 'legacy@example.com', authToken: 't-legacy' })
  saveAccountUser(dir, { id: 'id-new', email: 'legacy@example.com', authToken: 't-new' })
  const resolved = readAccountUser(dir, 'id-new')
  ok(resolved?.id === 'id-new', '有 id 的目标必须精确命中, got ' + resolved?.id)
  ok(!!readAccountUser(dir, 'legacy@example.com'), '按邮箱读旧文件不得返回 null')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('凭据解析(同邮箱多身份) ' + n + ' 条断言通过')
