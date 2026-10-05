/**
 * billing: 账号视图与源码守卫
 *
 * 控制台源码里的账号视图判据; 源码级变量遮蔽守卫; 退款队列.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { SessionHandleStore } from '../../../../../../../src/session-handles.ts'
import { readDashboardSource } from '../../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ===========================================================================
// (CONSOLE-REFRESH) 控制台[局部刷新]必须是原地更新,不能"多出一条栏目"
//
// 实测故障:总览页点[局部刷新]会多出一条版面,旧内容还在.根因是刷新用
// $('.table-wrap') 选中了第一个分区的表,把"整张新表"替换进去 ---- 新表被塞
// 进第一个 <details>,旧分区原样留着.用户页更直接:把 view.innerHTML 清空重建.
// 这里用源码断言把两处钉死(这两个函数没法在 node 里直接跑,但结构是确定的).
{
  const dashSrc = readDashboardSource()
  assert.ok(
    /id: 'accounts-sections'/.test(dashSrc),
    '账号分区必须有个带 id 的专用容器（局部刷新按它整体替换）',
  )
  assert.ok(
    /\$\('#accounts-sections'\)/.test(dashSrc),
    '局部刷新必须定位到 accounts-sections，而不是第一个 .table-wrap',
  )
  assert.ok(
    !/\$\('\.table-wrap', \$\('#app'\)\)/.test(dashSrc),
    '不得再用 $(".table-wrap", …) 做刷新定位——那正是"多出一条栏目"的根因',
  )
  assert.ok(
    /function refreshUsersTable/.test(dashSrc) && !/onclick: \(\) => renderUsers\(view\)/.test(dashSrc),
    '用户页「局部刷新」必须走 refreshUsersTable，不能 renderUsers(view) 重建整页',
  )
  // SVG 图标必须补自闭合斜杠:手写 <circle ...> 会吞掉相邻节点(同一类渲染错乱)
  assert.ok(
    /function normalizeSvgPaths/.test(dashSrc) && /normalizeSvgPaths\(paths\)/.test(dashSrc),
    'icon() 必须对 SVG 片段做自闭合归一，否则相邻节点会被解析器吞掉',
  )
}


// (SRC-GUARD) 源码级防回归:变量遮蔽与被改名的残留引用.
//
// 真实事故:src/web/api.ts 的 handle() 里 const path = url.pathname 把
// import path from 'node:path' 整个遮蔽,/api/system/data-status 里
// path.basename() 变 "is not a function" → 该接口一路 500 到用户手里;
// 修名后又在同文件漏改一行(No route for ${method} ${path})→ ReferenceError.
// 这两种都只在"运行时真的调到那一行"才炸,静态自检必须兜住.
{
  const srcFiles = [
    '../../../../../../../src/web/api.ts',
    '../../../../../../../src/proxy.ts',
    '../../../../../../../src/server.ts',
  ]
  for (const rel of srcFiles) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
    const name = rel.replace('../', '')
    const usesNodePath = /^\s*import\s+(?:\*\s+as\s+)?path\s*,?\s*(?:from\s+)?['"]node:path['"]/m.test(src)
    // ① 不得在局部重新声明 path(会遮蔽 node:path 模块)
    assert.ok(
      !/\bconst\s+path\s*=/.test(src),
      `${name}: 不得用 const path = ... 遮蔽 node:path 模块（曾导致 path.basename is not a function）`,
    )
    // ② 路由变量必须叫 route/pathname,不得再出现 path === '/...' 这种旧命名
    assert.ok(
      !/\bpath\s*===\s*['"]\//.test(src),
      `${name}: 路由变量必须叫 route/pathname，不得沿用已废弃的 path`,
    )
    // ③ 模板串里不得再引用裸 path:改名只改一半就是这个形态(ReferenceError)
    assert.ok(
      !/\$\{[^}]*\bpath\b[^}]*\}/.test(src),
      `${name}: 模板串里引用了裸 path（改名漏改一行 → ReferenceError）`,
    )
    // ③ 用了 node:path 就必须真的 import 了它
    if (/\bpath\.(?:basename|join|resolve|dirname|extname|sep)\b/.test(src)) {
      assert.ok(usesNodePath, `${name}: 用了 path.* 就必须 import path from 'node:path'`)
    }
  }
}


// (REFUND-QUEUE) 待结算退款队列:这是钱,行为必须钉死.
//
// 语义(见 .agents/notes/implemented/bug-fix/2026-09-13-refund-reversed.md):
//   - 上游回 freebucksRefundPending => 结算未完成,入队并持续重放 DELETE 追问;
//   - 只有拿到终态回执(含 refund: 0)才允许出队;
//   - 重放失败 / 账号没了 / 仍 pending,一律保留记录----绝不静默丢弃那笔预扣.
{
  const refundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-refund-'))
  const refundFile = path.join(refundDir, 'sessions.json')
  const store = new SessionHandleStore(refundFile)
  try {
    store.notePendingRefund('k1', 'inst-1', 'm/x')
    assert.equal(store.listPendingRefunds().length, 1, 'pending 应入队')
    assert.equal(
      JSON.parse(fs.readFileSync(refundFile, 'utf8')).pendingRefunds.length,
      1,
      'pending 必须落盘——否则进程重启就再也追不回那笔预扣',
    )

    let body = { status: 'ended', freebucksRefundPending: true }
    const upstream = { freebuffSession: async () => body }
    let r = await store.sweepPendingRefunds(() => upstream)
    assert.equal(r.pending, 1, '仍 pending 时应计入 pending')
    assert.equal(store.listPendingRefunds().length, 1, '仍 pending 时绝不出队')

    // 终态退 0:也是终态,必须出队
    body = { status: 'ended', freebucksRefund: 0 }
    let settledInfo = null
    r = await store.sweepPendingRefunds(() => upstream, {
      onSettled: (i) => { settledInfo = i },
    })
    assert.equal(r.settled, 1, '退 0 是终态')
    assert.equal(store.listPendingRefunds().length, 0, 'settled 应出队')
    assert.equal(settledInfo.refund, 0)

    // 非终态非 pending:保留,绝不当作退 0
    store.notePendingRefund('k2', 'inst-2', 'm/y')
    body = { status: 'active' }
    r = await store.sweepPendingRefunds(() => upstream)
    assert.equal(r.pending, 1, '既非终态也非 pending 时必须保留')
    assert.equal(store.listPendingRefunds().length, 1)

    // 账号已删/凭据变更:跳过但保留
    r = await store.sweepPendingRefunds(() => null)
    assert.equal(r.skipped, 1)
    assert.equal(store.listPendingRefunds().length, 1, '无凭据也不能丢记录')

    // 重放失败:保留
    const boom = { freebuffSession: async () => { throw new Error('ECONNRESET') } }
    r = await store.sweepPendingRefunds(() => boom)
    assert.equal(r.failed, 1)
    assert.equal(store.listPendingRefunds().length, 1, '重放失败也必须保留')

    // 重启后从盘里恢复(这是[跨重启追问]的全部依据)
    store.notePendingRefund('k3', 'inst-3', 'm/z')
    const reloaded = new SessionHandleStore(refundFile)
    assert.equal(
      reloaded.listPendingRefunds().length,
      2,
      '重启后待结算退款队列必须还在',
    )

    // drop 事件同时清 orphan 与 pending(钱已回到手)
    reloaded.handleEvent({ type: 'drop', key: 'k3', instanceId: 'inst-3' })
    assert.equal(reloaded.listPendingRefunds().length, 1)
  } finally {
    fs.rmSync(refundDir, { recursive: true, force: true })
  }
}
