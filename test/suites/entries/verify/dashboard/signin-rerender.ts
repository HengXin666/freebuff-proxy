/**
 * 一键签到的[重复渲染不得堆积]回归 ---- 钉死 2026-10-06 的实测缺陷.
 *
 * ## 缺陷原貌(用户在真机上看到的现象)
 *
 * 点一次一键签到, 按钮那块就多一条成本警告条; 连点会无上限累积.
 *
 * 根因在 dashboard/views/overview/accounts/signin/run.ts: 按钮被包进
 * .signin-wrap 之后, 回读时用 btn.parentElement 反推容器 ---- 拿到的是
 * 内层 wrap 而不是真正的 slot, 于是 renderSignInButton(wrap) 把容器层层
 * 套娃(实测连点 3 次 = 3 层 .signin-wrap 嵌套 + 3 条警告条).
 *
 * ## 为什么原有防线全漏
 *
 * smoke-frontend 用的是[万能 Proxy 桩]: 任何属性访问都返回它自己, 能抓 TDZ,
 * 但它不记账 ---- 数不出节点个数, 所以[多了一个节点]这类缺陷它天然看不见.
 * 本文件用 test/helpers/dom-stub.ts 的真记账桩补上这一段.
 *
 * 判据(可证伪): 反复渲染 N 次后, 容器内警告条必须恒为 1 条, 按钮恒为 1 个.
 * 把 runSignIn 的 slot 参数改回 btn.parentElement, 本文件立刻变红.
 */
import assert from 'node:assert/strict'
import { installDomStub } from '../../../../helpers/dom-stub.ts'

const { document, body } = installDomStub()

// 必须在装桩之后再 import 组件 ---- 它们模块级就引用 document.
const { renderSignInButton, runSignIn } = await import(
  '../../../../../dashboard/views/overview/accounts/signin/run.ts'
)

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

/**
 * 造一个容器并渲染一次, 返回容器与其中的按钮.
 *
 * @returns {Promise<any>} { slot, btn }
 */
async function mount() {
  const slot = document.createElement('span')
  slot.id = 'signin-slot'
  body.append(slot)
  await renderSignInButton(slot)
  const btn = slot.querySelector('#signin-btn')
  ok(!!btn, '渲染后必须存在 #signin-btn')
  return { slot, btn }
}

/** 数容器里的警告条. */
const notices = (slot: any) => slot.querySelectorAll('.signin-cost-notice').length
/** 数容器里的按钮. */
const buttons = (slot: any) => slot.querySelectorAll('#signin-btn').length

// ── 1 首次渲染: 恰好一条警告 + 一个按钮 ────────────────────────────
{
  const { slot } = await mount()
  ok(notices(slot) === 1, `首次渲染警告条应为 1, got ${notices(slot)}`)
  ok(buttons(slot) === 1, `首次渲染按钮应为 1, got ${buttons(slot)}`)
}

// ── 2 反复渲染不得堆积(本文件的核心判据)─────────────────────────
{
  const { slot } = await mount()
  for (let i = 0; i < 5; i++) await renderSignInButton(slot)
  ok(notices(slot) === 1, `重渲染 5 次后警告条仍应为 1, got ${notices(slot)}`)
  ok(buttons(slot) === 1, `重渲染 5 次后按钮仍应为 1, got ${buttons(slot)}`)
  // 容器自身不该被套娃: .signin-wrap 只能有一层.
  ok(
    slot.querySelectorAll('.signin-wrap').length === 1,
    `容器不应被层层套娃, .signin-wrap got ${slot.querySelectorAll('.signin-wrap').length}`,
  )
}

// ── 3 走真实的点击路径(这才是用户复现的那条链)─────────────────────
// 缺陷是在[点击 -> 回读 -> 重渲染]这条链上, 只测 renderSignInButton 不够:
// 必须真的触发 handler, 否则测不到 slot 传没传对.
{
  const { slot, btn } = await mount()
  // 直接调 runSignIn 并把 slot 传进去(与组件里的接线一致).
  // runSignIn 会先弹二次确认并 await 用户选择, 所以这里必须真的把[确认]
  // 点掉 ---- 否则测试会永远挂着(这也顺带验证了确认框真的可被操作).
  for (let i = 0; i < 3; i++) {
    const p = runSignIn(btn, { impact: { alive: 1, accounts: 1 } }, slot)
    const okBtn = body.querySelector('#signin-confirm-ok')
    ok(!!okBtn, '第二次确认框必须存在(可被点击)')
    await okBtn.dispatch('click')
    await p
  }
  ok(notices(slot) === 1, `点击 3 次后警告条仍应为 1, got ${notices(slot)}`)
  ok(buttons(slot) === 1, `点击 3 次后按钮仍应为 1, got ${buttons(slot)}`)
}

// ── 4 未传 slot 时不得把节点挂错地方 ───────────────────────────────
// runSignIn 的 slot 是可选的(第三个参数). 不传时只该更新按钮自己, 不该
// 凭空往 body 上堆节点 ---- 缺省分支也要可断言, 否则它会变成下一次的坑.
{
  body.children = []
  const slot = document.createElement('span')
  slot.id = 'signin-slot'
  body.append(slot)
  await renderSignInButton(slot)
  const before = body.countElements()
  const btn = slot.querySelector('#signin-btn')
  // 同样要把确认框点掉 ---- 不点的话 runSignIn 会一直 await.
  const p = runSignIn(btn, undefined, undefined)
  const okBtn = body.querySelector('#signin-confirm-ok')
  ok(!!okBtn, '缺省 slot 分支也必须先过二次确认')
  await okBtn.dispatch('click')
  await p
  ok(
    body.countElements() === before,
    `不传 slot 时不得新增节点, before=${before} after=${body.countElements()}`,
  )
}

console.log(`签到组件重复渲染不得堆积验证通过(断言 ${n} 条)`)
