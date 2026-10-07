/**
 * 运行时 catalog 自动同步的启动入口.
 *
 * 从 src/model.ts 拆出(原 758 行单文件).
 */
import { currentCatalogCachePath } from './catalog-store.ts'

/**
 * 启动运行时 catalog 自动同步(对齐 trefeon refreshLoop:启动立即一次 +
 * 每 intervalMs 一次).拉上游源码解析 model->agent,原子写生效缓存路径;
 * 失败保留旧缓存.供 server 启动时调用.
 *
 * 懒 import runtime-sync,避免 model 模块顶部引入网络依赖.
 *
 * @param {SyncOpts} [opts] 同步选项(config 用于解析统一出口)
 * @returns {{ stop: () => void, refresh: () => Promise<{ ok: boolean, error?: string, models?: number }> }}
 *   同步控制器
 */
/** 同步启动选项. */
export interface SyncOpts {
  intervalMs?: number
  log?: (msg: string) => void
  fetchImpl?: Function
  config?: any
}

/** 同步控制器. */
export interface CatalogSyncController {
  stop: () => void
  refresh: () => Promise<{ ok: boolean, error?: string, models?: number }>
}

export function startCatalogSync(opts: SyncOpts = {}): CatalogSyncController {
  const inner: { current: any } = { current: null }
  // 先同步拉起模块再启动循环(首启即刷).
  import('../catalog/runtime-sync.ts')
    .then((m) => {
      inner.current = (m as any).startCatalogSync(currentCatalogCachePath(), {
        intervalMs: opts.intervalMs,
        log: opts.log,
        fetchImpl: opts.fetchImpl,
        config: opts.config,
      })
    })
    .catch((err) => {
      if (opts.log) {
        opts.log(`catalog sync disabled: ${err instanceof Error ? err.message : err}`)
      }
    })
  return {
    stop: () => inner.current?.stop?.(),
    refresh: () =>
      inner.current
        ? inner.current.refresh()
        : Promise.resolve({ ok: false, error: 'sync not started yet' }),
  }
}
