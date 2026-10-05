/**
 * protocol: 模型映射用 legacyDigests
 *
 * 双 FNV-1a 而非 sha256, 也不是 recommendedKey.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import assert from 'node:assert/strict'

// 模型映射用 legacyDigests(双 FNV-1a),不是 sha256,不是 recommendedKey.
// 官方目录不直接列模型 id,只给每行的 legacyDigests;这是把
// deepseek/deepseek-v4-flash 这类 id 映射到服务端行的唯一正确途径.
// 用错会静默映射到别的模型(实测曾把 deepseek 映射到 MiMo),导致 chat 503.
// 见 .agents/notes/implemented/bug-fix/2026-10-01-legacy-model-digest-mapping.md
{
  const { freebuffLegacyModelDigest, CatalogHolder } = await import(
    '../../../../../../../src/upstream/catalog-protocol.ts',
  )

  // 与服务端真实返回的 legacyDigests 逐字对照(决定性验证)
  assert.equal(
    freebuffLegacyModelDigest('mimo/mimo-v2.5'),
    '5acfab992d88345c',
    '必须与服务端目录里 m-00032eaeec 行的 legacyDigests 一致',
  )
  assert.equal(
    freebuffLegacyModelDigest('deepseek/deepseek-v4-flash'),
    '1e303ac563a6f9cc',
    '必须与 m-096e75164d（DeepSeek V4.1 Flash）行一致',
  )
  assert.equal(
    freebuffLegacyModelDigest('z-ai/glm-5.3-flash'),
    '197cbcdc4b67262b',
    'GLM 行（m-7e20df6765）',
  )
  // 注:只对有实证的条目断言.openai/gpt-5.6-luna 的摘要与服务端
  // 'GPT-6 Luna' 行的 legacyDigests 不同 ---- 说明那行的旧 id 是另一个
  // (目录会随版本演进,旧 id 也换).不做无据断言.

  // 形状:16 位小写 hex
  const d = freebuffLegacyModelDigest('x/y')
  assert.match(d, /^[0-9a-f]{16}$/, '必须是 16 位小写 hex, got ' + d)
  assert.notEqual(
    freebuffLegacyModelDigest('a/b'),
    freebuffLegacyModelDigest('a/c'),
    '不同模型必须得出不同摘要',
  )

  // 端到端映射:模拟一份含 legacyDigests 的目录,验证 handleFor 依次尝试
  // 句柄 → 目录 key → legacy 摘要
  const holder = new CatalogHolder({
    apiHost: 'https://www.codebuff.com',
    token: 't',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          protocol: 1,
          version: 'v-test',
          fetchId: 'fbf1.test',
          recommendedKey: 'm-WRONG',
          rows: [
            {
              key: 'm-00032eaeec',
              handle: 'fbm1.MIMO',
              displayName: 'MiMo 2.6 Flash',
              legacyDigests: [freebuffLegacyModelDigest('mimo/mimo-v2.5')],
            },
            {
              key: 'm-096e75164d',
              handle: 'fbm1.DEEPSEEK',
              displayName: 'DeepSeek V4.1 Flash',
              legacyDigests: [freebuffLegacyModelDigest('deepseek/deepseek-v4-flash')],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  })
  assert.equal(await holder.fetch(), true)
  assert.equal(
    holder.handleFor('deepseek/deepseek-v4-flash'),
    'fbm1.DEEPSEEK',
    'legacy 摘要必须命中 deepseek 行（而不是 recommendedKey）',
  )
  assert.equal(holder.handleFor('mimo/mimo-v2.5'), 'fbm1.MIMO')
  assert.equal(holder.handleFor('m-096e75164d'), 'fbm1.DEEPSEEK', '目录 key 直查')
  assert.equal(holder.handleFor('fbm1.NATIVE'), 'fbm1.NATIVE', '已是句柄则原样返回')
  assert.equal(
    holder.handleFor('unknown/model'),
    'unknown/model',
    '不在册的模型原样返回（不替上游猜）',
  )
  assert.equal(holder.hasModel('deepseek/deepseek-v4-flash'), true)
  assert.equal(holder.hasModel('unknown/model'), false)
}
