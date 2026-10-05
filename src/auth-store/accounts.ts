/**
 * 账号记录的读取,写入,迁移与列出.
 *
 * Runtime format is bare user object. Migrate-only: 兼容历史 { default: user }.
 *
 * 从 src/auth-store.ts 拆出(原 392 行单文件).
 */
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../util/log.ts'
import {
  accountCredentialsPath,
  accountKeyOf,
  emailToFilename,
  ensureCredentialsDir,
  readJsonFile,
  writeJsonFile,
} from './files.ts'
import { coerceUser } from './records.ts'

/** listAccounts 的返回行. */
export interface AccountListRow {
  key: string
  id: string | null
  email: string
  name?: string
  path: string
  proxy: string | null
}

/**
 * 按 key 读取账号. key 命中不了时兜底扫描目录:
 *   - key 是邮箱 -> 按邮箱唯一匹配(兼容迁移前的旧 <email>.json);
 *   - key 是 id   -> 按文件内容 id 匹配(极端情况下旧文件还没迁移).
 * 找到后顺手把旧文件名迁移到 <key>.json,避免每次扫描.
 *
 * @param {string} dir 凭据目录
 * @param {string} key 账号 key
 * @returns {any} 账号对象;找不到或有歧义时返回 null
 */
export function readAccountUser(dir: string, key: string): any {
  const direct = accountCredentialsPath(dir, key)
  const directUser = coerceUser(readJsonFile(direct))
  if (directUser) return directUser
  if (!fs.existsSync(dir)) return null
  const norm = String(key || '').trim().toLowerCase()
  let found: { u: any, full: string } | null = null
  let ambiguous = false
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const full = path.join(dir, file)
    const u = coerceUser(readJsonFile(full))
    if (!u) continue
    const k = accountKeyOf(u)
    if (k === key || k.toLowerCase() === norm || u.email === norm) {
      if (found) {
        ambiguous = true
        break
      }
      found = { u, full }
    }
  }
  if (!found || ambiguous) return null
  const target = accountCredentialsPath(dir, accountKeyOf(found.u))
  if (target !== found.full && !fs.existsSync(target)) {
    try {
      fs.renameSync(found.full, target)
      found.full = target
    } catch {
      // 迁移失败不影响读取
    }
  }
  return found.u
}

/**
 * 保存账号(key = id 优先 / 邮箱).
 *
 * 核心修复:同邮箱但 id 不同的两个账号(如 GitHub 与 Google 登录同一邮箱)
 * 各自存到自己的 <id>.json,互不覆盖;只有 id 相同的重登才更新原文件.
 * 历史 <email>.json 若属于同一账号(id 相同)会迁移删除,属于别的账号则保留.
 *
 * @param {string} dir 凭据目录
 * @param {any} user 账号对象
 * @returns {{ user: any, path: string, key: string }} 落盘结果
 * @throws {Error} 缺 email/authToken 时
 */
export function saveAccountUser(dir: string, user: any): { user: any, path: string, key: string } {
  const u = coerceUser(user)
  if (!u) throw new Error('Cannot save account: missing email/authToken')
  ensureCredentialsDir(dir)
  const key = accountKeyOf(u)
  const filePath = accountCredentialsPath(dir, key)
  if (u.id) {
    // 同邮箱的旧布局文件:仅当它属于同一个账号(id 相同)才清理,
    // 否则(不同账号同邮箱)保留 -- 不覆盖别的账号.
    const legacy = path.join(dir, emailToFilename(u.email))
    if (legacy !== filePath && fs.existsSync(legacy)) {
      const legacyUser = coerceUser(readJsonFile(legacy))
      if (legacyUser && legacyUser.id === u.id) {
        try {
          fs.unlinkSync(legacy)
        } catch {
          // ignore
        }
      }
    }
  }
  writeJsonFile(filePath, u)
  // Remove obsolete active pointer if present
  const activePath = path.join(dir, 'active')
  if (fs.existsSync(activePath)) {
    try {
      fs.unlinkSync(activePath)
    } catch {
      // ignore
    }
  }
  return { user: u, path: filePath, key }
}

