/**
 * 账号表[同邮箱]标注: 同邮箱多身份必须被标出, 唯一邮箱不得被标.
 *
 * 背景: 账号 key 用 Freebuff 用户 id, 所以同一邮箱用 GitHub / Google 各登录一次
 * 就是两个独立账号(同邮箱不互斥, 见 src/auth-store/files.ts). 列表里出现两行
 * 一模一样的邮箱时, 用户/运维会以为"账号重复了"或"被别的登录覆盖了".
 *
 * 判据(可证伪): 把 sections.ts 里传给 buildAccountRow 的同邮箱计数去掉
 * (退回 buildAccountRow(a, i)), 第一条断言即红; 把判据改成 >= 1, 第二条即红.
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
 * 渲染整张表, 返回 [邮箱, 该行账号列里的徽章数].
 * @param {any} rows 账号行
 * @returns {Array<[string, number]>} 逐行结果
 */
function emailCellBadges(rows: any) {
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
  ok(hits.filter((c) => c === 1).length === 2, `同邮箱的两个身份都必须挂徽章, got ${JSON.stringify(hits)}`)
  ok(hits.filter((c) => c === 0).length === 1, `唯一邮箱不得挂[同邮箱]徽章, got ${JSON.stringify(hits)}`)
}

// -- (2) 全部唯一邮箱: 一个徽章都不该有 -------------------------------------
{
  const hits = emailCellBadges([
    account({ key: 'a', email: 'a@example.com' }),
    account({ key: 'b', email: 'b@example.com' }),
  ])
  ok(hits.every((c) => c === 0), `唯一邮箱不得挂徽章, got ${JSON.stringify(hits)}`)
}

// -- (3) 三个同邮箱: 三行都要标 ---------------------------------------------
{
  const hits = emailCellBadges([
    account({ key: 'k1', email: 'tri@example.com' }),
    account({ key: 'k2', email: 'tri@example.com' }),
    account({ key: 'k3', email: 'tri@example.com' }),
  ])
  ok(
    hits.filter((c) => c === 1).length === 3,
    `同邮箱三个身份都要标出, got ${JSON.stringify(hits)}`,
  )
}

console.log(`同邮箱多身份标注 ${n} 条断言通过`)
