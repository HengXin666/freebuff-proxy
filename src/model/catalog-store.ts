/**
 * catalog 载入与运行时缓存路径  --  内置静态 catalog + dataDir 派生缓存合并.
 *
 * 合并规则(对齐 trefeon:registry 管 agent 映射,modelcat 管 pool/cap):
 *   - 缓存里的模型若内置 catalog 已存在 -> 保留内置的 pool/note 等元信息,
 *     但 agent 映射(agentId/fallbackAgentId)用缓存的(跟随上游最新状态);
 *   - 缓存里新增的模型(内置没有)-> 直接采用缓存条目;
 *   - 缓存不存在/损坏/为空 -> 纯内置 catalog(基线行为,与改动前一致).
 *
 * 从 src/model.ts 拆出(原 758 行单文件).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readJsonFileState,
  noteDataFile,
  quarantineFile,
  invalidShape,
} from '../util/json-store.ts'

/** 内置静态 catalog 的路径(<src>/catalog/freebuff-catalog.json). */
export const CATALOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'catalog',
  'freebuff-catalog.json',
)

/** 运行时 catalog 缓存文件名(写在 dataDir 下). */
export const CATALOG_CACHE_FILENAME = 'catalog-cache.json'

/**
 * 运行时 catalog 缓存的默认路径(仓库根 ./data/catalog-cache.json).
 * 仅作裸机默认值;Docker 等 dataDir 可配置的场景必须显式传 dataDir
 * (见 catalogCachePath / configureCatalogCache),否则会写到只读的
 * 安装目录(旧行为写死 /app/data,容器里降权后 EACCES,见 issue #9).
 */
export const DEFAULT_CATALOG_CACHE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  CATALOG_CACHE_FILENAME,
)

/**
 * dataDir -> 缓存文件路径.
 *
 * @param {string} dataDir 数据目录
 * @returns {string} 缓存文件绝对路径
 */
export function catalogCachePath(dataDir: string): string {
  return path.join(dataDir, CATALOG_CACHE_FILENAME)
}

/**
 * 运行时缓存的生效路径.模块加载时按默认值算一次(首次读缓存用),
 * server 启动时由 configureCatalogCache(dataDir) 改写到 <dataDir>/.
 * @type {string}
 */
let catalogCachePathInUse = DEFAULT_CATALOG_CACHE_PATH

/**
 * 当前生效的缓存路径(读路径).
 *
 * @returns {string} 绝对路径
 */
export function currentCatalogCachePath(): string {
  return catalogCachePathInUse
}

/**
 * server 启动时把缓存路径切到 <dataDir>/catalog-cache.json(并在空目录上
 * 预创建).必须在 startCatalogSync 之前调用:读(loadCatalog 已在模块加载时
 * 执行,故 server 场景下用 applyCatalogCache)与写必须指向同一目录.
 *
 * @param {string} dataDir 数据目录
 * @returns {string} 生效的缓存路径
 */
export function configureCatalogCache(dataDir?: string): string {
  if (!dataDir) return catalogCachePathInUse
  catalogCachePathInUse = catalogCachePath(dataDir)
  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (err) {
    console.warn(
      `[model] dataDir not writable (${catalogCachePathInUse}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  return catalogCachePathInUse
}

/**
 * 读取内置 catalog(解析失败时回退空列表,不阻塞启动).
 * 内置 catalog 的 pool/note/displayName 是手工精修过的静态元信息
 * (premium/referral/withdrawn 语义),动态缓存不覆盖它们.
 *
 * @returns {any[]} 内置模型行
 */
export function loadBuiltinCatalog(): any[] {
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))
    return Array.isArray(raw?.models) ? raw.models : []
  } catch (err) {
    console.warn(
      `[model] failed to load catalog ${CATALOG_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return []
  }
}

/**
 * 把运行时缓存合并进内置 catalog(拆成纯函数便于测试,见 test/smoke.mjs).
 *
 * @param {any[]} builtin 内置行
 * @param {any[] | null} cached 缓存行
 * @returns {any[]} 合并结果
 */
export function mergeCatalogWithBuiltin(builtin: any[], cached: any[] | null): any[] {
  if (!cached) return builtin

  const builtinById = new Map(builtin.map((m: any) => [m.id, m]))
  return cached.map((cm) => {
    const bm = builtinById.get(cm.id)
    if (!bm) return cm
    // 内置元信息优先(手工精修),agent 映射跟随缓存(上游最新).
    return {
      ...cm,
      ...bm,
      agentId: cm.agentId || bm.agentId,
      fallbackAgentId: cm.fallbackAgentId || bm.fallbackAgentId,
    }
  })
}

/**
 * 加载合并后的 catalog:内置 catalog(静态元信息)+ 运行时缓存(动态 agent 映射).
 *
 * 运行时缓存是派生数据(可由内置 catalog / 上游同步重建),所以坏了就当没有
 * -- 但必须显式登记 + 把损坏文件挪走留证,绝不能安静地当"从没同步过".
 *
 * @returns {any[]} 合并后的模型行
 */
export function loadCatalog(): any[] {
  let cached = null
  let st = readJsonFileState(catalogCachePathInUse)
  if (st.status === 'ok' && !Array.isArray(st.data?.models)) {
    st = invalidShape('缺少 models 数组')
  }
  if (st.status === 'invalid') {
    const moved = quarantineFile(catalogCachePathInUse)
    console.warn(
      `[model] catalog 缓存损坏,已忽略并重建${moved ? `(原文件备份为 ${moved})` : ''}: ${st.reason}`,
    )
  }
  noteDataFile(catalogCachePathInUse, st)
  if (st.status === 'ok' && st.data.models.length > 0) cached = st.data.models
  return mergeCatalogWithBuiltin(loadBuiltinCatalog(), cached)
}

/** catalog 模型列表(惰性单例;见 index.js 里对惰性必要性的说明). */
let cachedModels: any[] | null = null

/**
 * 惰性取得的 catalog 模型列表.
 *
 * @returns {any[]} 模型行
 */
export function catalogModels(): any[] {
  if (!cachedModels) cachedModels = loadCatalog()
  return cachedModels
}

/**
 * 切到指定 dataDir 并重新读取合并后的 catalog(供 server 启动时用,替代只读
 * 一次的模块加载期加载).返回生效路径与模型列表:调用方可在缓存文件缺失时
 * 用它兜底写一份(保证 /v1/models 与上游源码解析结果一致).
 *
 * @param {string} dataDir 数据目录
 * @returns {{ path: string, models: any[] }} 生效路径与模型列表
 */
export function applyCatalogCache(dataDir: string): { path: string, models: any[] } {
  const p = configureCatalogCache(dataDir)
  cachedModels = null
  return { path: p, models: catalogModels() }
}
