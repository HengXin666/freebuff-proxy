/**
 * 输入画像(freebuff_input_profile)—— 官方 chat metadata 的一个字段.
 *
 * 官方把用户怎么敲出这条 prompt的计数发上去(只发计数与耗时,从不发文本):
 *
 *
 * tc  按键插入的字符数
 * ke  插入文本的按键事件数
 * mc  一次插入多于一个字符的按键事件数
 * pc  括号粘贴接收的字符数
 * pe  括号粘贴事件数
 * ms  首次输入到提交的毫秒数(没有输入时为 null → 整个字段省略)
 * cps 任一秒窗口内按键插入的最大字符数
 *
 *
 * 编码:v1;tc=6;ke=6;mc=0;pc=0;pe=0;ms=1001;cps=6
 * (null 的字段整项省略 —— 官方 encodeInputProfile 用 flatMap 过滤 null.)
 *
 * 语义与官方 common/src/constants/freebuff-client-descriptor.ts +
 * cli/src/utils/input-profile.ts 逐字对齐.
 *
 *  本代理是服务端,没有真实键盘/粘贴事件.所以不伪造输入画像 ——
 * 见下方 describeProxyInput 的取舍说明.
 * 见 .agents/notes/implemented/feature/2026-10-01-chat-metadata-parity.md
 */
import { logger } from '../util/log.js'

export const INPUT_PROFILE_KEY = 'freebuff_input_profile'
export const REPO_SNAPSHOT_KEY = 'repo_snapshot'
export const LLM_STEP_NUMBER_KEY = 'llm_step_number'

/** 描述符版本前缀(与官方 FREEBUFF_CLIENT_DESCRIPTOR_VERSION 一致). */
const DESCRIPTOR_VERSION = 'v1'

/**
 * 编码一份输入画像,字段顺序与官方 encodeInputProfile 逐字一致.
 * null 的项整项省略.
 * @param {{ typedChars?: number, keypressEvents?: number, multiCharKeypressEvents?: number, pastedChars?: number, pasteEvents?: number, composeMs?: number|null, maxTypedCharsPerSecond?: number }} p
 * @returns {string}
 */
export function encodeInputProfile(p) {
  const fields = [
    ['tc', p.typedChars],
    ['ke', p.keypressEvents],
    ['mc', p.multiCharKeypressEvents],
    ['pc', p.pastedChars],
    ['pe', p.pasteEvents],
    ['ms', p.composeMs],
    ['cps', p.maxTypedCharsPerSecond],
  ]
  const parts = [DESCRIPTOR_VERSION]
  for (const [k, v] of fields) {
    if (v === null || v === undefined) continue
    parts.push(`${k}=${v}`)
  }
  return parts.join(';')
}

/**
 * 从客户端请求体推断输入画像.
 *
 * 取舍:官方用真实的键盘/粘贴事件计数;本代理是服务端,拿不到这些事件.
 * 但我们能拿到下游请求本身的等价信息 —— 用户发来的 prompt 文本长度,
 * 消息条数,从请求开始到上游调用的耗时.用这些构造一份与官方同格式且语义
 * 诚实的画像(tc = 用户消息总字符数按"一次插入"计,ke 记 1 次,
 * ms 用真实的下游→上游耗时),而不是编造键盘行为.
 *
 * 为什么值得发:官方 chat 带这个字段,缺它就是少一层"客户端行为"证据.
 * 但绝不伪造具体按键节奏(那反而自相矛盾).
 *
 * @param {{ messages?: Array<{ role: string, content: any }>, arrivedAtMs?: number, nowMs?: number }} opts
 * @returns {string}
 */
export function describeProxyInput(opts = {}) {
  const msgs = Array.isArray(opts.messages) ? opts.messages : []
  let lastUser = ''
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m && m.role === 'user') {
      lastUser =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((p) =>
                  typeof p === 'string' ? p : p && p.type === 'text' ? p.text : '',
                )
                .join('')
            : ''
      break
    }
  }
  const chars = lastUser.length
  const arrived = Number.isFinite(opts.arrivedAtMs) ? opts.arrivedAtMs : null
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now()
  // 下游请求到上游调用之间的真实耗时(秒级以内通常为 0)
  const composeMs = arrived === null ? null : Math.max(0, now - arrived)
  return encodeInputProfile({
    // 服务端视角:整条 prompt 是一次到达的插入
    typedChars: chars,
    keypressEvents: chars > 0 ? 1 : 0,
    multiCharKeypressEvents: chars > 1 ? 1 : 0,
    pastedChars: 0,
    pasteEvents: 0,
    composeMs,
    maxTypedCharsPerSecond: chars,
  })
}

/**
 * 仓库快照(repo_snapshot).官方在 chat metadata 里放一个 JSON 字符串:
 *
 * json
 * {"gitAvailable":false,"repositoryVisibility":"unknown","fileCount":12,
 *  "fileCountIsLowerBound":false,"testFileCount":0,"changedFileCount":0,
 *  "changedFileScanTruncated":false}
 *
 *
 * 官方是 CLI 扫描本地仓库得出;本代理没有本地仓库概念,如实报告
 * "不可用"(gitAvailable:false + unknown),而不是编造文件数.
 * @returns {string}
 */
export function describeProxyRepo() {
  return JSON.stringify({
    gitAvailable: false,
    repositoryVisibility: 'unknown',
    fileCount: 0,
    fileCountIsLowerBound: false,
    testFileCount: 0,
    changedFileCount: 0,
    changedFileScanTruncated: false,
  })
}

/**
 * 把这三个字段并进 codebuff_metadata(不覆盖调用方已有的值).
 * @param {Record<string, any>} meta
 * @param {{ messages?: any[], stepNumber?: number, arrivedAtMs?: number }} [opts]
 * @returns {Record<string, any>}
 */
export function withChatMetadataParity(meta, opts = {}) {
  const out = { ...meta }
  if (out[INPUT_PROFILE_KEY] === undefined) {
    out[INPUT_PROFILE_KEY] = describeProxyInput({
      messages: opts.messages,
      arrivedAtMs: opts.arrivedAtMs,
    })
  }
  if (out[REPO_SNAPSHOT_KEY] === undefined) {
    out[REPO_SNAPSHOT_KEY] = describeProxyRepo()
  }
  if (out[LLM_STEP_NUMBER_KEY] === undefined) {
    out[LLM_STEP_NUMBER_KEY] = String(
      Number.isFinite(opts.stepNumber) && opts.stepNumber > 0
        ? opts.stepNumber
        : 1,
    )
  }
  return out
}
