/**

 * mock 上游的安装入口与路由
 *
 * 原 smoke.ts 用一句 globalThis.fetch 装了 619 行的 mock; 这里只留路由, 各端点实现搬进同目录模块. 必须在 harness/runtime.ts 之前调用, 否则建 server
  * 时会打向真实上游.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { state } from '../../../../smoke/state.ts'
import { jsonRes } from '../helpers.ts'
import { handleAdmissionPost } from './admission.ts'
import { handleAgentRunsPost } from './agent-runs.ts'
import { handleChatCompletions } from './chat/index.ts'
import { handleSessionDelete } from './session-delete.ts'
import { handleSessionGet } from './session-get.ts'

/** 安装 mock 上游. 对 127.0.0.1 / localhost 的请求仍走真实 fetch(被测 server 就在那里).
 * @returns {any}
 */
export function installMockFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) {
      return state.originalFetch(url, init)
    }
    const method = (init.method || 'GET').toUpperCase()
    const headers = init.headers || {}
    state.calls.push({ url: u, method, headers, body: init.body })

    if (u.includes('/api/v1/me')) {
      return jsonRes({ id: 'u1', email: 'a@b.c' })
    }
    if (u.includes('/api/v1/freebuff/session/admission') && method === 'POST') return handleAdmissionPost(headers)
    if (u.includes('/api/v1/freebuff/session') && method === 'GET') return handleSessionGet(headers)
    if (u.includes('/api/v1/freebuff/session') && method === 'DELETE') return handleSessionDelete(headers)
    if (u.includes('/api/v1/agent-runs') && method === 'POST') return handleAgentRunsPost(headers, init)
    if (u.includes('/api/v1/chat/completions')) return handleChatCompletions(init)
    return jsonRes({ error: 'unexpected ' + u }, 500)
  }
}
