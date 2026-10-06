/**
 * 账号表[调度]开关: 结构 + 每行一个 + 状态与后端同源(用真记账 DOM 桩).
 *
 * 判据(可证伪): 把 row.ts 里 schedulingCell 的勾选判据由 a.schedulingEnabled
 * 改成恒 true, 或把它从行里去掉, 本文件即红.
 */
import assert from 'node:assert/strict'
import { installDomStub } from '../../../../helpers/dom-stub.ts'

const { document, body } = installDomStub()
// 开关的 onchange 走 need(name) 取实现, 装配层在浏览器里注册; 测试里先登记一个探针.
const { registerHooks } = await import('../../../../../dashboard/lib/boot/hooks.ts')
const saved: any[] = []
registerHooks({
  setAccountScheduling: async (key: any, enabled: any) => saved.push({ key, enabled }),
})

const { buildAccountRow } = await import(
  '../../../../../dashboard/views/overview/accounts/row.ts'
)
const { groupAccounts } = await import(
  '../../../../../dashboard/views/overview/accounts/sections.ts'
)
const { state } = await import('../../../../../dashboard/lib/state.ts')

state.me = { username: 'admin', role: 'admin' }

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

/** 一个最小账号行(只有本用例关心的字段). */
const account = (over: any) => ({
  key: over.key,
  email: over.email || over.key + '@example.com',
  session: null,
  quota: null,
  freebucks: null,
  requests: 0,
  inFlight: 0,
  concurrency: 1,
  ...over,
})

const row = (over: any) => {
  body.children.length = 0
  const node = buildAccountRow(account(over), 0)
  body.append(node)
  return node
}

/** 行里的开关(桩只支持单类选择器, 故按 data-key 过滤). */
const switchOf = (node: any, key: string) =>
  node.querySelectorAll('.switch-input').find((i: any) => i.attrs['data-key'] === key)

// -- (1) 每行都有一个开关, 默认(缺字段)是开 ------------------------------
{
  const on = switchOf(row({ key: 'a' }), 'a')
  ok(!!on, '每个账号行必须有一个 [调度] 开关')
  ok(on.attrs.checked === '', '缺字段(老后端)必须按[参与调度]渲染 = 勾选')
  ok(on.handlers.change && on.handlers.change.length === 1, '开关必须挂上 change 处理器')
}

// -- (2) 关闭的账号渲染成未勾选 -------------------------------------------
{
  ok(switchOf(row({ key: 'b', schedulingEnabled: false }), 'b').attrs.checked === undefined,
    'schedulingEnabled=false 必须渲染成未勾选')
  ok(switchOf(row({ key: 'c', schedulingEnabled: true }), 'c').attrs.checked === '',
    'schedulingEnabled=true 必须渲染成勾选')
}

// -- (3) 点击后真的走保存链, 且带的是目标状态 ------------------------------
{
  saved.length = 0
  const node = row({ key: 'd' })
  const box = switchOf(node, 'd')
  box.checked = false
  await box.dispatch('change')
  ok(saved.length === 1, `点击必须触发保存(否则界面点了不生效), got ${saved.length}`)
  ok(saved[0].key === 'd' && saved[0].enabled === false,
    `保存必须带 key 与目标状态, got ${JSON.stringify(saved[0])}`)
}

// -- (3b) 无文字标签时, 状态必须仍可被读出(aria-label + tooltip) -----------
{
  const dummy = row({ key: 'x' })
  const box = switchOf(dummy, 'x')
  ok(box.attrs['aria-label'] && String(box.attrs['aria-label']).length > 0,
    '开关必须带 aria-label(去掉了可见文字, 无障碍名不能一起丢)')
  ok(box.attrs.checked === '', '开启态由 checked 表达')
  const label = box.parentNode
  ok(String(label.attrs.title || '').length > 0, 'label 上的 tooltip 必须保留')
}

// -- (4) 普通用户只读: 开关禁用但仍渲染出状态 ------------------------------
{
  state.me = { username: 'u', role: 'user' }
  const ro = switchOf(row({ key: 'e', schedulingEnabled: false }), 'e')
  ok(ro.attrs.disabled === '', '非管理员必须禁用开关')
  ok(ro.attrs.checked === undefined, '禁用也必须是未勾选(false 态不能显示成开)')
  state.me = { username: 'admin', role: 'admin' }
}

// -- (5) 关掉调度的账号排在所在分区末尾(仍在原分区) ------------------------
{
  const rows = [
    account({ key: 'off1', schedulingEnabled: false, requests: 5 }),
    account({ key: 'on1', requests: 1 }),
    account({ key: 'off2', schedulingEnabled: false, requests: 9 }),
    account({ key: 'on2', requests: 2 }),
  ]
  const groups: any = groupAccounts(rows)
  // 四个号都[被选号过] => 全落在[正在调度]分区.
  const active = groups.get('active') || []
  ok(active.length === 4, `前置: 四个号都应在同一分区, got ${active.length}`)
  const tail = active.slice(-2).map((a: any) => a.key).sort()
  ok(tail.join(',') === 'off1,off2',
    `被关闭的账号必须排在分区末尾(仍在原分区), got ${active.map((a: any) => a.key).join(',')}`)
}

console.log(`账号调度开关结构验证通过(断言 ${n} 条)`)
