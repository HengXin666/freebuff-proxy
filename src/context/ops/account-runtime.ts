/**
 * 账号 runtime 的懒创建与凭据变更重建.
 *
 * 懒创建: 启动时不碰任何上游(零自动探测), 只有真实请求需要一个账号时才建它的
 * upstream 与 SessionManager. 凭据(token/代理)变更时旧 runtime 立即让位, 会话
 * 则在在途请求结束后释放.
 */
import path from 'node:path'
import { accountKeyOf, readAccountUser } from '../../auth-store.ts'
import { SessionManager } from '../../session-manager.ts'
import { UpstreamError, createUpstreamClient } from '../../upstream/client.ts'
import { runWithLogContext } from '../../util/log.ts'
import { _disposeRuntime } from './account-ops.ts'
import { _hydrateRuntime } from '../state/account-lifecycle.ts'

/**
 * 建这个账号的上游客户端, 并把创建期的日志归到该账号名下.
 *
 * @param {any} self 账号池(runtimes)
 * @param {any} user 账号凭据记录
 * @param {string} accountKey 账号 key(凭据文件名: 可能是邮箱)
 * @returns {any} 上游客户端
 */
function buildUpstream(self: any, user: any, accountKey: string): any {
  const ctx = { account: user.email || accountKey, key: accountKey }
  return runWithLogContext(ctx, () =>
    createUpstreamClient(self.config, user.authToken, {
      proxy: user.proxy || null,
      //  accountId 用于两处,语义不同但都需要账号 user id:
      //   1) 代理池稳定分配(同一账号固定出口)
      //   2) 官方 chat 的 x-freebuff-acting-user-id(真机抓包确认是 user id)
      // 取自 user.id (accountKey 是凭据文件名, 可能是邮箱).
      accountId: user.id || accountKey,
      // 设备签名密钥落盘位置:与上游官方 CLI 同款(每账号一个文件).
      // 上游据此判定[是不是注册过的真客户端]----见 src/upstream/device-signing.ts
      deviceKeyPath: path.join(
        self.config.server.dataDir,
        'device-keys',
        `${accountKey}.json`,
      ),
    }),
  )
}

/**
 * 取(必要时懒创建)某账号的 runtime.
 *
 * 凭据(token/代理)变更时旧 runtime 立即让位: 先释放它的会话, 再关出网
 * agent. 新 runtime 会从账本回灌 freebucks/quota/lastProbe/冷却.
 * @param {any} this 账号池(runtimes)
 * @param {string} key 账号 key(id 或旧布局的邮箱)
 * @returns {any} 账号 runtime
 */
export function get(this: any, key: any) {
    const user = readAccountUser(this.dir, key)
    if (!user?.authToken) {
      throw new UpstreamError(`Account not found or not logged in: ${key}`, {
        status: 401,
        code: 'upstream_auth_missing',
      })
    }
    const accountKey = accountKeyOf(user)

    const existing = this.byKey.get(accountKey)
    if (
      existing &&
      existing.authToken === user.authToken &&
      existing.proxy === (user.proxy || null)
    ) {
      return existing
    }
    if (existing) {
      // 账号信息变更(token/代理): 旧 runtime 让位, 其会话等在途请求结束后释放;
      // 等待方会在 chat 流程通过 isCurrentRuntime 检测到已被顶替并重新选号.
      this._disposeRuntime(existing, 'account credentials/proxy changed')
      this.byKey.delete(accountKey)
    }

    const upstream = buildUpstream(this, user, accountKey)
    const sessions = new SessionManager({
      upstream,
      config: this.config,
      accountKey,
      // 日志上下文的 account 字段按账号固定注入, 覆盖探测/刷新/选号/空闲释放等路径.
      logContext: { account: user.email || accountKey, key: accountKey },
      // 句柄变更落盘(track/clear/orphan)----见 SessionHandleStore.
      onSessionChange: (ev: any) => this.handleStore.handleEvent(ev),
      // 模型标识归一(目录 key / 上游 id / 可读名 → 目录 key).
      resolveModelAlias: (m: any) => this.resolveModelAlias(m),
      // 账号账目落盘(freebucks/quota/lastProbe)----见 AccountStateStore.
      onStateChange: (snap: any) => this._persistAccountState(accountKey, snap),
      getSessionSettings: this._getSessionSettings,
      // 该账号还有在途/排队的 chat 时,空闲释放让路(见 SessionManager._armIdleRelease)
      hasPendingUser: () => {
        const lock = this.chatLocks.get(accountKey)
        return Boolean(lock && (lock.inFlight > 0 || lock.queued > 0))
      },
    })
    const runtime = {
      key: accountKey,
      id: user.id || null,
      email: user.email,
      authToken: user.authToken,
      proxy: user.proxy || null,
      /** 实际生效的出网代理(全局池分配 / 账号覆盖 / env) */
      effectiveProxy: upstream.proxyUrl || null,
      user,
      upstream,
      sessions,
      source: `credentials:${accountKey}`,
    }
    this.byKey.set(accountKey, runtime)
    // 账本回灌(freebucks/quota/lastProbe/冷却)在 runtime 建好之后做:
    // runtime 是懒创建的, 构造函数执行时 byKey 还是空的.
    this._hydrateRuntime(runtime)
    this.accountState.patch(accountKey, { email: user.email })
    return runtime
}

/**
 * 取 runtime 供[只读展示]用: 拿不到就返回 null, 绝不抛.
 *
 * 与 get() 的唯一差别是失败姿态: get() 的调用方是转发链路, 凭据不可用必须
 * 显式报错; 而控制台账号表只是展示, 某个账号凭据读不出来时应当继续把其余
 * 账号渲染出来, 不能整张表崩掉.
 *
 * 为什么必须有这个入口(2026-10-06 实测缺陷): 控制台账号表原先写的是
 * this.byKey.get(key) ---- 直接读 Map, 绕过懒创建. 而 freebucks / quota /
 * lastProbe 是在 _hydrateRuntime 里从账本回灌的, 只挂在[创建出来的] runtime
 * 上. 服务重启后 byKey 是空的, 首屏于是把这三个字段全部读成 null:
 * 账号行显示不出余额与额度, 必须手动点一次刷新(那一跳会走 get() 建 runtime)
 * 才回来. 这正是用户报的"首次打开网页拿不到上次缓存的账号状态".
 *
 * 回灌只读账本, 不发任何上游请求, 因此首屏调用它不违反[零自动探测]
 * (见 docs/reverse/20 §20.3).
 *
 * @param {any} this 账号池(runtimes)
 * @param {string} key 账号 key(id 或旧布局的邮箱)
 * @returns {any | null} 账号 runtime;凭据不可用为 null
 */
export function runtimeFor(this: any, key: any) {
  if (typeof key !== 'string' || !key) return null
  try {
    return this.get(key)
  } catch {
    // 凭据缺失/读不出来: 该账号照样出现在表里(账本与凭据列表是两处来源),
    // 只是拿不到运行时会话那部分字段 ---- 由调用方按 null 处理.
    return null
  }
}
