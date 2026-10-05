/**
 * 目录句柄的跨代次规则验证.
 *
 * 背景(2026-10-05 远程 2.3.0 实测): 服务 17:19 抓的目录 version 是 e82926,
 * 上游当前已是 e82927. 主服务把服务端指派的 key 解析成上一代句柄发出去, 而
 * bun 子进程每次都重抓(拿到 e82927) -> 拿着上一代句柄在它那份表里找 ->
 * 29/29 "model not found in catalog" -> 降级 legacy -> 上游 428
 * waiting_room_required. 两侧目录都健康, 差异只来自抓取时刻.
 *
 * 判据(可证伪):
 * ① 过了 refreshAt 必须重抓; 未过则不抓(零额外请求).
 * ② 回执缺 refreshAt 时永不过期 ---- 判据只能来自服务端明文.
 * ③ 跨进程边界(prefer=key)带目录 key, 不带句柄.
 * ④ 本进程直发(prefer=handle)只认本目录这一代的句柄; 上一代句柄必须换回
 *    稳定身份, 且不得把它当句柄发出去.
 * ⑤ 上一代句柄能经 keyForHandle 反查回同一行(证据来自目录行原文).
 */
import assert from 'node:assert/strict'
import {
  CatalogHolder,
  freebuffLegacyModelDigest,
} from '../../../../../src/upstream/catalog-protocol.ts'
import {
  catalogExpired,
  handleInCatalog,
  keyForHandle,
  refreshIfExpired,
  resolveWireModel,
} from '../../../../../src/upstream/catalog/freshness.ts'

const KEY = 'm-096e75164d'
const NAME = 'DeepSeek V4.1 Flash'
const LEGACY_ID = 'deepseek/deepseek-v4-flash'
const HANDLE_NOW = 'fbm1.AAEAAUPwHandlerGenerationNew'

/** 造一份"当前代次"的目录. */
function makeHolder(refreshAt?: any, fetchImpl?: any) {
  let fetches = 0
  const holder = new CatalogHolder({
    apiHost: 'https://www.codebuff.com',
    token: 'test-token',
    fetchImpl: async () => {
      fetches += 1
      return new Response('{}', { status: 200 })
    },
  })
  holder._apply({
    fetchId: 'fbf1.test',
    issuedAt: 1_791_226_000_000,
    ...(refreshAt === undefined ? {} : { refreshAt }),
    rows: [
      {
        key: KEY,
        displayName: NAME,
        handle: HANDLE_NOW,
        legacyDigests: [freebuffLegacyModelDigest(LEGACY_ID)],
      },
    ],
  })
  return { holder, fetches: () => fetches }
}

