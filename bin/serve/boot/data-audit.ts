/**
 * 数据文件定点自检(启动横幅) -- 从 bin/serve.ts 按职责切出.
 *
 *
 * 口径: 纯搬移, 不改行为, 不改任何一行用户可见文案.
 */
import { logger } from '../../../src/util/log.ts'
import { dataFileAudit, invalidDataFiles, dirtyDataFiles } from '../../../src/util/json-store.ts'

/**
 * 数据文件定点自检(启动横幅):把 data/ 下每个 JSON 的装载结果打印一行.
 * 起因是真实故障--镜像升级后服务起不来,而日志里只有一行 warn,用户只能
 * 靠"删掉几个 json 就好了"这种试错.现在启动时明确说清楚:哪些文件正常,
 * 哪些缺失(首次启动),哪些损坏以及怎么处置.
 * @returns {void} 只打印, 无返回值
 */
export function logDataFileAudit() {
  const files = dataFileAudit()
  if (!files.length) return
  const bad = invalidDataFiles()
  const dirty = dirtyDataFiles()
  logger.info('data files checked', {
    total: files.length,
    ok: files.filter((f) => f.status === 'ok').length,
    missing: files.filter((f) => f.status === 'missing').length,
    invalid: bad.length,
    // 条目级问题(文件合法但丢过脏条目):与"文件损坏"分开计数,处置办法也不同
    droppedEntries: dirty.reduce((n, f) => n + (f.droppedEntries || 0), 0),
  })
  for (const f of bad) {
    console.error(
      `[freebuff-proxy]  数据文件损坏: ${f.file}\n` +
        `  原因: ${f.reason}\n` +
        `  处置: 停服后把该文件移走（mv ${f.file} ${f.file}.broken）再启动即可，\n` +
        `        程序会按默认值重建；要保留历史就先备份。控制台「系统 → 数据文件自检」也会列出。\n`,
    )
  }
  for (const f of dirty) {
    console.error(
      `[freebuff-proxy]  数据文件含非法条目: ${f.file}\n` +
        `  原因: ${f.droppedReason}（丢弃 ${f.droppedEntries} 条）\n` +
        (f.droppedBackup ? `  原文留证: ${f.droppedBackup}\n` : '') +
        `  处置: 无需人工干预——坏条目已被丢弃，服务照常运行；\n` +
        `        想核对丢了什么就打开上面的留证文件。控制台「系统 → 数据文件自检」也会列出。\n`,
    )
  }
  if (bad.length || dirty.length) {
    logger.warn('data file problems detected (service continues in degraded mode)', {
      files: bad.map((f) => f.file),
      dirtyFiles: dirty.map((f) => f.file),
    })
  }
}
