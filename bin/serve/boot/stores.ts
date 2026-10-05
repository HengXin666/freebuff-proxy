/**
 * 启动期的控制面装配与准入判定 -- 从 bin/serve.ts 的 main() 按职责切出.
 *
 *
 * 口径: 纯搬移, 不改判据, 不改任何一行用户可见文案.
 */
import path from 'node:path'

import { applySavedSettings } from '../../../src/config/tunable/store.ts'

import { logger } from '../../../src/util/log.ts'
import { UserStore } from '../../../src/web/store/session/user-store.ts'
import { WebSessionStore } from '../../../src/web/store/session/session-store.ts'
import { LoginFlowManager } from '../../../src/web/store/session/login-flows.ts'
import { ProxyStore } from '../../../src/web/store/config/proxy-store.ts'
import { SettingsStore } from '../../../src/web/store/config/settings-store.ts'
import { ModelStore } from '../../../src/web/store/config/model-store.ts'

/**
 * @param {string} dataDir 数据目录
 * @returns {any} UserStore 实例
 */
export function createUserStore(dataDir: string): any {
  return new UserStore(path.join(dataDir, 'users.json'))
}

/**
 * 建其余控制面 store, 并把前端[代理设置]管理的全局代理池接进 config.
 * @param {string} dataDir 数据目录
 * @param {any} config 配置(会被就地改写 upstream.proxies)
 * @returns {{ webSessions: any, proxyStore: any, settingsStore: any, modelStore: any }} 四个 store
 */
export function openConsoleStores(dataDir: string, config: any) {
  const webSessions = new WebSessionStore(
    path.join(dataDir, 'web-sessions.json'),
    (config.web.sessionTtlHours || 24 * 7) * 3600 * 1000,
  )
  // 前端[代理设置]管理的全局代理池(优先于 config.yaml 的 upstream.proxies)
  const proxyStore = new ProxyStore(path.join(dataDir, 'proxies.json'))
  const settingsStore = new SettingsStore(path.join(dataDir, 'settings.json'))
  /**
   * 把控制台已保存的可调项合并进 config.
   *
   * 用户裁决(2026-10-05): config.yaml 只留 server.host/port, 其余全部在前端
   * 设置页可调, 生效方式 = 保存后重启. 所以"生效"就发生在这一刻 ---- 合并之后,
   * 全仓 config.limits.* / config.session.* 的读取点一行都不用改.
   *
   * 合并必须在 buildAppContext 之前(它读 config 建各 store), 也必须在本函数内
   * (settingsStore 刚构造完, 值已从盘上读回). 拒绝项要报出来: 静默回落会让
   * 用户"设置了但没生效"却毫无线索.
   */
  const applied = applySavedSettings(config, settingsStore.savedTunables())
  if (applied.rejected.length) {
    logger.warn('部分可调项取值非法, 已回落到 config 默认值', {
      rejected: applied.rejected,
    })
  }
  if (applied.applied.length) {
    logger.info('已应用控制台保存的可调项', { count: applied.applied.length })
  }
  // 前端[模型管理]管理的自定义模型列表(覆盖/扩展内置目录)
  const modelStore = new ModelStore(path.join(dataDir, 'custom-models.json'))
  if (proxyStore.list().length) {
    config.upstream.proxies = proxyStore.list()
  }
  return { webSessions, proxyStore, settingsStore, modelStore }
}

/**
 * users.json 损坏必须拒绝启动.
 *
 * 绝不能"当成还没有账号"继续跑:ensureDefaultAdmin 会立刻新建一个 admin,
 * 用户看到的是"我的账号和密码全没了";而实际上文件还在盘上(多半是被写坏/
 * 版本不兼容),把旧文件挪开就能重新引导.数据目录里的其它文件坏了都只是降级
 * (各自有兜底),只有这一份是登录凭据真源.
 * @param {any} userStore 用户库
 * @returns {boolean} true 表示必须中止启动
 */
export function rejectInvalidUserStore(userStore: any): boolean {
  if (userStore.loadStatus !== 'invalid') return false
  console.error(
    `\n[freebuff-proxy] 拒绝启动：数据文件损坏，不能安全引导管理员账号\n` +
      `  文件: ${userStore.file}\n` +
      `  原因: ${userStore.loadReason}\n\n` +
      `  为什么不能自动重建：users.json 是控制台登录凭据（哈希+API Key）的唯一真源。\n` +
      `  自动重建会新建一个 admin，让你以为"账号全丢了"，而原文件其实还在。\n\n` +
      `  请二选一后重启：\n` +
      `   1) 恢复原文件：把备份/旧版本复制回 ${userStore.file}\n` +
      `   2) 重新引导：mv ${userStore.file} ${userStore.file}.broken 后重启\n` +
      `      （全新管理员密码会打印在日志里；ADMIN_PASSWORD 也可直接指定）\n`,
  )
  return true
}

/**
 * 非回环监听且既无 api_keys 又无 web 用户时拒绝启动(避免裸奔的公开代理).
 * @param {any} config 配置
 * @param {any} userStore 用户库
 * @returns {boolean} true 表示可以继续启动
 */
export function bindIsSafe(config: any, userStore: any): boolean {
  if (
    (config.server.apiKeys || []).length === 0 &&
    !isLoopbackHost(config.server.host) &&
    userStore.all().length === 0
  ) {
    console.error(
      'Refuse to serve: no server.api_keys and no web users while binding a non-loopback host.\n' +
        'Set server.api_keys, create a web user, or bind 127.0.0.1 / localhost / ::1.',
    )
    return false
  }
  return true
}

/**
 * 是否回环地址.
 * @param {unknown} host 监听地址
 * @returns {boolean} 是否回环地址
 */
export function isLoopbackHost(host: any) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host || ''))
}

/**
 * 预载 catalog 运行时缓存.
 *
 * catalog 运行时缓存是懒加载的(第一次用到模型才读).这里先按 dataDir 切路径
 * 并读一次, 保证 /v1/models 与内置目录一致(不再依赖 startServer 里的异步
 * 分支兜底,容器里可能晚于首个请求),二是让"缓存损坏"能出现在下面的自检里.
 * @param {string} dataDir 数据目录
 * @returns {Promise<void>} 无返回值
 */
export async function preloadCatalogCache(dataDir: string): Promise<void> {
  try {
    const { applyCatalogCache } = await import('../../../src/model.ts')
    applyCatalogCache(dataDir)
  } catch (err) {
    logger.warn('catalog cache preload skipped', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 浏览器登录回调管理器(写凭据的入口之一, 需记[凭证更新时间]到账号账本).
 * @param {string} dataDir 数据目录
 * @param {any} ctx 应用上下文
 * @param {any} config 配置
 * @returns {any} LoginFlowManager 实例
 */
export function createLoginFlows(dataDir: string, ctx: any, config: any): any {
  return new LoginFlowManager({
    file: path.join(dataDir, 'login-flows.json'),
    credentialsDir: ctx.runtimes.dir,
    config,
    // 浏览器登录回调也是写凭据的入口:记[凭证更新时间]到账号账本.
    onCredentialSaved: (key) => ctx.runtimes.markCredentialUpdated(key),
  })
}
