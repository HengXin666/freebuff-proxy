import fs from 'node:fs'
import path from 'node:path'

/**
 * 数据目录里所有 JSON 文件的**统一读取口径**。
 *
 * 为什么必须有它：这些文件（users / settings / proxies / custom-models /
 * catalog-cache / sessions / account-state / web-sessions / login-flows）原先
 * 各自 try/catch —— 文件坏了只打一行日志，然后**当空数据继续跑**：
 *   - users.json 损坏 → 控制台账号全没了，非 loopback 绑定还会直接拒绝启动；
 *   - settings.json 损坏 → 用户配的额度保护被静默回退成默认值；
 *   - account-state.json 损坏 → "买不起就别 admit" 的闸门失效。
 * 结果就是用户看到的"更新镜像后服务起不来"，而日志里只有一行容易被忽略的
 * warn（真实案例）。这里把读取结果收敛成三态，让调用方**必须显式表态**：
 * 要么接受"还没有这个文件"（首次启动），要么显式处理"文件坏了"。
 *
 * @typedef {{status: 'ok', data: any} | {status: 'missing'} | {status: 'invalid', reason: string}} JsonFileState
 */

/** @param {unknown} err */
function describe(err) {
  if (!err || typeof err !== 'object') return String(err)
  const e = /** @type {{code?: string, message?: string}} */ (err)
  return e.code ? `${e.code}: ${e.message || ''}`.trim() : String(e.message || err)
}

/**
 * 读一个 JSON 数据文件，返回三态（**永不抛**）。
 * @param {string} file
 * @returns {JsonFileState}
 */
export function readJsonFileState(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    // ENOENT / EISDIR 之外（EACCES、EROFS）也算"读不了"，同样要显式暴露。
    if (err && /** @type {any} */ (err).code === 'ENOENT') {
      return { status: 'missing' }
    }
    return { status: 'invalid', reason: describe(err) }
  }
  // 空文件不是合法 JSON：JSON.parse('') 抛 "Unexpected end of JSON input"，
  // 直接给出更准确的说明（电源掉电/写盘被杀的典型残留）。
  if (!raw.trim()) return { status: 'invalid', reason: '文件为空（0 字节）' }
  // UTF-8 BOM：Windows 记事本 / 导出工具写出来的文件开头会带 U+FEFF。
  // 它本身完全无害，但 JSON.parse 会直接报 "Unexpected token '\uFEFF'"，
  // 于是 users.json 被判定成"损坏"→ 拒绝启动（真实用户场景）。剥掉即可。
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  try {
    return { status: 'ok', data: JSON.parse(text) }
  } catch (err) {
    return { status: 'invalid', reason: describe(err) }
  }
}

/**
 * 装载审计登记表：每个 store 在 load() 时登记一次自己的文件状态。
 * 启动横幅与控制台「数据文件自检」都读它——不再有"坏了但没人知道"的文件。
 * key 用绝对路径，重复装载覆盖旧值（同进程内多次 loadConfig 不会留幽灵记录）。
 * @type {Map<string, { file: string, status: 'ok' | 'missing' | 'invalid', reason: string | null }>}
 */
const audit = new Map()

/**
 * 构造一个"格式不对"的 invalid 结果（文件能解析成 JSON，但结构不是本版本要的样子，
 * 例如旧布局 / 手改坏了）。与语法错误一样按损坏处理，绝不静默当空数据。
 * @param {string} reason
 * @returns {JsonFileState}
 */
export function invalidShape(reason) {
  return { status: 'invalid', reason: `结构不兼容：${reason}` }
}

/**
 * 登记一个数据文件的装载结果（store 的 load() 调用）。
 * @param {string} file
 * @param {JsonFileState} state
 */
export function noteDataFile(file, state) {
  const abs = path.resolve(String(file))
  const prev = audit.get(abs)
  // "因损坏而被挪走"不能再记成 missing：派生缓存修好后原地重建，第二次读到的
  // 是 ENOENT，但它**确实坏过**——控制台自检要说的是这件事，而不是"尚未生成"。
  if (prev?.status === 'invalid' && state.status === 'missing') return
  audit.set(abs, {
    // 保留条目级信息（noteDroppedEntries 可能先于/晚于本函数调用）。
    ...prev,
    file: abs,
    status: state.status,
    reason: state.status === 'invalid' ? state.reason : null,
  })
}

