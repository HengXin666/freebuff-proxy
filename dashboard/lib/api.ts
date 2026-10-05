import { t } from '../locale/index.ts'
import { state } from './state.ts'

/**
 - 统一的 API 客户端.
 *
 - 两条跨模块契约必须留在这一层(其余视图只关心 await api(...)):
 - 1. 401 = 登录态失效:清空 state.me 并触发整壳重建.触发方式是回调注入
 - (setUnauthorizedHandler(render),见 app.js 装配),不在这里 import 渲染器
 - ---- 否则 lib/ → views/ → lib/ 成环,模块图会退化成"谁先加载谁赢".
 - 2. 错误携带结构化判据:err.code(稳定业务码)/err.cause(底层原因码)
 - 一并挂上.以前只传中文文案字符串,调用方想区分故障类型只能解析文案,
 - 文案一改就崩.
 */

/** 登录态失效时的处理函数(由入口装配层注入). */
let onUnauthorized = () => {}

/**
 - 注册登录态失效回调(入口装配层在启动时调用一次).
 - @param {() => void} fn 收到 401 时要执行的整壳重建动作
 - @returns {void}
 */
export function setUnauthorizedHandler(fn: any) {
  onUnauthorized = typeof fn === 'function' ? fn : () => {}
}

/**
 - 请求 JSON API 并返回解析后的 body.
 - @param {string} path 接口路径(如 /api/overview)
 - @param {RequestInit} [opts] fetch 选项(headers 会与默认 content-type 合并)
 - @returns {Promise<any>} 解析后的响应体(非 JSON 时为 null)
 */
export async function api(path: string, opts: any = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  let body = null
  try { body = await res.json() } catch { /* noop */ }
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    state.me = null
    onUnauthorized()
    throw new Error(body?.error || t('login.notSignedIn'))
  }
  if (!res.ok) {
    /**
     - 除 message 外,把后端给的结构化判据挂在 error 上:
     - code(稳定业务码,如 upstream_timeout / upstream_network)
     - cause(底层原始码,如 ECONNREFUSED / ENOTFOUND)
     *
     - 以前只传 body.error 字符串,前端想区分故障类型只能解析中文文案,
     - 文案一改就崩.现在调用方可以按 err.code 做不同提示.
     */
    const err: any = new Error(body?.error || `HTTP ${res.status}`)
    err.code = body?.code ?? null
    err.cause = body?.cause ?? null
    err.status = res.status
    throw err
  }
  return body
}
