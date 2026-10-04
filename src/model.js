/**
 * Freebuff 模型目录与模型标识助手 -- DATA-DRIVEN.
 *
 * 三层模型元信息(优先级从高到低):
 *   1. 前端自定义模型(ModelStore,data/custom-models.json) -- 操作者手动覆盖/新增
 *   2. 内置 catalog(src/catalog/freebuff-catalog.json) -- 从 Codebuff 源码
 *      common/src/constants/free-agents.ts + freebuff-models.ts 提取,
 *      可用 scripts/sync-catalog.mjs 一键重新同步(上游加新模型不再需要改代码)
 *   3. 命名规则推导 -- 未知模型按 base2-free-<slug> 推导 agent(兜底)
 *
 * Wire ids match Freebuff/Codebuff clients (no local aliases).
 *
 * 本文件是薄门面(barrel):实现已按职责拆进 ./model/ --
 *   catalog-store.js  内置/缓存 catalog 载入与合并(唯一有磁盘 IO 的一层)
 *   agents.js         agent 推导 + agent 索引 + 目录名单一真源
 *   flags.js          isFreeModel / isPremiumModel(档位判定)
 *   list-response.js  /v1/models 清单构建 + isModelAllowed
 *   sync.js           运行时 catalog 自动同步入口
 *
 * 依赖方向严格单向:catalog-store <- agents <- list-response,无环.
 * 保留原路径与全部原有导出名,既有 import 点一处都不用改.
 *
 * 惰性加载的必要性(实测,Node v26.10.0):本模块若在顶层读 catalog 缓存并建
 * 多张索引表,同进程内 catalog-models.js 产出的对象会静默丢字段
 * (freebucks_per_hour 等变 null,连 JSON.stringify 都拿不到),而单独导入
 * catalog-models.js 则完全正常 -- 与导入顺序无关,只要本模块被求值就会触发.
 * 改成惰性后两种模块共存时行为一致.
 */
export {
  CATALOG_CACHE_FILENAME,
  DEFAULT_CATALOG_CACHE_PATH,
  applyCatalogCache,
  catalogCachePath,
  catalogModels,
  configureCatalogCache,
  loadBuiltinCatalog,
  loadCatalog,
  mergeCatalogWithBuiltin,
} from './model/catalog-store.ts'

export {
  CATALOG_UNIFIED_AGENT_ID,
  agentFallbackForModel,
  agentIdForModel,
  agentMetaForModel,
  catalogDisplayName,
  deriveAgentId,
  ensureAgentIndex,
  forcedBase3AgentForModel,
  isCatalogModelId,
  requireModelId,
} from './model/agents.ts'

export { isFreeModel, isPremiumModel } from './model/flags.ts'

export {
  FREEBUFF_AVAILABLE_MODELS,
  buildModelsListResponse,
  freebuffAvailableModels,
  isModelAllowed,
  modelIdsFromSession,
} from './model/list-response.ts'

export { startCatalogSync } from './model/sync.ts'
