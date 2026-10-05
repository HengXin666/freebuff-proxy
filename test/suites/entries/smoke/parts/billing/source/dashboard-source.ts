/**
 * billing: 控制台源码扫描
 *
 * 断言对象是整棵 dashboard/, readDashboardSource 本体在 harness/helpers.ts.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { readDashboardSource } from '../../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// (FBGATE-CONSISTENCY) 控制台的"额度不足"判定必须与后端 freebucksFor 的两条
// 封号条件一致: 前端判"今日池跑完"而后端不判时, 控制台会显示"已用尽"却仍把
// 该账号送去调度. 这里用源码断言把两处钉在一起.
{
  // 断言对象是整棵 dashboard/ 目录: 判定搬去 dashboard/views/ 后, 盯单个文件的
  // 断言会读不到代码而正则不匹配, 静默通过. 扫目录 + 校验文件数下限可避免.
  const dashSrc = readDashboardSource()
  // freebucksFor 的实现位于 src/session/core/gate.ts(session-manager 只剩门面 re-export):
  // 断言必须指向真正持有这些判据的那一层.
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
  // 后端必须能区分"池跑完"与"余额不足", 两者的日志/错误码不同.
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
