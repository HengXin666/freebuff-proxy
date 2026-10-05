/**
 * refund: 日志窗口
 *
 * 缓冲只保留最近若干分钟导致的排查困难.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { loadConfig } from '../../../../../../../src/config.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ================================================================
   日志缓冲:容量可配 + 默认足够回溯一次故障
   ================================================================ */
{
  /**
   * 判据: 日志缓冲默认容量足够回溯一次故障(≥2000), 且可配置.
   *
   * - 日志不落盘(纯内存), 所以上限就是能回溯的全部深度.
   *
   * - 反向探针:把 config.js 的 ringCap 默认值改回 500 → 第一条断言必须红.
   */
  const c = loadConfig()
  assert.ok(
    Number.isInteger(c.logging.ringCap) && c.logging.ringCap >= 2000,
    `日志缓冲默认必须足够回溯一次故障（≥2000），got ${c.logging.ringCap}`,
  )
  // 可配置:ring_cap 覆盖要生效(KEY_MAP 接线正确)
  const yaml = 'logging:\n  level: info\n  ring_cap: 12345\n'
  const tmpYaml = path.join(os.tmpdir(), `fb-ringcap-${Date.now()}.yaml`)
  fs.writeFileSync(tmpYaml, yaml)
  const c2 = loadConfig(tmpYaml)
  assert.equal(c2.logging.ringCap, 12345, `ring_cap 配置必须生效，got ${c2.logging.ringCap}`)
  fs.rmSync(tmpYaml, { force: true })
  // 运行时也真的能改(configureLogBuffer 出口)
  const logMod = await import('../../../../../../../src/util/log.ts')
  assert.equal(logMod.configureLogBuffer(321), 321, 'configureLogBuffer 必须真的改到容量')
  logMod.configureLogBuffer(c.logging.ringCap)
}

/* ================================================================
   503 不得冷却账号(模型侧问题,不是账号故障)
   ================================================================ */
{
  /**
   * 判据: shouldSwitchAccountOnError(503, 'http_503') 必须为 false ----
   * 503 是模型侧问题, 不触发冷却换号.
   *
   * - 把它当 5xx 冷却会把唯一有余额的账号踢出池子.
   * - docs/reverse/07 的定因: 503 与请求/账号变量无关(三个价格档 / 多个模型 /
   * 多种身份组合全部 503).
   *
   * - 反向探针:把 if (status === 503) return false 删掉后本用例必须变红.
   */
  const { shouldSwitchAccountOnError } = await import('../../../../../../../src/proxy.ts')
  assert.equal(
    shouldSwitchAccountOnError(503, 'http_503'),
    false,
    '503 是模型侧问题，不得触发冷却换号（否则会把唯一有余额的账号踢出池子）',
  )
  // 对照:其它 5xx 仍应换号(上游瞬时故障,换号可能成功)
  assert.equal(shouldSwitchAccountOnError(502, 'http_502'), true, '502 仍应换号')
  assert.equal(shouldSwitchAccountOnError(500, 'http_500'), true, '500 仍应换号')
  // 对照:槽位类仍不换号(既有语义不变)
  assert.equal(shouldSwitchAccountOnError(409, 'purchase_capacity'), false, '槽位忙仍不换号')
}
