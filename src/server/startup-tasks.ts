/**
 * 启动期副作用 ---- 目前只有一件:把内置 catalog 落成缓存文件.
 *
 * ## 为什么"自动同步"是停用的(不要顺手接回来)
 *
 * model.startCatalogSync 会周期去 GitHub 拉 Codebuff 的常量文件,写出的正是
 * data/catalog-cache.json.但那份 2026-08 的快照已经不是模型清单的来源
 * ---- 清单现在取上游目录 rows(见 docs/reverse/19-catalog-is-the-model-list.md).
 * 留着定时任务只会持续用陈旧数据覆盖缓存.
 *
 * 保留函数不调用:需要时由维护者手动触发(npm run 脚本或控制台).
 *
 * ## 为什么这里必须吞异常
 *
 * 缓存 seed 失败(只读挂载 / 磁盘满 / 首次启动目录为空)不该影响代理可用性.
 * 历史上这里出过 issue #9:缓存路径写死源码目录旁的 <repo>/data,容器里是只读的
 * /app/data → mkdir EACCES → 目录同步永远失败,而日志里只有一行 warn.
 * 现在路径先切到 <dataDir>/ 再读缓存,缺缓存时用内置 catalog 落一份.
 */
import { logger } from '../util/log.ts'

/** 统一的错误取文本. */
function msgOf(err: any) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 异步 seed 内置 catalog 缓存(失败只告警,绝不影响启动).
 * @param {{ server: { dataDir: string } }} config 运行时配置
 * @returns {void} 本函数不等待 seed 完成
 */
export function seedCatalogCache(config: any) {
  import('../model.ts')
    .then(async (model) => {
      try {
        const cache = model.applyCatalogCache?.(config.server.dataDir)
        if (cache?.path && cache.models?.length) {
          const { writeCatalogCache } = await import('../catalog/runtime-sync.ts')
          writeCatalogCache(cache.path, {
            version: 1,
            syncedAt: new Date().toISOString(),
            source: 'builtin:src/catalog/freebuff-catalog.json',
            models: cache.models,
          })
        }
      } catch (err) {
        logger.warn('catalog cache seed skipped', { error: msgOf(err) })
      }
      void model.startCatalogSync
    })
    .catch((err) => {
      logger.warn('catalog auto-sync disabled', { error: msgOf(err) })
    })
}
