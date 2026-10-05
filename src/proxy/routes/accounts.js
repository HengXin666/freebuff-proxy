/**
 * 由 src/proxy.js 搬出的路由处理器 -- 见 docs/code-quality 的拆分记录.
 *
 * 为什么搬出来: createProxyHandler 原本是 2109 行的单函数闭包, 读它的人得同时
 * 装下选号 / 会话 / 流式 / 错误映射 / 白名单五套逻辑. 这些处理器之间没有共享的
 * 可变状态, 只有对 config / runtimes / userStore / settingsStore 的读取,
 * 所以它们可以整体搬出, 用显式的 ctx 参数接依赖.
 *
 * 口径: 搬移是纯搬移, 不改任何行为. 每个函数的 JSDoc 原样保留.
 */

import { coerceUser, deleteAccountUser, saveAccountUser } from '../../auth-store.js'
import { sendJson, readRequestBody } from '../../util/http.js'
import { logger } from '../../util/log.js'

export async function handleAccountsImport(ctx, req, res) {
  const parsed = await readImportBody(req, res)
  if (!parsed.ok) return
  const normalized = normalizeImportList(parsed.body, res)
  if (!normalized.ok) return
  const rawList = normalized.rawList

  const imported = []
  const failures = []
  for (const raw of rawList) {
    const u = coerceUser(raw)
    if (!u) {
      failures.push({
        email: raw && typeof raw === 'object' ? raw.email || null : null,
        error: '缺少 email / authToken（或格式不对）',
      })
      continue
    }
    try {
      const saved = saveAccountUser(ctx.runtimes.dir, u)
      // 凭证更新时间落盘(前端[更新]列的数据源).
      ctx.runtimes.markCredentialUpdated(saved.key)
      await ctx.runtimes.invalidate(saved.key).catch(() => {})
      //  以前的[导入后自动探测]已删除(docs/reverse/20 §20.3):
      // 导入账号不该顺带发一次上游 GET.额度/状态等用户点[检测]或
      // [一键刷新]时再取.
      imported.push({
        key: saved.key,
        email: saved.user.email,
        id: saved.user.id || null,
      })
    } catch (err) {
      failures.push({
        email: u.email,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  sendJson(res, 200, {
    ok: true,
    object: 'import',
    imported,
    failures,
    total: rawList.length,
  })
}

/**
 * 读并解析导入请求体; 失败时已写出 400 响应.
 * @param {import("node:http").IncomingMessage} req 请求
 * @param {import("node:http").ServerResponse} res 响应
 * @returns {Promise<{ ok: true, body: unknown } | { ok: false }>} 解析结果
 */
async function readImportBody(req, res) {
  let rawBuf
  try {
    rawBuf = await readRequestBody(req)
  } catch (err) {
    sendJson(res, 400, {
      error: {
        message: err instanceof Error ? err.message : String(err),
        type: 'invalid_request_error',
        code: 'bad_request_body',
      },
    })
    return { ok: false }
  }
  let body
  try {
    body = JSON.parse(rawBuf.toString('utf8'))
  } catch {
    sendJson(res, 400, {
      error: {
        message: '请求体不是合法 JSON',
        type: 'invalid_request_error',
        code: 'invalid_json',
      },
    })
    return { ok: false }
  }

  return { ok: true, body }
}

/**
 * 把四种入参形态归一成账号数组; 非法时已写出 400 响应.
 * @param {unknown} body 请求体
 * @param {import("node:http").ServerResponse} res 响应
 * @returns {{ ok: true, rawList: unknown[] } | { ok: false }} 归一化结果
 */
function normalizeImportList(body, res) {
  /** @type {unknown[]} */
  let rawList = []
  if (Array.isArray(body)) {
    rawList = body
  } else if (Array.isArray(body.accounts)) {
    rawList = body.accounts
  } else if (typeof body.json === 'string') {
    try {
      const parsed = JSON.parse(body.json)
      rawList = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      sendJson(res, 400, {
        error: {
          message: 'json 字段不是合法 JSON',
          type: 'invalid_request_error',
          code: 'invalid_json',
        },
      })
      return { ok: false }
    }
  } else if (body && typeof body === 'object') {
    rawList = [body]
  } else {
    sendJson(res, 400, {
      error: {
        message: '无法识别的导入结构：需为账号对象、账号数组、{accounts:[...]} 或 {json:"..."}',
        type: 'invalid_request_error',
        code: 'invalid_import_format',
      },
    })
    return { ok: false }
  }

  if (rawList.length === 0) {
    sendJson(res, 400, {
      error: {
        message: '导入列表为空',
        type: 'invalid_request_error',
        code: 'empty_import',
      },
    })
    return { ok: false }
  }
  if (rawList.length > 200) {
    sendJson(res, 400, {
      error: {
        message: '单次最多导入 200 个账号',
        type: 'invalid_request_error',
        code: 'too_many_accounts',
      },
    })
    return { ok: false }
  }

  return { ok: true, rawList }
}


/**
 - DELETE /v1/freebuff/accounts -- 开放 API 删除账号.
 - body(可选): {"email":".."} / {"key":".."} / {"id":".."};空 body 或全部则清空所有账号.
 */
export async function handleAccountsDelete(ctx, req, res) {
  let body = null
  try {
    const rawBuf = await readRequestBody(req)
    if (rawBuf.length > 0) body = JSON.parse(rawBuf.toString('utf8'))
  } catch {
    body = null // 空 body / 非 JSON → 全部删除
  }
  const target = body && typeof body === 'object'
    ? body.email || body.key || body.id || null
    : null
  const dir = ctx.runtimes.dir
  if (target) {
    try {
      const deleted = deleteAccountUser(dir, String(target))
      await ctx.runtimes.invalidate(String(target)).catch(() => {})
      sendJson(res, 200, {
        ok: true,
        deleted: target,
        existed: !!deleted,
      })
    } catch (err) {
      sendJson(res, 500, {
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: 'proxy_error',
          code: 'delete_failed',
        },
      })
    }
    return
  }
  // 空 body → 全部删除(先释放 session 再删凭据文件)
  const rows = ctx.runtimes.list()
  const removed = []
  for (const row of rows) {
    try {
      const rt = ctx.runtimes.get(row.key)
      await rt.sessions.release().catch(() => {})
    } catch {
      // ignore
    }
    deleteAccountUser(dir, row.key)
    await ctx.runtimes.invalidate(row.key).catch(() => {})
    removed.push(row.key)
  }
  sendJson(res, 200, { ok: true, object: 'delete', removed, total: removed.length })
}
