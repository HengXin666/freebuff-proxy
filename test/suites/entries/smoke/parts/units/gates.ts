/**
 * unit: 闸门错误码提取
 *
 * session_expired / superseded 等可恢复闸门与账号级限流码的归类.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import {
  extractGateError,
  extractRateLimitError,
  isSessionRecoverableGate,
} from '../../../../../../src/upstream/client.ts'
import assert from 'node:assert/strict'

// --- unit: gate helpers ---
{
  assert.equal(
    extractGateError({ error: 'session_superseded' }, 409),
    'session_superseded',
  )
  assert.equal(isSessionRecoverableGate('session_superseded'), true)
  assert.equal(isSessionRecoverableGate('session_expired'), true)
  assert.equal(
    extractGateError({ error: 'free_mode_legacy_luna_agent' }, 403),
    'free_mode_legacy_luna_agent',
  )
  assert.equal(isSessionRecoverableGate('free_mode_legacy_luna_agent'), true)
  assert.equal(isSessionRecoverableGate('nope'), false)

  // account-level rate-limit codes (chat completions 429) → switch account
  assert.equal(
    extractRateLimitError({ error: 'free_mode_rate_limited' }),
    'free_mode_rate_limited',
  )
  assert.equal(
    extractRateLimitError({ error: { code: 'rate_limited' } }),
    'rate_limited',
  )
  assert.equal(extractRateLimitError({ code: 'spend_limited' }), 'spend_limited')
  assert.equal(extractRateLimitError({ status: 'ip_capped' }), 'ip_capped')
  assert.equal(extractRateLimitError({ error: 'session_superseded' }), null)
  assert.equal(extractRateLimitError({ error: 'free_mode_cli_required' }), null)
  assert.equal(extractRateLimitError(null), null)
}
