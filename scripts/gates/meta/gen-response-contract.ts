/**
 * 从真源生成上游响应契约快照 ---- 上游改了字段名/判据码之后的第一步.
 *
 *
 * 用法:node scripts/gates/meta/gen-response-contract.ts
 * 退出码:0 = 已写入;2 = 真源读不出来(用法/环境错).
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../rules.ts'

const TRUTH = 'src/upstream/response-contract.ts'
const SNAPSHOT = 'docs/reverse/upstream-response-contract.json'

const mod = await import(`file://${path.join(ROOT, TRUTH)}`).catch((err) => {
  console.error(`usage: 无法加载真源 ${TRUTH}: ${err.message}`)
  process.exit(2)
})

const payload = {
  '//': '上游**响应契约**快照 —— 从 `src/upstream/response-contract.ts` 生成，供门禁对账。',
  '//为什么单独一份而不是塞进 upstream-contract.json':
    '那份是**抓包生成**的客户端真值（我们发什么），这份是**代码声明**的解析面（我们读什么）。' +
    '两者真源不同、变更节奏不同：上游改头名要重抓包，上游改回执字段名只要改常量 + 重生成这一份。' +
    '混在一起会让『重抓包』这个动作变得不安全（会顺手覆盖掉解析面）。',
  '//生成方式': 'node scripts/gates/meta/gen-response-contract.ts',
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  generatedFrom: TRUTH,
  fields: [...(mod.REQUIRED_FIELDS ?? [])].sort(),
  codes: [...(mod.REQUIRED_CODES ?? [])].sort(),
}

const out = path.join(ROOT, SNAPSHOT)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
console.log(`已生成 ${SNAPSHOT}: 字段 ${payload.fields.length} / 判据码 ${payload.codes.length}`)
