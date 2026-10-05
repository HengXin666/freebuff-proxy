/**
 * session 子模块的装配表: 方法名 -> 实现.
 *
 * 为什么要有这张表: SessionManager 的 49 个方法原先散在一个类里, 搬出去之后
 * 必须有一处"显式登记", 否则漏挂一个方法只会在运行时表现为
 * "x is not a function", 而静态检查抓不到(check-declared 只抓未声明标识符).
 *
 * 口径: 只按名字注册, 名字必须与调用点逐字一致. 新增方法先在这里出现,
 * 再写实现 -- 登记表是导出面的唯一清单.
 */
import {
  _absorbInventory,
  getSnapshot,
  hasInventorySnapshot,
  holderFor,
  inFlightCount,
  knownInstances,
} from './observe/snapshot.ts'
import {
  _armPoll,
  _clearPoll,
  _sendHoldHeartbeat,
  _setLastProbe,
  refresh,
} from './observe/probe.ts'
import {
  _apply,
  _emitRefund,
  _emitSessionEvent,
  _notifySessionChange,
  _notifyStateChange,
} from './observe/events.ts'
import {
  freebucksFor,
  hasLiveSlot,
  isUsableForModel,
  reAdmitLeadMs,
  sessionUnitsFor,
  switchWaitMs,
} from './core/gate.ts'
import {
  _armIdleRelease,
  _clearIdleRelease,
  _emitScheduling,
  _notifyScheduleChange,
  _settleScheduling,
  _waitForIdle,
  beginRequest,
  currentSchedulingMs,
  endRequest,
  idleReleaseMs,
  inPaidWindow,
  paidWindowRemainingMs,
  withLock,
} from './core/lease.ts'
import {
  _admitUnlocked,
  _terminalSessionError,
} from './admit/turn.ts'
import { ensureSession } from './admit/ensure.ts'
import { forceReadmit, readmitToContinue } from './admit/reuse.ts'
import {
  _releaseUnlocked,
  release,
  releaseIfLive,
  releaseStrict,
  releaseWhenIdle,
  shutdown,
} from './release/release.ts'
import {
  _clearRefundRetry,
  _replayPendingRefund,
  _scheduleRefundRetry,
} from './release/refund.ts'
import { _clearReleaseRetry, _scheduleReleaseRetry } from './release/release.ts'

/** 方法名 -> 实现函数. 名字即契约, 必须与调用点逐字一致. */
export const SESSION_METHODS: Record<string, any> = {
  // 租约与互斥
  beginRequest,
  endRequest,
  currentSchedulingMs,
  _settleScheduling,
  _emitScheduling,
  _notifyScheduleChange,
  idleReleaseMs,
  paidWindowRemainingMs,
  inPaidWindow,
  _armIdleRelease,
  _clearIdleRelease,
  _waitForIdle,
  withLock,
  // 闸门与可用性
  sessionUnitsFor,
  freebucksFor,
  reAdmitLeadMs,
  switchWaitMs,
  isUsableForModel,
  hasLiveSlot,
  // 现场与快照
  _apply,
  _notifySessionChange,
  _emitSessionEvent,
  _emitRefund,
  _notifyStateChange,
  getSnapshot,
  inFlightCount,
  knownInstances,
  hasInventorySnapshot,
  _absorbInventory,
  holderFor,
  // 探测与轮询
  refresh,
  _setLastProbe,
  _sendHoldHeartbeat,
  _armPoll,
  _clearPoll,
  // admission
  ensureSession,
  _admitUnlocked,
  _terminalSessionError,
  forceReadmit,
  readmitToContinue,
  // 释放与退款
  release,
  releaseWhenIdle,
  releaseIfLive,
  _releaseUnlocked,
  releaseStrict,
  shutdown,
  _scheduleRefundRetry,
  _replayPendingRefund,
  _clearRefundRetry,
  _scheduleReleaseRetry,
  _clearReleaseRetry,
}
