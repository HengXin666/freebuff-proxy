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
 *   catalog-store.ts  内置/缓存 catalog 载入与合并(唯一有磁盘 IO 的一层)
 *   agents.ts         agent 推导 + agent 索引 + 目录名单一真源
 *   flags.ts          isFreeModel / isPremiumModel(档位判定)
 *   list-response.ts  /v1/models 清单构建 + isModelAllowed
 *   sync.ts           运行时 catalog 自动同步入口
 *
 * 依赖方向严格单向:catalog-store <- agents <- list-response,无环.
 * 保留原路径与全部原有导出名,既有 import 点一处都不用改.
 *
 * catalog 缓存按需惰性读取: 不在模块顶层读盘并建索引表, 避免与
 * catalog-models.ts 共存时后者产出对象的字段丢失.
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