/**
 * 登记"条目级丢弃"：文件本身是合法 JSON（status 仍是 ok），但数组里有若干条
 * 结构非法的记录被丢弃。与"文件损坏"是**两件事**，处置办法也不同：
 *   - 损坏 → 移走文件让它按默认值重建；
 *   - 脏条目 → 已自动丢弃并留证（`<file>.dropped-*`），无需人工干预。
 * 控制台/启动横幅都要能区分，绝不能把"丢了 1 条脏数据"说成"文件损坏"。
 * @param {string} file
 * @param {number} count 丢弃条数
 * @param {string} reason 原因摘要
 * @param {string | null} backup 原文留证路径
 */
export function noteDroppedEntries(file, count, reason, backup = null) {
  if (!count) return
  const abs = path.resolve(String(file))
  const prev = audit.get(abs) || { file: abs, status: 'ok', reason: null }
  audit.set(abs, {
    ...prev,
    file: abs,
    droppedEntries: (prev.droppedEntries || 0) + count,
    droppedReason: reason || prev.droppedReason || '含非法条目',
    droppedBackup: backup || prev.droppedBackup || null,
  })
}

/**
 * 登记"这个文件里还有几条上游会话句柄没结算"（sessions.json 的 sessions + orphans）。
 *
 * 为什么单独记：sessions.json 里挂着句柄**不是损坏**（服务照常启动、由启动扫尾
 * 与释放流程慢慢清），但它确实是需要人知道的状态——每一条都占着上游会话槽位。
 * 控制台「系统 → 数据文件自检」用它显示"N 条会话待结算"，让"到底清干净了没有"
 * 一眼可见，而不是只能去翻启动日志。
 * @param {string} file
 * @param {number} count
 */
export function noteOpenHandles(file, count) {
  const abs = path.resolve(String(file))
  const prev = audit.get(abs) || { file: abs, status: 'ok', reason: null }
  audit.set(abs, { ...prev, file: abs, openHandles: Math.max(0, Number(count) || 0) })
}

/** 当前进程所有已登记的数据文件状态（按路径排序，便于稳定输出）。 */
export function dataFileAudit() {
  return [...audit.values()].sort((a, b) => a.file.localeCompare(b.file))
}

/** 只取损坏的文件（启动横幅 / 控制台告警用）。 */
export function invalidDataFiles() {
  return dataFileAudit().filter((e) => e.status === 'invalid')
}

/** 只取"有脏条目被丢弃"的文件（文件本身没坏，但丢过数据，必须能看见）。 */
export function dirtyDataFiles() {
  return dataFileAudit().filter((e) => (e.droppedEntries || 0) > 0)
}


/**
 * 逐条校验数组字段：**只保留结构合法的条目**，并报告丢弃了几条。
 *
 * 为什么必须有它：三态读取只保证"文件是 JSON 对象"，管不了**条目**。
 * 真实故障（v1.13.0 实测复现）：某些版本/手工编辑会往数组里留下 null 或非对象，
 * 各 store 原先直接 `this.x = raw.x` 信任整数组，随后在构造期就炸：
 *   - web-sessions.json 的 [null]  → _prune() 读 s.expiresAt → TypeError → 进程退出
 *     （**还没开始监听端口**，所以 docker 里看到的就是"更新镜像后起不来"）；
 *   - login-flows.json 的 [null]   → load() 读 f.id      → TypeError → 同上；
 *   - users.json 混入 null/非对象  → all() 读 u.username → TypeError → 同上。
 * 这些都是**合法 JSON**，原先的语法级自检一律报 ok，于是"启动横幅说一切正常、
 * 进程却起不来"，用户只能靠删 json 试错。
 *
 * 因此口径统一为：坏条目**逐条丢弃 + 明确告警**（绝不整数组信任、也绝不为一条
 * 脏数据拒绝启动）；文件本身坏了仍按 invalid 记账（见 readJsonFileState）。
 * 被丢弃条目的原文会写到 `<file>.dropped-<时间戳>`，便于人工核对/恢复。
 *
 * @param {any} data 已解析的 JSON 根值
 * @param {string} key 数组字段名（如 'sessions' / 'users' / 'flows'）
 * @param {(item: any) => boolean} isValid 单条校验
 * @returns {{items: any[], dropped: number, reason: string | null}}
 *   - items：合法条目（无该字段/非数组时为空数组）
 *   - dropped：丢弃条数（0 = 干净）
 *   - reason：丢弃原因摘要（无丢弃为 null）
 */
