/**
 - 客户端环境描述符  --  x-freebuff-env / codebuff_metadata.freebuff_client_env 的取值.
 *
 * 这是一份分号分隔的键值汇总(v1;in=..;out=..;...). 硬约束: 不放路径/进程名/
 * 环境变量原文; 与官方 cli/src/utils/client-environment.ts 逐项对照.
 */

/**
 * 官方 CLI 的客户端环境描述符(terminal-environment summary).
 *
 * 这是上游判断"这是不是真 CLI"的核心指纹之一:官方把它作为
 * x-freebuff-env 头发在 session / 广告请求上,并把同一份字符串放进
 * codebuff_metadata.freebuff_client_env.缺它 = 请求形态不像官方客户端.
 *
 * 取值逐字对齐官方 CLI 源码
 *   cli/src/utils/client-environment.ts → formatClientEnvironment()
 * 常量真源
 *   common/src/constants/freebuff-client-descriptor.ts
 * 官方注释里的样例:
 *   v1;in=1;out=1;tp=iterm;term=1;ct=1;sz=120x40;ci=0;ssh=0;l=1;p=shell;g=terminal;osc=1
 *
 * 只放存在性标志,尺寸与固定桶名 ---- 绝不放路径,进程名,环境变量原文
 * (官方明确约束:never a raw environment value, path, or process name).
 */
/**  x-freebuff-env 常量已删除:desktop 客户端 0 次,见 RETIRED_HEADERS. */
/** codebuff_metadata 里承载同一份描述符的键. */
export const META_CLIENT_ENV = 'freebuff_client_env'

/** 终端程序桶(官方 TERMINAL_PROGRAMS 映射). */
const TERMINAL_PROGRAMS: any = {
  apple_terminal: 'apple_terminal',
  'iterm.app': 'iterm',
  iterm2: 'iterm',
  vscode: 'vscode',
  ghostty: 'ghostty',
  wezterm: 'wezterm',
  warpterminal: 'warp',
  hyper: 'hyper',
  tmux: 'tmux',
  zed: 'zed',
  tabby: 'tabby',
  rio: 'rio',
  mintty: 'mintty',
  'jetbrains-jediterm': 'jetbrains',
  kitty: 'kitty',
  alacritty: 'alacritty',
}

function bucketTerminalProgram(value: any) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!v) return 'none'
  return TERMINAL_PROGRAMS[v] || 'other'
}

const flag = (v: any) => (v ? '1' : '0')

/**
 * 代理桶(对齐官方 cli/src/utils/client-environment.ts proxyBucketOf).
 * 只看 6 个代理环境变量,取值 none / loopback / remote ---- 不上报真实地址.
 */
function proxyBucketOf(env: any) {
  const one = (value: any) => {
    const v = typeof value === 'string' ? value.trim() : ''
    if (!v) return null
    try {
      const host = new URL(v).hostname
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
        return 'loopback'
      }
      return 'remote'
    } catch {
      return 'remote'
    }
  }
  const buckets = [
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
    env.ALL_PROXY,
    env.all_proxy,
  ].map(one)
  if (buckets.includes('loopback')) return 'loopback'
  if (buckets.includes('remote')) return 'remote'
  return 'none'
}

function clampDimension(value: any) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(9999, Math.floor(value)))
}

/**
 * 生成本进程的客户端环境描述符(对齐官方 formatClientEnvironment).
 *
 * 本代理跑在容器/服务里,没有真实终端,所以按官方对"非交互环境"的
 * 取值填:in/out = 0(非 TTY),tp = none,l = 0,p/g = na(未查询),
 * osc = na.这是自洽的取值 ---- 官方自己也有 na 桶表示"未查询/不适用",
 * 伪造成一个真实终端反而与运行环境矛盾.
 *
 * @param {{ env?: Record<string, string|undefined>, columns?: number, rows?: number }} [opts]
 * @returns {string}
 */
export function formatClientEnvironment(opts: any = {}) {
  const env = opts.env || {}
  const ci =
    env.CI === 'true' || env.CI === '1' || env.GITHUB_ACTIONS === 'true'
  const fields = [
    ['in', flag(false)],
    ['out', flag(false)],
    ['tp', bucketTerminalProgram(env.TERM_PROGRAM)],
    ['term', flag(env.TERM)],
    ['ct', flag(env.COLORTERM)],
    ['sz', `${clampDimension(opts.columns)}x${clampDimension(opts.rows)}`],
    ['ci', flag(ci)],
    ['ssh', flag(env.SSH_TTY || env.SSH_CONNECTION)],
    ['l', flag(false)],
    ['p', 'na'],
    ['g', 'na'],
    ['osc', 'na'],
    // 后 4 个字段是官方较新版本才加的(真机抓包 2026-10-01 确认存在).
    // 语义逐条对齐 cli/src/utils/client-environment.ts:377-380:
    //   tzo = TZ 覆盖了系统时区?(本进程不改 TZ → 0)
    //   px  = 代理桶(none/loopback/remote)
    //   tls = 是否禁用了证书校验(默认 1 = 正常校验)
    //   ca  = 是否追加了自定义 CA
    ['tzo', flag(env.TZ && String(env.TZ).trim())],
    ['px', proxyBucketOf(env)],
    ['tls', env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0' ? '0' : '1'],
    ['ca', flag(env.NODE_EXTRA_CA_CERTS?.trim())],
  ]
  return ['v1', ...fields.map(([k, v]) => `${k}=${v}`)].join(';')
}

/**
 * 本进程的环境描述符(构建一次后缓存:官方也是 per-process 构建一次).
 * @type {string | null}
 */
let cachedClientEnv: any = null

/**
 - 取(并缓存)本进程的客户端环境描述符.
 - @returns {string} 分号分隔的描述符(进程内只构建一次)
 */
export function clientEnvironment() {
  if (!cachedClientEnv) {
    cachedClientEnv = formatClientEnvironment({
      env: typeof process !== 'undefined' ? process.env : {},
    })
  }
  return cachedClientEnv
}