/**
 * 上一次 listAccounts() 跳过的脏凭据文件(绝对路径).
 *
 * 供启动自检/控制台告警使用 -- "账号不见了"必须能追到具体文件.
 */
export const invalidCredentialFiles: string[] = []

/**
 * 列出所有账号,并自动把旧 <email>.json(内容含 id)迁移为 <id>.json.
 * 同一 key 出现多个文件时只保留 <key>.json(旧命名重复文件删除).
 *
 * @param {string} dir 凭据目录
 * @returns {AccountListRow[]} 账号列表(按邮箱排序)
 */
export function listAccounts(dir: string): any[] {
  ensureCredentialsDir(dir)
  if (!fs.existsSync(dir)) return []
  invalidCredentialFiles.length = 0
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  const byKey = new Map<string, any>()
  for (const file of files) {
    const full = path.join(dir, file)
    const user = coerceUser(readJsonFile(full))
    // 脏凭据文件(语法坏 / 缺 id+email / 缺 authToken)以前是静默跳过:
    // 控制台里账号凭空消失,而磁盘上文件还在(用户以为"账号丢了").
    // 这里显式点名,绝不无声无息.
    if (!user) {
      invalidCredentialFiles.push(full)
      continue
    }
    const key = accountKeyOf(user)
    let target: string
    try {
      target = accountCredentialsPath(dir, key)
    } catch (err) {
      // id 是 '' / '.' / '..' 这类无法当文件名用的值:safeAccountStem 会抛.
      // 以前这个异常会直接从 listAccounts() 冒到启动流程 -> 服务起不来.
      // 凭据文件本身不该让整个服务停摆:跳过它并点名,交给用户处置.
      invalidCredentialFiles.push(full)
      logger.warn('跳过无法解析的账号凭据(key 不能当文件名用)', {
        file: full,
        key,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (path.basename(target) !== file) {
      if (fs.existsSync(target)) {
        // <key>.json 已存在 -> 旧 <email>.json 是同账号的历史遗留,删除
        try {
          fs.unlinkSync(full)
        } catch {
          // ignore
        }
        continue
      }
      try {
        fs.renameSync(full, target)
      } catch {
        // 并发/权限失败则继续用旧路径
      }
    }
    byKey.set(key, {
      key,
      id: user.id || null,
      email: user.email,
      name: user.name,
      path: fs.existsSync(target) ? target : full,
      proxy: user.proxy || null,
    })
  }
  const accounts = [...byKey.values()]
  accounts.sort((a: any, b: any) => a.email.localeCompare(b.email))
  return accounts
}

/**
 * 删除账号:优先 <key>.json,其次旧 <email>.json,最后内容反查.
 *
 * @param {string} dir 凭据目录
 * @param {string} key 账号 key
 * @returns {boolean} 是否真的删掉了文件
 */
export function deleteAccountUser(dir: string, key: string): boolean {
  const direct = accountCredentialsPath(dir, key)
  if (fs.existsSync(direct)) {
    try {
      fs.unlinkSync(direct)
      return true
    } catch {
      return false
    }
  }
  if (String(key).includes('@')) {
    const legacy = path.join(dir, emailToFilename(key))
    if (fs.existsSync(legacy)) {
      try {
        fs.unlinkSync(legacy)
        return true
      } catch {
        return false
      }
    }
  }
  if (!fs.existsSync(dir)) return false
  const norm = String(key).trim().toLowerCase()
  let removed = false
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const full = path.join(dir, file)
    const u = coerceUser(readJsonFile(full))
    if (
      u &&
      (accountKeyOf(u) === key ||
        String(u.email || '').trim().toLowerCase() === norm ||
        String(u.id || '').trim().toLowerCase() === norm)
    ) {
      try {
        fs.unlinkSync(full)
        removed = true
      } catch {
        // ignore single-file failure; keep scanning
      }
    }
  }
  return removed
}
