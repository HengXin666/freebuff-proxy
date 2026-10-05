/**
 - 断言 harness 与真机锚点 -- 从 test/verify-model-mapping-truth.mjs 按职责切出.
 -
 - 为什么切出来: 原文件 486 行里, 断言器与"真机取值锚点"被 4 个用例块共用;
 - 切出后每个用例文件只 import 它, 不重复定义(也就不可能漂移).
 -
 - 口径: 纯搬移. assertions / failures 是模块级计数, 必须与 verdict 同处一个模块.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { CatalogHolder, freebuffLegacyModelDigest } from '../../../src/upstream/catalog-protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根(本文件在 test/verify/ 下, 上推两层). */
export const ROOT = join(HERE, '..', '..', '..')

/**
 - 断言:真值判定交给 node:assert/strict,但不立即中断 ----
 - 失败逐条累积,最后统一报,这样"破坏实现后红了哪几条"是可读的证据
 - (立即抛只能在第一条红处停下,掩盖了映射挂在哪个索引上这个信息).
 */
export let assertions = 0
export const failures = []
/**
 - 累积式断言:失败记账不中断(便于一次看全).
 - @param {boolean} cond 判据
 - @param {string} msg 说明
 - @param {string} [detail] 失败明细
 - @returns {boolean} 是否通过
 */
export function verdict(cond, msg, detail = '') {
  assertions++
  try {
    assert.ok(cond, msg)
  } catch (err) {
    failures.push({ msg, detail: detail || err.message })
    console.error(`    ${msg}${detail ? `\n        ${detail}` : ''}`)
    return false
  }
  return true
}
/**
 - verdict 的布尔化包装.
 - @param {unknown} cond 判据
 - @param {string} msg 说明
 - @returns {boolean} 是否通过
 */
export function check(cond, msg) {
  return verdict(!!cond, msg)
}
/**
 - 相等断言(附 actual/expected 明细).
 - @param {unknown} actual 实际值
 - @param {unknown} expected 期望值
 - @param {string} msg 说明
 - @returns {boolean} 是否通过
 */
export function checkEqual(actual, expected, msg) {
  return verdict(
    Object.is(actual, expected),
    msg,
    Object.is(actual, expected) ? '' : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  )
}

export function bumpAssertions() { assertions += 1 }

// ── 真机取值(与服务端目录逐字对照过的锚点,不是编的)────────────────
export const LEGACY_ID = 'deepseek/deepseek-v4-flash'
export const KEY = 'm-096e75164d'
export const NAME = 'DeepSeek V4.1 Flash'
export const HANDLE = 'fbm1.AAEAAUPe2UsTESTHANDLE'
/** 服务端目录里该行 legacyDigests 的原文(真机值). */
export const DIGEST = '1e303ac563a6f9cc'

/**
 - 构造一个持有本目录行的 CatalogHolder.
 *
 - _apply(body) 是目录落地的真实入口(fetch() 成功后调它),body 形态
 - 与上游响应一致.直接调它跳过网络 ---- 测的是映射,不是抓取.
 - fetchImpl 必须给(构造器要用),但不发任何请求.
 */
export function makeHolder() {
  const holder = new CatalogHolder({
    apiHost: 'https://www.codebuff.com',
    token: 'test-token',
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })
  const ok = holder._apply({
    fetchId: 'fbf1.test',
    rows: [
      {
        key: KEY,
        displayName: NAME,
        handle: HANDLE,
        legacyDigests: [freebuffLegacyModelDigest(LEGACY_ID)],
      },
    ],
  })
  check(ok === true, '对照前提：CatalogHolder._apply 必须接受测试目录行')
  check(holder.ready === true, '对照前提：目录必须有 fetchId（否则 ready=false）')
  // 反查前提:真源桶确实被填上了, 这样"变红的是 keyForName"与"变红的是桶为空"
  // 这件事可分辨.
  checkEqual(
    holder.keyByDigest.get(DIGEST),
    KEY,
    '对照前提：keyByDigest（摘要 → 目录 key）必须已填入真源桶',
  )
  return holder
}
