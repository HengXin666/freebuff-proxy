/**
 * 账号表[同邮箱]标注: 同邮箱多身份必须被标出, 唯一邮箱不得被标.
 *
 * 背景: 账号 key 用 Freebuff 用户 id, 所以同一邮箱用 GitHub / Google 各登录一次
 * 就是两个独立账号(同邮箱不互斥, 见 src/auth-store/files.ts). 列表里出现两行
 * 一模一样的邮箱时, 用户/运维会以为"账号重复了"或"被别的登录覆盖了".
 *
 * 判据(可证伪): 省略 sections.ts 传给 buildAccountRow 的 sameEmailCount,
 * 混合邮箱的精确徽章位置断言失败; 把 > 1 改成 >= 1, 唯一邮箱零徽章断言失败,
 * 混合邮箱的精确徽章位置断言也会捕获该变异.
 *
 * 只做结构断言: DOM 桩不记账文本, 所以按"账号列里有没有 SPAN.badge"判定,
 * 不按文字内容判定.
 */
import assert from 'node:assert/strict'
import { installDomStub } from '../../../../../helpers/dom-stub.ts'

const { body } = installDomStub()

const { buildAccountsTable } = await import(
  '../../../../../../dashboard/views/overview/accounts/sections.ts'
)
const { state } = await import('../../../../../../dashboard/lib/state.ts')
state.me = { username: 'admin', role: 'admin' }

/** 最小账号行(只有分区/标注关心的字段). */
const account = (over: any) => ({
  key: over.key,
  email: over.email,
  session: null,
  quota: null,
  freebucks: null,
  requests: 2,
  inFlight: 0,
  concurrency: 1,
  ...over,
})

const hasClass = (n: any, cls: string) =>
  String(n.className || '').split(/\s+/).includes(cls)

/**
 * 渲染整张表, 返回逐行账号列里的徽章数.
 * @param {any} rows 账号行
 * @returns {number[]} 逐行徽章数
 */
function emailCellBadges(rows: any): number[] {
  body.children.length = 0
  body.append(buildAccountsTable(rows))
  const trs = body.walk((n: any) => n.tagName === 'TR' && hasClass(n, 'row-in'))
  return trs.map((tr: any) => {
    // 账号列是行里的第一个 td; 徽章只可能是它的直接子节点.
    const td = tr.children[0]
    const badges = (td?.children || []).filter((c: any) => hasClass(c, 'badge'))
    return badges.length
  })
}

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

// -- (1) 同邮箱两个身份: 两行都要被标出 -------------------------------------
{
  const hits = emailCellBadges([
    account({ key: 'github-u1', email: 'same@example.com' }),
    account({ key: 'google-u1', email: 'same@example.com' }),
    account({ key: 'solo', email: 'solo@example.com' }),
  ])
  ok(hits.length === 3, `三行都应渲染出来, got ${hits.length}`)
  assert.deepEqual(hits, [1, 1, 0], `逐行徽章数应为 [1,1,0], got ${JSON.stringify(hits)}`)
  n += 1
}

// -- (2) 全部唯一邮箱: 一个徽章都不该有 -------------------------------------
{
  const hits = emailCellBadges([
    account({ key: 'a', email: 'a@example.com' }),
    account({ key: 'b', email: 'b@example.com' }),
  ])
  assert.deepEqual(hits, [0, 0], `逐行徽章数应为 [0,0], got ${JSON.stringify(hits)}`)
  n += 1
}

// -- (3) 三个同邮箱: 三行都要标 ---------------------------------------------
{
  const hits = emailCellBadges([
    account({ key: 'k1', email: 'tri@example.com' }),
    account({ key: 'k2', email: 'tri@example.com' }),
    account({ key: 'k3', email: 'tri@example.com' }),
  ])
  assert.deepEqual(hits, [1, 1, 1], `逐行徽章数应为 [1,1,1], got ${JSON.stringify(hits)}`)
  n += 1
}

console.log(`同邮箱多身份标注 ${n} 条断言通过`)
