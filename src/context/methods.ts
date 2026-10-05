/**
 * context 子模块的原型装配表: 方法名 -> 实现.
 *
 * AccountRuntimes 的方法搬出类之后必须显式挂回原型: 漏挂一个, 调用点会在运行时
 * 才炸(x is not a function), 而 check-declared 抓不到 this.x 为 undefined.
 * 装配表是这条契约的唯一清单, 名字与调用点逐字一致.
 *
 * 只登记"以 this 为第一参数"的函数; 纯函数(如 buildAppContext)不走这里.
 */
import {
  _fromCatalogs,
  _modelCatalogId,
  _modelDisplayName,
  _modelKeyForName,
  displayNameFor,
  modelAliases,
  resolveModelAlias,
} from './catalog/account-catalog.ts'
import { catalogQuota, catalogRows, refreshCatalogs } from './catalog/account-rows.ts'
import { list } from './ops/account-list.ts'
import { get, runtimeFor } from './ops/account-runtime.ts'
import {
  _cooldownKey,
  _persistCooldowns,
  _pruneCooldown,
  clearCooldown,
  earliestCooldownMs,
  isCoolingDown,
  markCooldown,
} from './state/account-cooldown.ts'
import {
  acquireChat,
  chatInFlight,
  chatLockFor,
  effectiveLoad,
  isChatBusy,
  reservedCount,
  reserveSlot,
} from './state/account-locks.ts'
import {
  _hydrateRuntime,
  _importedAtHint,
  _persistAccountState,
  _restoreAccountState,
  allKeys,
  getAny,
  flushState,
  forgetAccount,
  markCredentialUpdated,
} from './state/account-lifecycle.ts'
import {
  _disposeRuntime,
  invalidate,
  invalidateProxies,
  isCurrentRuntime,
  reconnectAll,
  releaseAllStrict,
  releaseSession,
  shutdown,
  sweepPendingRefunds,
} from './ops/account-ops.ts'
import {
  _accountConcurrency,
  _recordSuccess,
  _setLastSuccessKey,
  _withAcquireLock,
  acquireForModel,
  everUsed,
  reacquireAfterGate,
  schedulingMode,
} from './sched/account-schedule.ts'
import { candidateKeys } from './select/candidates.ts'
import {
  _acquireForModelUnlocked,
  _reacquireAfterGateUnlocked,
  _retrySameAccount,
} from './acquire/acquire.ts'

/** 方法名 -> 实现. 名字即契约, 必须与调用点逐字一致. */
export const CONTEXT_METHODS: Record<string, any> = {
  // 账号列表与 runtime 懒创建
  list,
  get,
  runtimeFor,
  // 模型目录与标识归一
  _fromCatalogs,
  displayNameFor,
  _modelDisplayName,
  _modelCatalogId,
  _modelKeyForName,
  modelAliases,
  resolveModelAlias,
  catalogRows,
  refreshCatalogs,
  catalogQuota,
  // 冷却账
  _cooldownKey,
  isCoolingDown,
  _pruneCooldown,
  markCooldown,
  clearCooldown,
  _persistCooldowns,
  earliestCooldownMs,
  // chat 并发闸门与预留
  chatLockFor,
  isChatBusy,
  chatInFlight,
  reservedCount,
  effectiveLoad,
  reserveSlot,
  acquireChat,
  // 账号生命周期与账本
  _hydrateRuntime,
  _importedAtHint,
  allKeys,
  getAny,
  forgetAccount,
  markCredentialUpdated,
  _persistAccountState,
  _restoreAccountState,
  flushState,
  // 运维动作
  _disposeRuntime,
  releaseSession,
  isCurrentRuntime,
  invalidate,
  reconnectAll,
  invalidateProxies,
  sweepPendingRefunds,
  releaseAllStrict,
  shutdown,
  // 调度周边
  _accountConcurrency,
  schedulingMode,
  _setLastSuccessKey,
  _recordSuccess,
  _withAcquireLock,
  everUsed,
  acquireForModel,
  reacquireAfterGate,
  // 选号与重试(实现按职责拆在 ./select 与 ./acquire)
  candidateKeys,
  _acquireForModelUnlocked,
  _reacquireAfterGateUnlocked,
  _retrySameAccount,
}
