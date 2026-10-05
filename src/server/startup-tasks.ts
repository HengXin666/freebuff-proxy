/**
 * 启动期副作用 ---- 目前只有一件:把内置 catalog 落成缓存文件.
 *
 * catalog 自动同步(model.startCatalogSync, 周期拉 GitHub 常量文件)保持停用:
 * 模型清单的来源是上游目录 rows(见 docs/reverse/19-catalog-is-the-model-list.md),
 * 定时覆盖缓存会引入陈旧数据.需要时由维护者手动触发.
 *
 * 缓存 seed 失败(只读挂载 / 磁盘满 / 首次启动目录为空)一律吞掉, 不影响代理
 * 可用性; 路径先切到 <dataDir>/ 再读缓存, 缺缓存时用内置 catalog 落一份.
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
