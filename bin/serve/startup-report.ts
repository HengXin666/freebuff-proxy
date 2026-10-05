/**
 * 启动失败的兜底报告 -- 从 bin/serve.ts 按职责切出.
 *
 * 为什么切出来: 这段代码唯一的价值是"进程起不来时把原因写清楚", 它与启动
 * 流程本身没有任何耦合; 单独成文件后, 那份诊断文案可以被独立阅读与修改.
 *
 * 口径: 纯搬移, 不改行为, 不改任何一行用户可见文案.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { loadConfig } from '../../src/config.ts'
import { dirtyDataFiles, invalidDataFiles } from '../../src/util/json-store.ts'
import { parseConfigPath } from './cli-args.ts'

/**
 * 启动失败兜底:把"为什么起不来"直接写在日志最后一段.
 *
 * 起因是真实故障--镜像升级后容器起不来,用户只能靠"删几个 json 试试"恢复.
 * 根因是几个 store 在构造期直接抛(数据文件数组里混进 null 条目),那时
 * logDataFileAudit() 还没轮到执行,日志里既没有文件名字也没有处置办法.
 * 现在无论哪个阶段抛,都保证输出:错误本身 + 已登记的数据文件状态 +
 * 残留的写盘中间文件 + 可直接照做的处置命令.
 * @param {unknown} err 抛出的错误
 * @returns {void} 直接写到 stderr,无返回值
  - @param {any} err 参数
*/
export function reportStartupFailure(err: unknown): void {
  const detail = err instanceof Error ? err.stack || err.message : String(err)
  const lines = [
    '',
    '[freebuff-proxy]  启动失败（服务未能进入监听状态）',
    `  错误: ${err instanceof Error ? err.message : String(err)}`,
  ]

  const bad = invalidDataFiles()
  const dirty = dirtyDataFiles()
  if (bad.length) {
    lines.push('  数据文件损坏:')
    for (const f of bad) {
      lines.push(`    - ${f.file}`)
      lines.push(`      原因: ${f.reason}`)
      lines.push(`      处置: 停服后 mv ${f.file} ${f.file}.broken 再启动（程序会按默认值重建）`)
    }
  }
  if (dirty.length) {
    lines.push('  数据文件含非法条目（已自动丢弃，原文留证）:')
    for (const f of dirty) {
      lines.push(
        `    - ${f.file} — ${f.droppedReason}（丢弃 ${f.droppedEntries} 条）` +
          (f.droppedBackup ? `，留证: ${f.droppedBackup}` : ''),
      )
    }
  }

  // 写盘被中断的残留:*.tmp 是原子写的中间态,正常完成后不会留在盘上.
  try {
    const dataDir = loadConfig(parseConfigPath(process.argv.slice(2))).server.dataDir
    const tmps = fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))
    if (tmps.length) {
      lines.push('  残留的写盘中间文件（上次写盘被中断，可安全删除）:')
      for (const t of tmps) lines.push(`    - ${path.join(dataDir, t)}`)
    }
  } catch {
    // 数据目录读不了不影响诊断输出
  }

  // 配置 / 凭据这两类问题的堆栈一眼看不出处置办法,单独点名.
  if (/YAMLParseError|YAML/i.test(detail)) {
    lines.push(
      '  看起来是 config.yaml 解析失败（多为手工编辑出错）。',
      `      处置: 备份后移走它（mv <dataDir>/config.yaml <dataDir>/config.yaml.broken），` +
        '程序会用内置默认值启动，再重新编辑。',
    )
  }
  if (/Invalid account key/i.test(detail)) {
    lines.push(
      '  看起来是某个账号凭据文件里的 id/email 不能当文件名用（空 / . / .. 等）。',
      '      处置: 检查 credentials/ 下的 *.json，修好或移走有问题的那一个；本版本起会跳过它并点名。',
    )
  }
  if (!bad.length && !dirty.length) {
    lines.push(
      '  未发现明显的数据文件问题。请把上面的完整堆栈发给维护者；' +
        '临时处置：把 data/ 下的状态 JSON 逐个移走（保留 credentials/）以定位是哪一个。',
    )
  }
  lines.push(
    '  提示: 控制台「系统 → 数据文件自检」(/api/system/data-status) 也列出同样的信息.',
    '',
  )
  console.error(lines.join('\n'))
  console.error(detail)
}