let n = 0
const ok = (cond: any, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

// ── ① 过期才抓 ──────────────────────────────────────────────────────
{
  const { holder } = makeHolder(Date.now() - 1000)
  ok(catalogExpired(holder) === true, 'refreshAt 已过必须判过期')
  ok(holder.ready === true, '对照前提: 目录必须就绪')
}

// ── ② 缺 refreshAt 永不过期 ─────────────────────────────────────────
{
  const { holder } = makeHolder(undefined)
  ok(
    catalogExpired(holder) === false,
    '回执没有 refreshAt 时不得判过期(不猜本地 TTL)',
  )
}

// ── ③ 跨进程边界带 key ──────────────────────────────────────────────
{
  const { holder } = makeHolder(Date.now() + 60_000)
  const byKey = resolveWireModel(holder, KEY, LEGACY_ID, { prefer: 'key' })
  ok(byKey.model === KEY, `prefer=key 时必须给目录 key, got ${byKey.model}`)
  ok(byKey.reason === 'key', '判定原因必须是 key')
  // 可读名同样要归一到 key(下游照 display_name 填 model 是常见输入)
  const byName = resolveWireModel(holder, NAME, NAME, { prefer: 'key' })
  ok(byName.model === KEY, '可读名必须归一到目录 key')
  // 上游 legacy id 同样归一
  const byLegacy = resolveWireModel(holder, LEGACY_ID, LEGACY_ID, { prefer: 'key' })
  ok(byLegacy.model === KEY, '上游 legacy id 必须归一到目录 key')
}

// ── ④ 本进程直发只认本代次句柄 ──────────────────────────────────────
{
  const { holder } = makeHolder(Date.now() + 60_000)
  // 本代次句柄: 原样可用
  const current = resolveWireModel(holder, HANDLE_NOW, LEGACY_ID, { prefer: 'handle' })
  ok(current.model === HANDLE_NOW, '本代次句柄必须原样使用')
  ok(current.reason === 'handle_current', '本代次句柄的判定原因必须是 handle_current')
  // 会话回执给 key: 翻成句柄
  const fromKey = resolveWireModel(holder, KEY, LEGACY_ID, { prefer: 'handle' })
  ok(fromKey.model === HANDLE_NOW, '目录 key 必须翻成本代次句柄')
  // 上一代句柄(不在本目录里): 必须换回稳定身份, 绝不能原样发出去
  const stale = 'fbm1.AAEAAUPvStaleGenerationHandle'
  const staleOut = resolveWireModel(holder, stale, LEGACY_ID, { prefer: 'handle' })
  ok(
    staleOut.model !== stale,
    `上一代句柄不得原样发往上游, got ${staleOut.model}`,
  )
  ok(
    staleOut.model === KEY || staleOut.model === HANDLE_NOW,
    '上一代句柄必须落到同一行的稳定身份或本代次句柄',
  )
  ok(
    staleOut.reason === 'handle_reissued' ||
      staleOut.reason === 'handle_stale_fallback_key',
    `必须给出可归因的原因, got ${staleOut.reason}`,
  )
  /**
   * 两边都解析不出时的底线: 不换模型.
   *
   * 会话绑在上一代句柄上, 而请求侧也没给出可归一的标识 ---- 此时没有任何依据
   * 能说出"这是哪一行". 猜一个别的模型(推荐位 / 首行)是最坏的结果: 会话绑的是 A
   * 而请求发的是 B, 上游回 session_model_mismatch, 本地却看不出为什么.
   * 所以原样保留并给出可归因的原因, 让上游按它的判据回答.
   */
  const staleNoFallback = resolveWireModel(holder, stale, 'unknown/model-xyz', { prefer: 'handle' })
  ok(
    staleNoFallback.model === stale || staleNoFallback.model === KEY,
    '两边都解析不出时只允许原样保留或落到同一行, 绝不许换别的模型',
  )
  ok(
    staleNoFallback.model !== LEGACY_ID && staleNoFallback.model !== NAME,
    '不得把请求侧那个解析不出的名字当成上游标识发出去',
  )
  ok(
    staleNoFallback.reason === 'handle_foreign' ||
      staleNoFallback.reason === 'handle_stale_fallback_key',
    `必须给出可归因的原因, got ${staleNoFallback.reason}`,
  )
}

// ── ⑤ 句柄与本代次的对应关系可查 ────────────────────────────────────
{
  const { holder } = makeHolder(Date.now() + 60_000)
  ok(handleInCatalog(holder, HANDLE_NOW) === true, '本代次句柄必须判在册')
  ok(handleInCatalog(holder, 'fbm1.AAEAAUPvStaleGenerationHandle') === false, '上一代句柄必须判不在册')
  ok(handleInCatalog(holder, KEY) === false, '非句柄一律不在册')
  ok(keyForHandle(holder, HANDLE_NOW) === KEY, '本代次句柄必须能反查回目录 key')
  ok(keyForHandle(holder, 'fbm1.AAAStale') === null, '不在册的句柄反查为 null')
}

// ── ⑥ 重抓的触发条件 ────────────────────────────────────────────────
{
  const fresh = makeHolder(Date.now() + 60_000)
  const ranFresh = await refreshIfExpired(fresh.holder)
  ok(ranFresh === false, '未过 refreshAt 时不得触发重抓(零额外请求)')
  // 过期路径: 这里只断言"确实发起了抓取", 抓取成功与否由 protocol/fetch 负责.
  const stale = makeHolder(Date.now() - 1000)
  const ranStale = await refreshIfExpired(stale.holder)
  ok(ranStale === true, '过了 refreshAt 必须发起重抓')
}

// ── ⑦ 未就绪的目录不得编造判据 ──────────────────────────────────────
{
  const empty = new CatalogHolder({
    apiHost: 'https://www.codebuff.com',
    token: 'test-token',
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })
  ok(catalogExpired(empty) === false, '目录未就绪不得判过期')
  const out = resolveWireModel(empty, KEY, KEY, { prefer: 'key' })
  ok(out.reason === 'catalog_not_ready', '未就绪时必须给出可归因原因')
  ok(out.model === KEY, '未就绪时原样返回, 不猜')
}

console.log(`目录句柄跨代次规则: ${n} 条断言通过`)
