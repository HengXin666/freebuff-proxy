/**
 * accounts 域(存储侧):账号列表 / 导入 / 出口绑定 / 凭据读取 / 删除.
 *
 * 这条链路的关键词是自证:导入与查看凭据都回显"落盘证据"(写到哪个文件,
 * token 的短指纹与末 6 位).没有它,用户在控制台上无法区分"导入没生效"
 * 与"token 真被上游吊销",只能反复重登(2026-10-04 实测踩过).
 */
import { sendJson } from '../../../../util/http.ts'
import { logger } from '../../../../util/log.ts'
import {
  saveAccountUser,
  coerceUser,
  deleteAccountUser,
  readJsonFile,
  writeJsonFile,
} from '../../../../auth-store.ts'
import { tokenFingerprint, findAccountRow, overviewModelNames } from '../../lib/helpers.ts'
import { denyUnlessAdmin, decodeSegment } from '../../lib/http-codes.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

const ACCOUNT_RE = /^\/api\/accounts\/([^/]+)$/
const CREDENTIAL_RE = /^\/api\/accounts\/([^/]+)\/credential$/

/**
 * POST /api/accounts/import ---- 导入/更新一个账号凭据文件.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx
 * @returns {Promise<void>}
 */
async function importAccount(req: IncomingMessage, res: ServerResponse, ctx: any) {
  const { runtimes, readJson } = ctx
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '无效的 JSON' })
    return
  }
  let raw = body
  if (typeof body.json === 'string') {
    try {
      raw = JSON.parse(body.json)
    } catch {
      sendJson(res, 400, { error: 'json 字段不是合法 JSON' })
      return
    }
  }
  const u = coerceUser(raw)
  if (!u) {
    sendJson(res, 400, {
      error: '缺少 email / authToken（或格式不对）',
      // 该文案是给用户看的 JSON 示例,原样保留(拼接不改变字符内容);
      // 拆行只是为了让单行不超过 120 字符的格式红线.
      hint:
        '期望形如 {"email":"you@example.com","authToken":"..."}，可带 "id"（Freebuff 用户ID，' +
        'GitHub/Google 同邮箱的两个账号给不同 id 就不会互相覆盖）',
    })
    return
  }
  const saved = saveAccountUser(runtimes.dir, u)
  // 凭证更新时间落盘(前端"更新"列的数据源).
  runtimes.markCredentialUpdated(saved.key)
  // Drop any cached runtime so the fresh token is picked up
  try {
    await runtimes.invalidate(saved.key)
  } catch {
    // 缓存丢弃失败不影响导入结果；下次请求会自然重建
  }
  // ! 以前的"导入后自动探测"已删除(docs/reverse/20 §20.3):
  // 导入账号不该顺带发一次上游 GET.要额度/状态,用户点"检测"或"一键刷新".
  logger.event('accountImport', 'info', 'account imported via web', { key: saved.key, email: saved.user.email })
  sendJson(res, 200, {
    ok: true,
    account: saved.user.email,
    key: saved.key,
    id: saved.user.id || null,
    path: saved.path,
    tokenFingerprint: tokenFingerprint(saved.user.authToken),
    tokenTail: String(saved.user.authToken || '').slice(-6),
  })
}

/**
 * GET /api/accounts/:key/credential ---- 读回该账号的落盘凭据供核对/迁移.
 *
 * @param {string} key 账号 key
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx
 * @returns {void}
 */
function readCredential(key: any, res: ServerResponse, ctx: any) {
  const { runtimes } = ctx
  const row = findAccountRow(runtimes.dir, key)
  if (!row) {
    sendJson(res, 404, { error: '账号不存在' })
    return
  }
  const raw = readJsonFile(row.path)
  if (!raw || typeof raw.authToken !== 'string' || !raw.authToken) {
    sendJson(res, 404, { error: '账号凭据缺失或格式异常' })
    return
  }
  const credential = {
    id: raw.id || null,
    email: raw.email,
    name: raw.name || null,
    authToken: raw.authToken,
    fingerprintId: raw.fingerprintId || null,
    fingerprintHash: raw.fingerprintHash || null,
    proxy: raw.proxy || null,
  }
  /**
   * 与 /api/accounts/import 同源的落盘证据:path + token 短指纹 + 末 6 位.
   * "查看凭证"是核对"控制台里这个号到底挂着哪一份 token"的唯一入口
   * (多 id 同邮箱时尤其如此),必须能自证,否则只能靠猜.
   */
  sendJson(res, 200, {
    ok: true,
    key: row.key,
    credential,
    path: row.path,
    tokenFingerprint: tokenFingerprint(raw.authToken),
    tokenTail: String(raw.authToken || '').slice(-6),
  })
}

