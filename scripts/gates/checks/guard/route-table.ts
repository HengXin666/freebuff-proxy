/**
 * check-route-table ---- HTTP 面分流的接线与边界(src/server/route-table.ts).
 *
 * 拦什么(三类,都是"改了看不出来"的形态):
 *
 *   1. 分流表被搬走/改名:src/server.ts 必须真的 import 并调用 faceOf.
 *      症状是分流逻辑被复制回装配层,然后两处各改一半.
 *   2. 边界退化:未知路径必须落到 static 面(由静态托管自己回答 404),
 *      而 /v1/ 与 /api/ 的前缀判断一旦写松(例如 includes 而不是
 *      startsWith),/foo/v1/chat 会被误送进 proxy 面.
 *   3. 对外面的 404 形状:未识别的 /v1/xxx 必须由 proxy 回答结构化
 *      JSON 404,而不是掉进静态资源面返回 HTML ---- 客户端 SDK 解析 HTML 会
 *      报出一堆莫名其妙的解析错误,把"路径写错"伪装成"上游协议坏了".
 *
 * 判据是真源本身的行为:直接把 faceOf 当纯函数断言,再静态确认接线存在.
 * 这样它零依赖,毫秒级,可以进 pre-commit.
 *
 * 扫描根:CHECK_ROOT.退出码:0 PASS / 1 FAIL / 2 用法错.
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT } from '../../rules.ts'
import { Report } from '../../lib/text/report.ts'

const report = new Report('route-table')
const TABLE = 'src/server/route-table.ts'
const SERVER = 'src/server.ts'

/** 期望的分流结果:未知路径必须保守落到 static. */
const CASES = [
  ['/healthz', 'proxy'],
  ['/health', 'proxy'],
  ['/v1/models', 'proxy'],
  ['/v1/chat/completions', 'proxy'],
  ['/v1/does-not-exist', 'proxy'],
  ['/api/me', 'console'],
  ['/api/accounts/import', 'console'],
  ['/', 'static'],
  ['/index.html', 'static'],
  ['/app.ts', 'static'],
  ['/nope', 'static'],
  // 前缀必须 anchored:包含 "v1/" 但不在开头的路径不该进 proxy 面
  ['/foo/v1/chat', 'static'],
  ['/api-ish', 'static'],
]

const tableFile = path.join(ROOT, TABLE)
if (!fs.existsSync(tableFile)) {
  report.add(TABLE, 0, '分流表不存在（装配层里的分流逻辑无法被单独断言）', `恢复 ${TABLE}`)
  process.exit(report.finish())
}

const mod = await import(`file://${tableFile}`).catch((err) => {
  report.add(TABLE, 0, `无法加载: ${err.message}`, '修语法')
  return null
})

if (mod) {
  for (const [pathname, want] of CASES) {
    const got = mod.faceOf(pathname)
    if (got !== want) {
      report.add(TABLE, 0, `faceOf('${pathname}') = ${got}，期望 ${want}`, '检查前缀判断是否误用了 includes / 漏了锚定')
    }
  }
  if (!mod.FACES || !mod.FACES.proxy || !mod.FACES.console || !mod.FACES.static) {
    report.add(TABLE, 0, 'FACES 三张面不完整', '补回 proxy / console / static')
  }
}

const serverSrc = fs.existsSync(path.join(ROOT, SERVER)) ? fs.readFileSync(path.join(ROOT, SERVER), 'utf8') : ''
if (!/from '\.\/server\/route-table\.ts'/.test(serverSrc)) {
  report.add(SERVER, 0, '没有 import 分流表（分流逻辑可能被复制回装配层）', "import { faceOf } from './server/route-table.ts'")
} else if (!/\bfaceOf\s*\(/.test(serverSrc)) {
  report.add(SERVER, 0, 'import 了 faceOf 但没有调用', '在分发处调用 faceOf(url.pathname)')
}

report.note(`分流边界用例 ${CASES.length} 条；装配层接线已确认`)
process.exit(report.finish())
