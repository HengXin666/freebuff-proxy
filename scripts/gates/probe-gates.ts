/**
 - 负向探针执行器 ---- 逐条跑 probes/cases.ts 的夹具,断言门禁真的会红.
 *
 - 为什么必须有:一个永远 PASS 的门禁和一个正确的门禁,在 CI 上是同一个绿色.
 - 只有违规组 FAIL + 控制组 PASS 同时成立,才说明"这条判据在按它声称的标准判".
 *
 - 不进 pre-commit(要起几十个子进程),由 CI 的 quality job 与手动命令承担.
 *
 - 用法:node scripts/gates/probe-gates.ts [--verbose]
 - 退出码:0 = 全部符合预期;1 = 有探针没按预期反应(门禁失效).
 */
import fs from 'node:fs'

import { probes } from './probes/cases.ts'

const verbose = process.argv.includes('--verbose')
let bad = 0

for (const p of probes) {
  let res
  try {
    res = p.run()
  } catch (err) {
    console.log(`BAD  探针自身抛异常 ${p.name}: ${err.message}`)
    bad++
    continue
  }
  const okStatus = res.status === p.expect
  const missing = (p.expectIn ?? []).filter((s) => !res.out.includes(s))
  const pass = okStatus && missing.length === 0
  if (!pass) bad++
  console.log(`${pass ? 'ok  ' : 'BAD '} ${p.name}`)
  if (!pass || verbose) {
    console.log(`     期望 exit=${p.expect} 实际=${res.status}${missing.length ? `，缺少片段: ${missing.join(' | ')}` : ''}`)
    console.log(res.out.split('\n').slice(0, 8).map((l) => `     | ${l}`).join('\n'))
  }
  if (res.dir) fs.rmSync(res.dir, { recursive: true, force: true })
}

console.log(bad === 0 ? `ALL PROBES PASS (${probes.length} 条)` : `探针失败 ${bad}/${probes.length} 条`)
process.exit(bad === 0 ? 0 : 1)