export function ensureObjectEntries(data, key, isValid) {
  const raw = data?.[key]
  if (!Array.isArray(raw)) {
    return { items: [], dropped: 0, reason: null }
  }
  const items = []
  const droppedItems = []
  for (const item of raw) {
    let ok = false
    try {
      ok = Boolean(isValid(item))
    } catch {
      ok = false
    }
    if (ok) items.push(item)
    else droppedItems.push(item)
  }
  if (!droppedItems.length) return { items, dropped: 0, reason: null }
  return {
    items,
    dropped: droppedItems.length,
    reason: describeDropped(droppedItems),
  }
}

/** 把被丢弃的条目压缩成一行可读摘要（数量 + 类型 + 首个键）。 */
function describeDropped(items) {
  const kinds = [...new Set(items.map((it) => (it === null ? 'null' : Array.isArray(it) ? 'array' : typeof it)))]
  const first = items[0]
  let hint = ''
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const keys = Object.keys(first).slice(0, 4).join(',')
    if (keys) hint = `（首个含字段: ${keys}）`
  }
  return `${items.length} 条非法条目已丢弃（类型: ${kinds.join('/')}）${hint}`
}

/**
 * 把被丢弃的条目原文留证到 `<file>.dropped-<时间戳>`。
 * 与 quarantineFile 同一思路：**丢数据可以，丢证据不行**（用户要能核对丢了什么）。
 * @param {string} file 数据文件路径
 * @param {any[]} items 被丢弃的原始条目
 * @returns {string | null} 备份路径；写不了返回 null（不阻断启动）
 */
export function dumpDroppedEntries(file, items) {
  if (!items?.length) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.dropped-${stamp}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      target,
      JSON.stringify({ file, droppedAt: new Date().toISOString(), items }, null, 2),
      { mode: 0o600 },
    )
    return target
  } catch {
    return null
  }
}

/** 对象（且非数组、非 null）：数据文件里"一条记录"的最低要求。 */
export function isPlainRecord(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 从任意来源取一个"只含非空字符串"的代理 URL 列表。
 *
 * 为什么必须有它：代理列表是最容易被手改/被旧版本写脏的数据（null、数字、
 * 对象、空串）。脏值如果原样传下去，会在**构造出网 agent 时**抛
 * `new ProxyAgent({uri: 123})` → `ERR_INVALID_URL`，那发生在启动后的第一次
 * 请求（最坏是启动期扫尾），表现为"更新镜像后起不来/一请求就崩"。
 * 这里统一在入口过滤掉，并且**不再静默**：过滤了几条由调用方记账。
 * @param {unknown} list
 * @returns {{ urls: string[], dropped: number }}
 */
export function sanitizeProxyList(list) {
  if (!Array.isArray(list)) return { urls: [], dropped: 0 }
  const urls = []
  let dropped = 0
  for (const raw of list) {
    const url = typeof raw === 'string' ? raw.trim() : ''
    if (!url) {
      dropped += 1
      continue
    }
    try {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'socks5:' && u.protocol !== 'socks:') {
        dropped += 1
        continue
      }
    } catch {
      dropped += 1
      continue
    }
    urls.push(url)
  }
  return { urls, dropped }
}

/**
 * 把损坏文件挪到一边（`<file>.corrupt-<时间戳>`），保留现场供人工恢复。
 * 用于**派生数据**（如 catalog-cache.json）：要重建了，先别把证据覆盖掉。
 * @param {string} file
 * @returns {string | null} 备份路径；挪不动返回 null（调用方继续重建即可）
 */
export function quarantineFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.corrupt-${stamp}`
  try {
    fs.renameSync(file, target)
    return target
  } catch {
    return null
  }
}
