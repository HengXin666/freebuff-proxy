/**
 - 句柄路径:上游 id 与目录 key 都必须能换到 fbm1. 句柄 -- 从 test/verify-model-mapping-truth.mjs 逐字搬出.
 */
import { HANDLE, KEY, LEGACY_ID, NAME, checkEqual, makeHolder } from './_harness.ts'

export function run() {
  const holder = makeHolder()
  
  checkEqual(
    holder.handleFor(LEGACY_ID),
    HANDLE,
    'handleFor(上游 id) 必须换到目录句柄',
  )
  checkEqual(
    holder.handleForModel(LEGACY_ID),
    HANDLE,
    'handleForModel(上游 id) 必须换到目录句柄（admission 走的就是它）',
  )
  checkEqual(
    holder.handleForModel(LEGACY_ID, NAME),
    HANDLE,
    '带 displayName 兜底同样换到目录句柄',
  )
  checkEqual(holder.handleFor(KEY), HANDLE, '目录 key 直查句柄')
  checkEqual(
    holder.handleFor(HANDLE),
    HANDLE,
    '已是句柄则原样返回（幂等）',
  )
  
  // 反例(防"全放行"式假绿):不在册的模型必须原样返回,绝不替上游猜
  checkEqual(
    holder.handleFor('unknown/model-xyz'),
    'unknown/model-xyz',
    '不在册的模型原样返回（不猜）',
  )
  checkEqual(
    holder.handleForModel('unknown/model-xyz', '不存在的名字'),
    'unknown/model-xyz',
    '兜底也命中不了时原样返回（不猜）',
  )
}
