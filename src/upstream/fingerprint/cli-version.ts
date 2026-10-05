/**
 - 进程内生效的 CLI 版本号  --  启动时兜底值, 在线对齐 npm 最新版.
 *
 * 内容: 可变的进程级状态(activeCliVersion)加一个 best-effort 网络刷新----
 * 它是少数会随时间自己变化的指纹值, 单独放着便于查"哪些值会漂".
 */
import { KNOWN_CLI_VERSION } from './ua.ts'

/**
 * 进程内生效的 CLI 版本号.启动时 = KNOWN_CLI_VERSION;refreshCliVersion() 成功后
 * 更新为 npm 上 freebuff 包的最新版本(上游只认[版本号看起来是真 CLi 发的]).
 */
let activeCliVersion = KNOWN_CLI_VERSION

/**
 - 当前生效的 CLI 版本号(同步,无 IO).
 - @returns {string} 版本号(形如 0.0.178)
 */
export function getCliVersion() {
  return activeCliVersion
}

/**
 - 测试/运维用:显式设置版本号(非法值忽略).
 - @param {any} version 待设置的版本号(须形如 x.y.z)
 - @returns {string} 设置后生效的版本号(非法输入时原值不变)
 */
export function setCliVersion(version: any) {
  if (typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version.trim())) {
    activeCliVersion = version.trim()
  }
  return activeCliVersion
}

/**
 * 从 npm registry 对齐官方 CLI 的最新版本号(best-effort).
 *
 * UA 里的版本号是上游判断[这是不是官方客户端]的一部分指纹, 写死一个过时值
 * 长期看本身就是破绽.拿不到就保留现值, 网络失败不影响代理可用性.
 *
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<string>} 生效的版本号
 */
export async function refreshCliVersion(opts: any = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') return activeCliVersion
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8_000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  if (timer.unref) timer.unref()
  try {
    const res = await fetchImpl('https://registry.npmjs.org/freebuff/latest', {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return activeCliVersion
    const body = await res.json()
    return setCliVersion(body && body.version)
  } catch {
    return activeCliVersion
  } finally {
    clearTimeout(timer)
  }
}
