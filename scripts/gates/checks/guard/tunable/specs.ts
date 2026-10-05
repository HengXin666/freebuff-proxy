/**
 * check-tunables ---- 可调项表与 DEFAULTS 的双向覆盖校验.
 *
 * 拦什么(两条, 缺一不可):
 *   1. DEFAULTS 里有,但既不在 TUNABLES 也不在 NOT_TUNABLE 的项  →  前端调不了,
 *      却没人知道(用户裁决是"除 host/port 外全部可调");
 *   2. TUNABLES / NOT_TUNABLE 里登记了,但 DEFAULTS 已没有的项  →  陈旧条目,
 *      说明项被删了而清单没同步(会让人以为它还存在).
 *
 *
 * 豁免档(不是遗漏): docs/,dashboard/version.json 之类的非受控路径不在
 * DEFAULTS 里, 因此不参与; 见 TUNABLES 的文档注释里列的四条例外及理由.
 *
 * 扫描根:无(直接 import 真源). 退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import { DEFAULTS } from '../../../../../src/config/defaults.ts'
import { NOT_TUNABLE, TUNABLES } from '../../../../../src/config/tunable/specs.ts'
import { Report } from '../../../lib/text/report.ts'

const report = new Report('tunables')

/**
 * 把嵌套对象展平成点分路径(只到叶子).
 * @param {Record<string, any>} obj 待展平对象
 * @param {string} [prefix] 前缀
 * @returns {string[]} 叶子路径列表
 */
function leafPaths(obj: Record<string, any>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...leafPaths(v, p))
    else out.push(p)
  }
  return out
}

const declared = new Set([...TUNABLES.map((t) => t.path), ...NOT_TUNABLE])
const existing = new Set(leafPaths(DEFAULTS))

// 方向一: DEFAULTS 有, 清单没有 -> 漏登记
for (const p of existing) {
  if (!declared.has(p)) {
    report.add(
      'src/config/tunables.ts',
      0,
      `${p} 既未登记为可调项(TUNABLES)也未登记为不可调(NOT_TUNABLE)`,
      '补进 TUNABLES(让前端可调), 或补进 NOT_TUNABLE 并写明为什么不让改',
    )
  }
}

// 方向二: 清单有, DEFAULTS 没有 -> 陈旧条目
for (const p of declared) {
  if (!existing.has(p)) {
    report.add(
      'src/config/tunables.ts',
      0,
      `${p} 已不在 DEFAULTS 里(清单陈旧, 项可能已被删除)`,
      '删除该条目, 或修正路径拼写',
    )
  }
}

// 方向三: 同一条路径同时出现在两张表里 -> 自相矛盾
for (const t of TUNABLES) {
  if (NOT_TUNABLE.includes(t.path)) {
    report.add('src/config/tunables.ts', 0, `${t.path} 同时登记为可调与不可调`, '从其中一张表里删掉')
  }
}

// 下界断言: 防止"什么都没扫到"伪装成通过
const MIN_TUNABLES = 20
if (TUNABLES.length < MIN_TUNABLES) {
  report.add(
    'src/config/tunables.ts',
    0,
    `可调项只有 ${TUNABLES.length} 项(下限 ${MIN_TUNABLES})—— 清单可能被写坏`,
    '检查 TUNABLES 是否被误删',
  )
}

report.note(`可调项 ${TUNABLES.length} 项 / 不可调 ${NOT_TUNABLE.length} 项；DEFAULTS 叶子 ${existing.size} 个`)
process.exit(report.finish())
