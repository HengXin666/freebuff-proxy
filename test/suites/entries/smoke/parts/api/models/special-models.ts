/**
 * api: 特殊模型世代绑定
 *
 * luna 系必须走 base3 世代开场.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { agentFallbackForModel, agentIdForModel, buildModelsListResponse } from '../../../../../../../src/model.ts'
import assert from 'node:assert/strict'

// Official Freebuff Web-only/god-only models must use their model-specific
// roots; otherwise the upstream rejects the generic base2-free agent.
const verifiedSpecialModels = [
  {
    id: 'crof/kimi-k3-eco',
    base2: 'base2-free-kimi-k3-eco',
    base3: 'base3-free-kimi-k3-eco',
  },
  {
    id: 'openai/gpt-5.6-luna-es',
    base2: 'base2-free-luna-es',
    base3: 'base3-free-luna-es',
    // luna 系强制 base3(风控保护):agentIdForModel 直接返回 base3,不再用 base2
    forcedBase3: true,
  },
  {
    id: 'meta/muse-spark-1.2-contributor',
    base2: 'base2-free-muse-spark',
    base3: 'base3-free-muse-spark',
  },
  {
    id: 'z-ai/glm-5.3-flash',
    base2: 'base2-free-glm-5-3-flash',
    base3: 'base3-free-glm-5-3-flash',
  },
  {
    id: 'stealth/ox-alpha',
    base2: 'base2-free-ox-alpha',
    base3: 'base3-free-ox-alpha',
  },
  {
    id: 'z-ai/glm-5.2',
    base2: 'base2-free-glm',
    base3: 'base3-free-glm',
  },
]
for (const model of verifiedSpecialModels) {
  // luna 系强制 base3:主 agent 直接是 base3(风控保护,绝不用 base2)
  const expected = model.forcedBase3 ? model.base3 : model.base2
  assert.equal(agentIdForModel(model.id), expected)
  assert.equal(agentFallbackForModel(model.id), model.base3)
  const listed = buildModelsListResponse().data.find((row) => row.id === model.id)
  assert.ok(listed, `${model.id} should be present in /v1/models`)
}
