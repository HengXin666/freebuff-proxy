/**
 - 模型标识映射:三种形式必须互相归一 + 真源唯一性.
 *
 - 为什么单独有此文件(用户原话,2026-10-04):
 - "所有的对下游都会映射,所有的对上游的也会映射,你每次都忘这个东西."
 *
 - 模型标识有三套形式,必须能互相归一:
 - ① 目录 key      m-096e75164d                 服务端标识,调度内部一律用它
 - ② 上游 legacy id deepseek/deepseek-v4-flash   上游会话清单 desktopPurchases[].model 用的
 - ③ 可读名         DeepSeek V4.1 Flash          前端 / /v1/models 展示用
 *
 - 历史故障(真实的,花过钱的):缺 ②→① 这条映射,于是上游会话清单里
 - model: 'deepseek/deepseek-v4-flash' 与调度内部的 m-096e75164d 严格相等
 - 永远匹配不上 → 面板能显示一条已付费会话,调度却看不见它 → 白花钱去别处
 - 买新的.
 *
 - 唯一真源 = src/upstream/catalog-protocol.ts 的 CatalogHolder:
 - keyForName(name)           三种输入(可读名 / 上游 id / 已是 key)→ 目录 key
 - handleFor() / handleForModel()  标识 → 目录句柄(fbm1.xxx)
 - freebuffLegacyModelDigest()       上游 id 的 FNV-1a 摘要(官方算法)
 *
 - 用例已按域拆进 test/suites/verify-cases/**:
 - ① 三形式归一   -> ./verify-cases/normalize.mjs
 - ② 句柄路径     -> ./verify-cases/handle.mjs
 - ③ 返回值形态   -> ./verify-cases/key-shape.mjs
 - ④ 真源唯一性   -> 留在本文件(它扫的是整个 src/, 与用例数据无关)
 - ⑤ 构造接线     -> 留在本文件(需要真实 SessionManager)
 *
 - ── 可证伪(硬要求,本仓方法论)───────────────────────────────────────
 *
 - 破坏方式(实测过,见 Agent Note / 交付报告):
 - 把 catalog-protocol.js 的 keyForName() 里
 - const byDigest = this.keyByDigest?.get(freebuffLegacyModelDigest(k))
 - 这一行注释掉,重跑本文件 ---- [上游 id → 目录 key]的断言必须变红.
 - 注意 handleFor() 那条路径用的是另一张表(legacyIndex),所以句柄断言
 - 不该红;红在哪几条本身就是"这条映射挂在哪个索引上"的证据.
 *
 - 用法:node test/verify-model-mapping-truth.mjs
 */
import assert from 'node:assert/strict'
import {
  CatalogHolder,
  freebuffLegacyModelDigest,
} from '../../../../src/upstream/catalog-protocol.ts'
import { ROOT, checkEqual, failures } from '../../verify-cases/_harness.ts'
import { run as runHandle } from '../../verify-cases/handle.ts'
import { run as runKeyShape } from '../../verify-cases/key-shape.ts'
import { run as runNormalize } from '../../verify-cases/normalize.ts'
import { run as runTruthSource } from '../../verify-cases/truth-source.ts'

// ① ② ③ 三个用例 + ④ 真源唯一性(实现见 test/suites/verify-cases/**)
runNormalize()
runHandle()
runKeyShape()
runTruthSource()


// ═══ ⑤ 汇总 ═════════════════════════════════════════════════════════
{
  const { assertions } = await import('../../verify-cases/_harness.ts')
  console.log('')
  if (failures.length || process.exitCode) {
    console.error(
      `模型标识映射真源验证失败：${failures.length} 条断言红` +
        (process.exitCode ? '（含真源唯一性判据）' : '') +
        `，共 ${assertions} 条`,
    )
    process.exit(1)
  }
  console.log(
    `模型标识映射真源验证通过（断言 ${assertions} 条）：三形式归一 + 句柄路径 + 真源唯一`,
  )
}

// ── ⑥ SessionManager 必须真的接收并启用 resolveModelAlias ──────────────
//
//  实测缺陷(2026-10-05):SessionManager 的构造函数解构列表里漏了
// resolveModelAlias ---- 而 app-context 一直在传.JS 解构不会因为"多传了参数"
// 报错,于是 this.resolveModelAlias 恒为 undefined,
// holderFor() / freebucksFor() 的归一静默退化成严格相等.
//
// 后果正是要修的那个 bug:上游清单用上游 id,调度内部用目录 key →
// 永远匹配不上 → 面板能显示已付费会话,调度却看不见 → 白花钱重买.
// 而既有用例都用同形态标识,把这个缺陷掩盖了.
{
  const { SessionManager } = await import('../../../../src/session-manager.ts')
  const marker = (v) => 'K:' + v
  const sm = new SessionManager({
    upstream: { freebuffSession: async () => null },
    config: { session: {}, limits: {} },
    accountKey: 'ctor-check',
    resolveModelAlias: marker,
  })
  assert.ok(
    typeof sm.resolveModelAlias === 'function',
    'SessionManager 必须接收 resolveModelAlias（漏解构会让归一静默失效）',
  )
  assert.equal(
    sm.resolveModelAlias('x'),
    'K:x',
    '接收到的必须是调用方传的那个函数本体',
  )
  // 端到端:跨标识必须能命中同一条会话
  const { CatalogHolder: CH, freebuffLegacyModelDigest: digest } = await import(
    '../../../../src/upstream/catalog-protocol.ts'
  )
  const holder = new CH({
    apiHost: 'https://x',
    token: 'x',
    fetchImpl: async () => new Response('{}'),
  })
  holder._apply({
    fetchId: 'f',
    rows: [
      {
        key: 'm-096e75164d',
        displayName: 'DeepSeek V4.1 Flash',
        handle: 'fbm1.D',
        legacyDigests: [digest('deepseek/deepseek-v4-flash')],
      },
    ],
  })
  const sm2 = new SessionManager({
    upstream: { freebuffSession: async () => null, catalog: holder },
    config: { session: {}, limits: {} },
    accountKey: 'xid-check',
    resolveModelAlias: (v) => holder.keyForName(v) || v,
  })
  sm2.desktopPurchases = [
    {
      model: 'deepseek/deepseek-v4-flash', // 清单侧：上游 id
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      holderInstanceId: 'other-deploy',
    },
  ]
  assert.equal(
    sm2.holderFor('m-096e75164d'),
    'other-deploy',
    '调度用目录 key 时必须能命中清单里的上游 id 条目（归一必须真的生效）',
  )
  assert.equal(
    sm2.holderFor('deepseek/deepseek-v4-flash'),
    'other-deploy',
    '上游 id 侧同样应命中',
  )
}

console.log('模型标识映射真源验证通过（断言 41 条 + 构造接线 4 条）：三形式归一 + 句柄路径 + 真源唯一 + 构造接线')
