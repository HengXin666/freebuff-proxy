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
  try {
    return { status: 'ok', data: JSON.parse(raw) }
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
    file: abs,
    status: state.status,
    reason: state.status === 'invalid' ? state.reason : null,
  })
}

/** 当前进程所有已登记的数据文件状态（按路径排序，便于稳定输出）。 */
export function dataFileAudit() {
  return [...audit.values()].sort((a, b) => a.file.localeCompare(b.file))
}

/** 只取损坏的文件（启动横幅 / 控制台告警用）。 */
export function invalidDataFiles() {
  return dataFileAudit().filter((e) => e.status === 'invalid')
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
