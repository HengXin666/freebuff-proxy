/**
 - 棘轮基线的读写与对账 —— 存量欠账只许降不许涨.
 *
 - 三条硬约定,缺一条棘轮就会被绕过:
 - 1. 基线同时记方向(条目集合)与数字(每个条目的当前值).只记总量的
 - 基线,用"删一条豁免 + 补一条新违规"就能保持总数不变地绕过.
 - 2. 水位降了必须重录,否则基线里留着虚高的数,下次又能偷偷涨回去.
 - 3. 基线文件本身进指纹(见 lib/fingerprint.mjs),否则它可以被改大而没人知道.
 */
import fs from 'node:fs'
import path from 'node:path'

import { BASELINE_DIR } from '../../rules.mjs'

/** 读一份基线(不存在则返回空对象). */

/**
 - 见上方模块说明.
 *
 - @param {string} name 基线文件名
 - @returns {{entries: Record<string, number>, meta: Record<string, unknown>}} 基线内容
 */
export function readBaseline(name) {
  const file = path.join(BASELINE_DIR, name)
  if (!fs.existsSync(file)) return { entries: {}, meta: {} }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { entries: parsed.entries ?? {}, meta: parsed.meta ?? {} }
}

/** 写一份基线(只在显式 --update 时调用). */

/**
 - 见上方模块说明.
 *
 - @param {string} name 基线文件名
 - @param {Record<string, number>} entries 本次观测值
 - @param {Record<string, unknown>} [meta] 附加说明
 - @returns {string} 写入的绝对路径
 */
export function writeBaseline(name, entries, meta = {}) {
  fs.mkdirSync(BASELINE_DIR, { recursive: true })
  const file = path.join(BASELINE_DIR, name)
  const payload = {
    note: meta.note ?? '棘轮基线：既有欠账只许降不许涨；降低后必须重录（--update）。',
    meta,
    entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
  }
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  return file
}

/**
 - 用基线对账一组观测值.
 *
 - @param {Record<string, number>} observed 本次实测(文件/目录/函数 → 计数值)
 - @param {Record<string, number>} baseline 上次登记
 - @returns {{grown: Array<[string, number, number]>, shrunk: Array<[string, number]>, fresh: string[]}}
 - grown  涨了(必须 FAIL)
 - shrunk 降了(提示重录)
 - fresh  基线里没有的新条目(必须 FAIL:新违规不许静默进入)
 */
export function reconcile(observed, baseline) {
  const grown = []
  const shrunk = []
  const fresh = []
  for (const [key, value] of Object.entries(observed)) {
    if (!(key in baseline)) {
      fresh.push(key)
      continue
    }
    if (value > baseline[key]) grown.push([key, baseline[key], value])
    else if (value < baseline[key]) shrunk.push([key, value])
  }
  // 基线里有,本次完全没有出现的条目 = 水位降到 0(违规被修掉,或文件改名/删除).
  // 漏掉这一支的后果:基线永远留着虚高的数,下次可以偷偷涨回去而没人察觉.
  for (const [key, value] of Object.entries(baseline)) {
    if (!(key in observed) && value > 0) shrunk.push([key, 0])
  }
  return { grown, shrunk, fresh }
}
