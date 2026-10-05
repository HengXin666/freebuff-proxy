/**
 * /v1/models 清单构建与模型可见性判定 ---- 薄门面.
 *
 * 依赖方向:list-response -> {rows, build, allow},单向无环.
 *
 * 从 src/model.ts 拆出(原 758 行单文件), 2026-10-05 再按职责拆进
 * ./model/response/**: 对外模型行(rows) / 清单合并(build) / 白名单判据(allow)
 * 三件事各自被不同调用点使用, 且 allow 是 chat 入口的准入闸门, 不该为读它
 * 连带装上清单合并的两段铺表逻辑.
 *
 * 保留原路径与全部原有导出名, 既有 import 点一处都不用改.
 */
export {
  FREEBUFF_AVAILABLE_MODELS,
  freebuffAvailableModels,
} from './response/catalog-response.ts'

export { buildModelsListResponse, modelIdsFromSession } from './response/build.ts'

export { isModelAllowed } from './response/allow.ts'

export { isFreeModel, isPremiumModel } from './flags.ts'
