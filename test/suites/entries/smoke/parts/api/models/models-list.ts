/**
 * api: /v1/models 与鉴权
 *
 * 模型清单形状 / 鉴权分支 / /api/v1/me 直通 / model id 归一.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { requireModelId } from '../../../../../../../src/model.ts'
import { base } from '../../../harness/runtime.ts'
import assert from 'node:assert/strict'

// models auth + list
{
  const res = await fetch(`${base}/v1/models`)
  assert.equal(res.status, 401)
}
{
  const res = await fetch(`${base}/v1/models`, {
    headers: { authorization: 'Bearer sk-test' },
  })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.object, 'list')
  /**
   * - 目录未抓取时返回空清单 + notProbed,不再回落静态 catalog.
   *
   * 以前这里断言"至少有内置 60 条模型".但:
   * 1. 内置 catalog 是 2026-08 快照(13 行实时目录只命中 3 行),
   * 拿它当清单等于给下游一份错的模型表;
   * - 2. 服务改为零自动探测后,首访不再补抓目录.
   * 现在正确行为是:空 + notProbed,由用户点[一键刷新]拉取.
   * 清单本身的正确性由 test/verify-catalog-models.mjs 用真机目录钉住.
   */
  assert.equal(j.data.length, 0, '未探测时清单应为空（不回落陈旧静态表）')
  assert.equal(j.notProbed, true, '未探测时必须带 notProbed 让前端提示刷新')
}

// /api/v1 is not public
{
  const res = await fetch(`${base}/api/v1/me`, {
    headers: { authorization: 'Bearer sk-test' },
  })
  assert.equal(res.status, 404)
}

assert.equal(requireModelId('  openai/gpt-5.6-luna  '), 'openai/gpt-5.6-luna')
assert.equal(requireModelId(''), null)
