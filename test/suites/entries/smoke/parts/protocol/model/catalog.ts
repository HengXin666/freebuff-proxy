/**
 * protocol: 目录协议与模型清单
 *
 * CATALOG_PATH / x-catalog-protocol 头 / CatalogHolder 装载.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import assert from 'node:assert/strict'

// 目录协议(x-freebuff-catalog-protocol / -fetch):服务端据此把请求认作
// 目录客户端并使用句柄(fbm1.xxx)而非 legacy 模型 id.官方原话:
//   "Its presence is what tells the session endpoints to answer with catalog
//    keys instead of model ids."
// 没有它只能走 legacy 路径,在受限出口下被直接拒绝.契约见
// .agents/notes/implemented/bug-fix/2026-10-01-catalog-protocol.md
{
  const {
    CATALOG_PATH,
    HEADER_CATALOG_PROTOCOL,
    CATALOG_PROTOCOL_VERSION,
    HEADER_CATALOG_FETCH,
    MODEL_HANDLE_PREFIX,
    isModelHandle,
    CatalogHolder,
  } = await import('../../../../../../../src/upstream/catalog-protocol.ts')

  assert.equal(CATALOG_PATH, '/api/v1/freebuff/models')
  assert.equal(HEADER_CATALOG_PROTOCOL, 'x-freebuff-catalog-protocol')
  assert.equal(CATALOG_PROTOCOL_VERSION, '1')
  assert.equal(HEADER_CATALOG_FETCH, 'x-freebuff-catalog-fetch')
  assert.equal(MODEL_HANDLE_PREFIX, 'fbm1.')

  assert.equal(isModelHandle('fbm1.AAEAAUPe2Us'), true)
  assert.equal(isModelHandle('deepseek/deepseek-v4-flash'), false)
  assert.equal(isModelHandle(null), false)

  // 未持有目录时不带头(走 legacy,可用性不受影响)
  const h = new CatalogHolder({
    apiHost: 'https://www.codebuff.com',
    token: 't',
    fetchImpl: async () => new Response('{}', { status: 500 }),
  })
  assert.equal(h.ready, false)
  assert.deepEqual(h.headers(), {}, '未持有时必须返回空头，绝不假装已持有')
  assert.equal(h.handleFor('m-1'), 'm-1', '无句柄时原样返回 id（legacy 路径）')

  // 抓取失败:静默返回 false,并写退避(不反复打上游)
  const ok1 = await h.fetch()
  assert.equal(ok1, false, '抓取失败必须返回 false 而不是抛')
  const ok2 = await h.fetch()
  assert.equal(ok2, false, '退避期内不再抓')

  // 成功的抓取:解析 rows(不是 models/data)+ key/handle 配对
  let called = 0
  const h2 = new CatalogHolder({
    apiHost: 'https://www.codebuff.com',
    token: 't',
    fetchImpl: async () => {
      called += 1
      return new Response(
        JSON.stringify({
          protocol: 1,
          version: 'v0.g1.e82909.limited.5',
          fetchId: 'fbf1.AAGZWM32cR3rz9Ux042',
          recommendedKey: 'm-00032eaeec',
          fallbackKey: 'm-00032eaeec',
          rows: [
            { key: 'm-00032eaeec', handle: 'fbm1.AAEAAUPe2Us', displayName: 'MiMo' },
            { key: 'm-00032eaeeb', handle: 'fbm1.BBBBBUPe2Us', displayName: 'DS' },
            { key: 'm-bad' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  assert.equal(await h2.fetch(), true, '成功抓取返回 true')
  assert.equal(h2.ready, true)
  assert.equal(called, 1)
  await h2.fetch()
  assert.equal(called, 1, '已持有时不再重抓')
  assert.equal(h2.handleFor('m-00032eaeec'), 'fbm1.AAEAAUPe2Us', 'id → 句柄映射正确')
  assert.equal(h2.handleFor('m-unknown'), 'm-unknown', '未知 id 原样返回')
  assert.equal(h2.recommendedKey, 'm-00032eaeec', '推荐 key 要被记录下来')
  const hdrs = h2.headers()
  assert.equal(hdrs[HEADER_CATALOG_PROTOCOL], '1')
  assert.equal(hdrs[HEADER_CATALOG_FETCH], 'fbf1.AAGZWM32cR3rz9Ux042')

  // 回执侧(session.model / rateLimitsByModel / prices)用的是目录 key,
  // 控制台必须能把 key 显示成人能认的名字, 直接把 key 露给前端只会显示
  // m-00032eaeec 10 FB/h(服务端不透明标识).
  assert.equal(
    h2.displayNameForKey('m-00032eaeec'),
    'MiMo',
    'key → displayName 必须可用（控制台展示名）',
  )
  assert.equal(h2.displayNameForKey('m-nope'), null, '未知 key 返回 null')
  assert.equal(h2.displayNameForKey(null), null, '空输入返回 null')
  // 反向:显示名 → key(下游照着 display_name 填 model 时靠它落回服务端口径)
  assert.equal(h2.keyForName('MiMo'), 'm-00032eaeec')
  assert.equal(h2.keyForName('mimo'), 'm-00032eaeec', '小写同样命中')
  assert.equal(h2.keyForName(''), null, '空串返回 null')
  assert.equal(h2.keyForName(null), null, '非字符串返回 null')
}

// 目录 key ↔ 人类可读 id 的桥接(legacyDigests 反查).
// [同步上游模型]的回执只有 key(m-096e75164d),而 catalog / 自定义模型用
// 人类可读 id(deepseek/deepseek-v4-flash),两侧必须能对上.
{
  const { CatalogHolder, freebuffLegacyModelDigest } = await import(
    '../../../../../../../src/upstream/catalog-protocol.ts'
  )
  const h = new CatalogHolder({
    apiHost: 'https://www.codebuff.com',
    token: 't',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          fetchId: 'fid',
          rows: [
            {
              key: 'm-096e75164d',
              handle: 'fbm1.DS',
              displayName: 'DeepSeek V4.1 Flash',
              legacyDigests: ['1e303ac563a6f9cc'],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  })
  await h.fetch()
  // 摘要 → key(回执/展示侧口径),与 legacyIndex(摘要 → 句柄)互补
  assert.equal(h.keyByDigest.get('1e303ac563a6f9cc'), 'm-096e75164d')
  // 内置 catalog 的 id 算同一摘要即可反查到该行
  const { FREEBUFF_AVAILABLE_MODELS } = await import('../../../../../../../src/model.ts')
  const hit = FREEBUFF_AVAILABLE_MODELS.find(
    (m) => freebuffLegacyModelDigest(m.id) === '1e303ac563a6f9cc',
  )
  assert.ok(hit, '内置 catalog 必须有一条 id 的摘要等于目录行的 legacyDigest')
  assert.equal(hit.id, 'deepseek/deepseek-v4-flash')
  // key → 摘要 的反向表:展示侧要[key → 人类可读 id]必须先回到摘要.
  assert.equal(
    h.digestForKey('m-096e75164d'),
    '1e303ac563a6f9cc',
    'key → 摘要必须可用（否则 /v1/models 的可读 id 反查不出来）',
  )
  assert.equal(h.digestForKey('m-nope'), null, '未知 key 返回 null')
  // 显示名 → key 的反向解析:下游照着 /v1/models 的 display_name 填 model 时用.
  assert.equal(h.keyForName('DeepSeek V4.1 Flash'), 'm-096e75164d')
  assert.equal(h.keyForName('  deepseek v4.1 flash  '), 'm-096e75164d', '大小写/空白不敏感')
  assert.equal(h.keyForName('不存在的模型'), null)
}

/**
 * /v1/models 不得把目录 key(m-00032eaeec)当模型名返回给下游.
 *
 * - 场景(用户反馈): /v1/models 里有 5 条 {id:'m-00032eaeec', source:'session'},
 * 下游 Agent 拿它当模型表, 看到的是一串不透明标识. 因此 extraIds 带
 * displayName / catalogId 时按
 * - catalogId || displayName || key 取 id.
 */
{
  const { buildModelsListResponse } = await import('../../../../../../../src/model.ts')
  const out = buildModelsListResponse({
    includeAllCatalog: true,
    extraIds: [
      // 有 catalogId:直接用人类可读 id(生态通用写法).
      { key: 'm-096e75164d', displayName: 'DeepSeek V4.1 Flash', catalogId: 'deepseek/deepseek-v4-flash' },
      // 无 catalogId(上游新模型):够不到可读 id 时用 displayName.
      { key: 'm-9a7e098cc1', displayName: 'Solar Pro 4', catalogId: null },
      // 连名字都没有:兜底原 key,绝不丢模型.
      { key: 'm-unknown0', displayName: null, catalogId: null },
    ],
  }).data
  const ids = out.map((m) => m.id)
  assert.ok(
    !ids.includes('m-096e75164d'),
    'm-096e75164d 必须换成人读得懂的 id 而不是裸目录 key',
  )
  // deepseek 那条内置 catalog 里本来就有,所以不该重复出现两次
  assert.equal(
    ids.filter((id) => id === 'deepseek/deepseek-v4-flash').length,
    1,
    'catalogId 与内置条目同模型时必须去重（用户不该在列表里看到两份）',
  )
  const solar = out.find((m) => m.freebuff_key === 'm-9a7e098cc1')
  assert.ok(solar, '没有 catalogId 的上游模型必须仍在清单里（按 freebuff_key 定位）')
  assert.equal(solar.id, 'Solar-Pro-4', '没有 catalogId 时 id 取 displayName 的归一形态（无空白）')
  assert.equal(solar.display_name, 'Solar Pro 4', 'display_name 保留人类可读名')
  assert.equal(solar.source, 'session')
  assert.equal(solar.freebuff_key, 'm-9a7e098cc1', '原始目录 key 必须透出，便于排障')
  const unknown = out.find((m) => m.id === 'm-unknown0')
  assert.ok(unknown, '连名字都没有时兜底原 key，绝不能把模型弄丢')
  assert.equal(unknown.display_name, 'm-unknown0')
  // 回归:老写法(纯字符串 extraIds)仍然可用
  const legacyShape = buildModelsListResponse({ extraIds: ['m-abcdef123'] }).data
  assert.ok(legacyShape.find((m) => m.id === 'm-abcdef123'), '纯字符串 extraIds 必须继续被接受')
}

// 会话模型绑定:chat 的 model 必须用会话回执里服务端指派的值
// (m-xxxx 目录 key / fbm1.xxx 句柄), 不用自己的模型名(用错会得到上游
// session_model_mismatch 拒绝).契约见
// .agents/notes/implemented/bug-fix/2026-10-01-session-model-binding.md
{}
