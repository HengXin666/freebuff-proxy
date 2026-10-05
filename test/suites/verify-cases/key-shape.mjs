/**
 - 回归护栏:keyForName 的返回值只能是目录 key 或 null -- 从 test/verify-model-mapping-truth.mjs 逐字搬出.
 */
import { KEY, LEGACY_ID, NAME, check, makeHolder } from './_harness.mjs'

export function run() {
  const holder = makeHolder()
  const KEY_RE = /^m-[0-9a-z]+$/i
  const inputs = [LEGACY_ID, NAME, NAME.toLowerCase(), KEY, 'unknown/model-xyz']
  
  for (const input of inputs) {
    const out = holder.keyForName(input)
    check(
      out === null || KEY_RE.test(out),
      `keyForName(${JSON.stringify(input)}) 只能是目录 key 或 null，got ${JSON.stringify(out)}`,
    )
    // 映射没生效的典型症状:把入参原样吐回来(上游 id / 可读名被当成 key)
    if (input !== KEY) {
      check(
        out !== input,
        `keyForName 绝不能把输入原样当 key 返回（映射未生效），input=${JSON.stringify(input)}`,
      )
    }
  }
}
