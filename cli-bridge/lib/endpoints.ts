/**
 - Bridge 端点方法的薄门面 -- 实现已拆进 cli-bridge/lib/endpoints/**.
 *
 - 为什么保留本文件: cli-bridge/upstream.ts 写的是 './lib/endpoints.ts',
 - 门面让"实现拆目录"与"改消费者 import"解耦. 口径: 只许 re-export.
 */
export { auth, fetchCatalog, registerDeviceKey, getSession, release } from './endpoints/reads.ts'
export { admit, startRun, reuseChat, finishRun, _traceFor, _stepFor } from './endpoints/session.ts'
export {
  buildTools, buildSystemMessages, buildMetadata,
  buildBody, buildHeaders, extractMessageId,
} from './endpoints/chat-payload.ts'
export { chat } from './endpoints/chat.ts'
