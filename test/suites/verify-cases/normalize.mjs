/**
 - 模型标识三形式归一(上游 id / 可读名 / 已是 key) -- 从 test/verify-model-mapping-truth.mjs 逐字搬出.
 */
import { DIGEST, HANDLE, KEY, LEGACY_ID, NAME, check, checkEqual, makeHolder } from './_harness.mjs'
import { freebuffLegacyModelDigest } from '../../../src/upstream/catalog-protocol.js'

export function run() {
  const holder = makeHolder()
  
  // 摘要算法本身必须先对(官方双 FNV-1a,不是 sha256 ---- 曾猜错一次)
  checkEqual(
    freebuffLegacyModelDigest(LEGACY_ID),
    DIGEST,
    '上游 legacy id 的 FNV-1a 摘要必须等于服务端目录里的原文',
  )
  
  const viaLegacy = holder.keyForName(LEGACY_ID)
  const viaName = holder.keyForName(NAME)
  const viaKey = holder.keyForName(KEY)
  
  checkEqual(
    viaLegacy,
    KEY,
    '【核心】上游 legacy id → 目录 key（历史故障根因：缺这条映射则已付费会话匹配不上）',
  )
  checkEqual(viaName, KEY, '可读名 → 目录 key')
  checkEqual(viaKey, KEY, '已是目录 key → 自反')
  
  // 三形式必须收敛到同一个值,而不只是各自"非 null"
  check(
    viaLegacy === viaName && viaName === viaKey,
    '三种形式必须归一为同一个目录 key，got ' +
      JSON.stringify({ viaLegacy, viaName, viaKey }),
  )
  
  // 可读名大小写不敏感(下游照抄 display_name 时首字母大小写不固定)
  checkEqual(
    holder.keyForName(NAME.toLowerCase()),
    KEY,
    '可读名小写同样命中',
  )
  checkEqual(
    holder.keyForName(`  ${NAME.toLowerCase()}  `),
    KEY,
    '可读名首尾空白 / 大小写不敏感',
  )
  
  // 未知输入一律 null,不抛异常(调用方据此保持原值,绝不让请求失败)
  checkEqual(holder.keyForName('不存在的模型'), null, '未知可读名返回 null')
  checkEqual(holder.keyForName('unknown/model-xyz'), null, '未知上游 id 返回 null')
  checkEqual(holder.keyForName(''), null, '空串返回 null')
  checkEqual(holder.keyForName('   '), null, '纯空白返回 null')
  checkEqual(holder.keyForName(null), null, 'null 返回 null')
  checkEqual(holder.keyForName(undefined), null, 'undefined 返回 null')
  checkEqual(holder.keyForName(123), null, '非字符串返回 null')
}
