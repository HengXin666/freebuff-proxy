/**
 * billing: 控制台源码扫描
 *
 * 断言对象是整棵 dashboard/ 而不是某个文件, 避免静默失效. readDashboardSource 本体在 harness/helpers.ts.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { readDashboardSource } from '../../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// (FBGATE-CONSISTENCY) 控制台的"额度不足"判定必须与后端 freebucksFor 的两条
// 封号条件一致 ---- 曾经前端判了"今日池跑完"而后端没判,导致控制台显示"已用尽"
// 却仍被送去调度.这里用源码断言把两处钉在一起,防止再次漂移.
{
  // 断言对象是整棵 dashboard/** 而不是某个具体文件:这条判据经历过一次
  // 静默失效 ---- 前端拆成 views/lib 后判定搬去了
  // dashboard/views/overview/accounts/sections.ts,而断言仍盯 app.js,
  // 于是"控制台保留了判定"这件事再也没被验证过(读不到文件 → 正则不匹配
  // → 但它只在被破坏时才红,平时是假绿).改成扫目录 + 校验被扫文件数下限,
  // 既保住判据强度,又不会因为下一次搬家再次失效.
  const dashSrc = readDashboardSource()
  // freebucksFor 的实现已随 session-manager 拆分搬进 src/session/core/gate.ts
  // (session-manager.js 只剩薄门面 re-export)---- 断言必须指向真正持有那些
  // 判据的那一层, 否则读到的文件里没有那段代码, 正则不匹配 → 静默假绿.
  const smSrc = fs.readFileSync(
    new URL('../../../../../../../src/session/core/gate.ts', import.meta.url),
    'utf8',
  )
  assert.ok(
    /daily\.remaining\)\s*<=\s*0[\s\S]{0,80}daily\.limit\)\s*>\s*0/.test(dashSrc),
    '控制台必须保留"今日池跑完"的判定（daily.remaining <= 0 且 limit > 0）',
  )
  assert.ok(
    /dailyRemaining\s*<=\s*0/.test(smSrc),
    '后端 freebucksFor 必须判定"今日池跑完"——否则与控制的分类口径漂移',
  )
  assert.ok(
    /shortOnBalance/.test(smSrc),
    '后端 freebucksFor 必须判定"余额买不起"',
  )
  // 后端必须能区分"池跑完"与"余额不足",否则日志/错误信息会误导排查方向
  assert.ok(
    /daily_exhausted/.test(smSrc),
    '后端必须区分出 daily_exhausted（否则排查时只看到"余额不够"）',
  )
  assert.ok(
    /balance_shortfall/.test(smSrc),
    '后端必须区分出 balance_shortfall',
  )
  // 前端必须与后端一致地覆盖"池跑完"这条,不能只判余额
  assert.ok(
    /dailyGone/.test(dashSrc),
    '控制台必须保留 dailyGone（今日池跑完）判定',
  )
}
