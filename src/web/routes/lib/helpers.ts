/**
 * 控制面路由的共享小工具.
 *
 * 拆 src/web/api.js 时,这些"每个域都要用一次"的纯函数若各自复制一份,
 * 就会出现"某域改了分档规则,别的域还是旧口径"的漂移 ---- 本仓已经在模型名
 * 映射上踩过同一个坑(见 .agents/notes/implemented/architecture/2026-10-04-model-name-three-layers.md).
 * 所以收拢到这一处,只有一份实现.
 */
import { createHash } from 'node:crypto'

import { readRequestBody } from '../../../util/http.js'
import { listAccounts } from '../../../auth-store.js'
import type { IncomingMessage } from 'node:http'

/**
 * 读 JSON 请求体;空体视为 {}.超过 2MB 由 readRequestBody 抛错.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>} 解析后的请求体
 */
export async function readJson(req: IncomingMessage) {
  const buf = await readRequestBody(req, 2 * 1024 * 1024)
  if (!buf || !buf.length) return {}
  return JSON.parse(buf.toString('utf8') || '{}')
}

/**
 * 上游故障对象上的两个判据字段,以及从任意抛出物里安全取出它们.
 *
 * 为什么单独收两个函数:catch 到的值是 unknown(strict 下),直接写
 * err?.code 会被 TS 拒掉(Property 'code' does not exist on type '{}').
 * 本仓有 6 处探测/刷新分支都要读这两个字段,各写一遍 as any 等于把
 * "错误判据从哪来"这件事复制六份 ---- 与文件头那条纪律冲突.
 *
 * 类型取自真实契约 src/upstream/client/errors.ts 的 UpstreamError:
 * code?: string / status?: number.所以这里只是把值原样透出并补 null,
 * 不做任何 String() / Number() 转换 ---- 转换会改语义(原实现是 ?? null).
 */
export interface ProbeErrorFields {
  code: string | null
  status: number | null
}

/**
 * 取错误判据码 / HTTP 状态码;取不到各自回落 null.
 *
 * @param {unknown} err 抛出的错误(catch 变量在 strict 下是 unknown)
 * @returns {ProbeErrorFields} { code, status }
 */
export function probeErrorFields(err: unknown): ProbeErrorFields {
  const e = err as { code?: string, status?: number } | null | undefined
  return {
    code: e?.code ?? null,
    status: e?.status ?? null,
  }
}

/**
 * 凭据 token 的短指纹(sha256 前 12 位 hex).
 *
 * 用途:不暴露完整 token 的前提下让导入/查看接口能自证"写进去的是哪一份"
 * ---- 控制台"凭证失效"排障时,这是区分"导入没生效"与"token 真被吊销"
 * 的唯一手段(完整 token 落进日志/响应体等于泄露凭据).
 *
 * @param {string | null | undefined} token
 * @returns {string | null} 短指纹;无 token 时为 null
 */
export function tokenFingerprint(token: any) {
  const s = String(token || '')
  if (!s) return null
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

/** 去掉响应里不该外发的字段(salt / passwordHash). */
/**
 * @param {any} user
 * @returns {any} 安全副本
 */
export function sanitize(user: any) {
  if (!user) return null
  const { salt, passwordHash, ...rest } = user
  return rest
}

/** 环境变量里配置的代理(HTTPS_PROXY 优先). */
/**
 * @returns {string | null} 代理 URL;未配置为 null
 */
export function envProxyOrNull() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null
  )
}

/**
 * 去重并丢掉空值(代理池展示用).
 *
 * @param {any[]} arr
 * @returns {string[]} 去重后的字符串数组
 */
export function uniqueStrings(arr: any) {
  return [...new Set((arr || []).filter(Boolean).map(String))]
}

/**
 * 按 key(id 或邮箱)定位账号行;邮箱匹配仅在唯一命中时生效
 * (同邮箱多个账号时必须以 key 精确指定,否则视为不存在).
 *
 * @param {string} dir 账号目录
 * @param {string} key 账号 key / 邮箱
 * @returns {any | null} 账号行;找不到为 null
 */
export function findAccountRow(dir: any, key: any) {
  const rows = listAccounts(dir)
  const norm = String(key || '').trim()
  const exact = rows.find((a) => a.key === norm)
  if (exact) return exact
  const ci = rows.find((a) => String(a.key).toLowerCase() === norm.toLowerCase())
  if (ci) return ci
  const emailMatches = rows.filter((a) => a.email === norm.toLowerCase())
  return emailMatches.length === 1 ? emailMatches[0] : null
}

/**
 * 目录 key(m-096e75164d)到内置 catalog 人类可读 id(deepseek/deepseek-v4-flash)
 * 的反查,查不到返回 null.
 *
 * 单一真源:AccountRuntimes.modelAliases()(内部走 resolveModelAlias() 与
 * CatalogHolder.digestForKey()).本函数不得自己按 legacyDigests 建索引
 * 或自己 import 摘要函数 -- 那等于在本仓写第二套"目录 key 到可读 id"的映射,
 * 一旦两侧规则漂移就会映射错模型(AGENTS.md 模型名一节明确禁止).
 *
 * @param {any} runtimes 账号运行时集合
 * @param {string} key 目录 key
 * @returns {string | null} 内置可读 id;查不到为 null
 */
export function catalogIdForKey(runtimes: any, key: any) {
  if (typeof key !== 'string' || !key) return null
  try {
    return runtimes.modelAliases?.([key])?.[0]?.catalogId ?? null
  } catch {
    return null
  }
}

/**
 * 目录 key(m-00032eaeec)-> 人类可读显示名(MiMo 2.6 Flash).
 *
 * ! 复用 AccountRuntimes.displayNameFor() ---- 那是唯一的展示侧映射入口
 * (内部先归一再做 key->名,支持目录 key / 上游 legacy id / 可读名三种输入,
 * 并带内置静态表兜底).这里此前自己遍历 runtime 的 catalog,是第二套实现,
 * 既漏掉"上游 legacy id"这种输入,也没有内置表兜底.
 *
 * @param {any} runtimes 账号运行时集合
 * @param {string} keyOrId 目录 key / 上游 id / 可读名
 * @returns {string} 显示名;取不到时原样返回输入
 */
export function modelDisplayName(runtimes: any, keyOrId: any) {
  if (typeof keyOrId !== 'string' || !keyOrId) return keyOrId
  try {
    const name = runtimes.displayNameFor?.(keyOrId)
    if (name) return name
  } catch {
    // 取不到就回落原值
  }
  return keyOrId
}

/**
 * 当前账号池里出现过的目录 key -> 可读显示名.
 *
 * 账号表的"额度"chip 按模型渲染,键来自 quota.byModel / freebucks.prices
 * ---- 全是目录 key.前端拿到这张表才能把 m-00032eaeec 显示成
 * MiMo 2.6 Flash(用户要求).取不到名字的 key 不进表,前端回落原 key.
 *
 * @param {any} runtimes 账号运行时集合
 * @returns {Record<string, string>} key -> 显示名
 */
export function overviewModelNames(runtimes: any) {
  const keys = new Set()
  for (const a of runtimes.list()) {
    for (const id of Object.keys(a?.quota?.byModel || {})) keys.add(id)
    for (const id of Object.keys(a?.freebucks?.prices || {})) keys.add(id)
    if (a?.session?.model) keys.add(a.session.model)
  }
  /** @type {Record<string, string>} */
  const out: Record<string, string> = {}
  for (const row of runtimes.modelAliases([...keys])) {
    if (row.displayName) out[row.key] = row.displayName
  }
  return out
}