/**
 * PATCH /api/accounts/:key ---- 只改该账号绑定的出口代理.
 *
 * @param {string} key 账号 key
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx
 * @returns {Promise<void>}
 */
async function patchAccount(key: any, req: IncomingMessage, res: ServerResponse, ctx: any) {
  const { runtimes, readJson } = ctx
  let body
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '无效的 JSON' })
    return
  }
  const row = findAccountRow(runtimes.dir, key)
  if (!row) {
    sendJson(res, 404, { error: '账号不存在' })
    return
  }
  const raw = readJsonFile(row.path)
  if (!raw) {
    sendJson(res, 404, { error: '账号不存在' })
    return
  }
  const proxy =
    typeof body.proxy === 'string' && body.proxy.trim() ? body.proxy.trim() : null
  raw.proxy = proxy
  writeJsonFile(row.path, raw)
  // 让新的出口代理立即生效:丢弃缓存的 runtime
  await runtimes.invalidate(row.key)
  logger.info('account proxy updated via web', { key: row.key, email: row.email, proxy })
  sendJson(res, 200, { ok: true, key: row.key, email: row.email, proxy })
}

/**
 * DELETE /api/accounts/:key ---- 删号并清掉它在账本里的全部记录.
 *
 * @param {string} key 账号 key
 * @param {import('node:http').ServerResponse} res
 * @param {any} ctx
 * @returns {Promise<void>}
 */
async function deleteAccount(key: any, res: ServerResponse, ctx: any) {
  const { runtimes } = ctx
  await runtimes.invalidate(key)
  const removed = deleteAccountUser(runtimes.dir, key)
  if (!removed) {
    sendJson(res, 404, { error: '账号不存在' })
    return
  }
  // 账号没了,账本里的记录(请求数/冷却/退款流水)也一并清掉,
  // 否则文件会随删号无限增长,控制台还会读出幽灵账号的历史.
  runtimes.forgetAccount(key)
  sendJson(res, 200, { ok: true, key })
}

/**
 * accounts 存储侧入口.
 *
 * @param {string} method HTTP 方法
 * @param {string} route 规范化路径
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} user 当前用户
 * @param {any} ctx 路由上下文
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handle(
  method: string,
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  user: any,
  ctx: any,
) {
  const { runtimes } = ctx

  // 注:session.modelDisplayName(目录 key -> 可读名)由 AccountRuntimes.list()
  // 统一带上,所有出口(本路由 / overview / probe / refresh)自动生效.
  if (method === 'GET' && route === '/api/accounts') {
    sendJson(res, 200, {
      object: 'list',
      data: runtimes.list(),
      modelNames: overviewModelNames(runtimes),
    })
    return true
  }

  if (method === 'POST' && route === '/api/accounts/import') {
    if (denyUnlessAdmin(user, res)) return true
    await importAccount(req, res, ctx)
    return true
  }

  const cred = route.match(CREDENTIAL_RE)
  if (cred && method === 'GET') {
    // 查看某个账号的凭据(与账号列表同权限:任意已登录用户可读).
    // 凭据直接读磁盘文件(runtime 里不带 authToken 之外的敏感字段),
    // 与账号文件格式保持一致,方便导出/迁移.
    readCredential(decodeSegment(cred[1]), res, ctx)
    return true
  }

  const single = route.match(ACCOUNT_RE)
  if (single && method === 'PATCH') {
    if (denyUnlessAdmin(user, res)) return true
    await patchAccount(decodeSegment(single[1]), req, res, ctx)
    return true
  }
  if (single && method === 'DELETE') {
    if (denyUnlessAdmin(user, res)) return true
    await deleteAccount(decodeSegment(single[1]), res, ctx)
    return true
  }
  return false
}
