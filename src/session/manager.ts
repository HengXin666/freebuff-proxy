/**
 * SessionManager 的实现: 薄门面 src/session-manager.js 转发到这里.
 *
 * 方法实现按域放在 src/session/{core,observe,admit,release}/ 下, 这里只做
 * 三件事: 生成会话实例 id, 建状态容器, 把方法挂到原型上.
 *
 * 为什么用"原型装配"而不是 import 49 个方法逐个赋值: 逐个赋值会在
 * 类里再写一遍名字, 而重复的名字正是本仓出过事故的地方. 装配表
 * (./methods.ts)是唯一清单, 与调用点同名.
 *
 * 构造函数的口径必须逐字保留: test/verify-model-mapping-truth.mjs 与
 * test/smoke.mjs 都直接 new SessionManager({...}) 并断言解构到的参数
 * (resolveModelAlias 漏解构曾让归一静默失效).
 */
import { newRawInstanceId } from '../upstream/official-fingerprint.js'
import { SESSION_METHODS } from './methods.ts'
import { createSessionState, installSessionState } from './state.ts'

/** 本进程复用的会话实例 id 来源(裸 UUID, 见 official-fingerprint). */
function newManagerInstanceId(): string {
  return newRawInstanceId()
}

/**
 * 管理本进程的单个 Freebuff 免费会话槽位.
 *
 * 模型一律取自下游请求, 从不使用代理侧的默认模型. 方法实现按域分散在
 * src/session/{core,observe,admit,release}/, 由 ./methods.ts 装配到本原型上;
 * 构造时解构的参数必须是显式的 -- 漏解构 resolveModelAlias 曾让模型归一
 * 静默失效(见 test/verify-model-mapping-truth.mjs).
 */
export class SessionManager {
  /**
   * @param {object} opts 构造参数
   * @param {any} opts.upstream 上游客户端
   * @param {any} opts.config 配置
   * @param {(() => any) | null} [opts.getSessionSettings] 控制台额度保护设置
   * @param {(() => boolean) | null} [opts.hasPendingUser] 是否有请求排队等这个账号
   * @param {string | null} [opts.accountKey] 账号标识(sessions.json 的 owner key)
   * @param {any} [opts.logContext] 日志上下文(account/key)
   * @param {((entry: any) => void) | null} [opts.onSessionChange] 会话句柄变化通知
   * @param {((patch: any) => void) | null} [opts.onStateChange] 账号账目变化通知
   * @param {((v: any) => any) | null} [opts.resolveModelAlias] 模型标识归一函数
   */
  constructor(opts: any) {
    const withId = { ...opts, instanceId: newManagerInstanceId() }
    installSessionState(this, createSessionState(withId), {
      upstream: opts.upstream,
      config: opts.config,
    })
  }
}

Object.assign(SessionManager.prototype, SESSION_METHODS)
