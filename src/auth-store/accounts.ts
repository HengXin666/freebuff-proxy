/**
 * 账号记录的读取,写入,迁移与列出.
 *
 * 运行时格式是裸 user 对象; 同时兼容旧包装 { default: user }.
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
  const matches: Array<{ u: any, full: string, rank: number }> = []
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const full = path.join(dir, file)
    const u = coerceUser(readJsonFile(full))
    if (!u) continue
    const k = accountKeyOf(u)
    if (k === key) matches.push({ u, full, rank: 0 })
    else if (k.toLowerCase() === norm) matches.push({ u, full, rank: 1 })
    else if (u.email === norm) matches.push({ u, full, rank: 2 })
  }
  if (!matches.length) return null
  /**
   * 命中多个同邮箱文件(GitHub / Google 用同一邮箱各登录一次)时不再判为歧义:
   * 那会让调用方拿到 null, 表现为"账号在列表里却报 401 用不了".
   *
   * 确定化顺序: key 精确命中 > 小写 key 命中 > 邮箱命中; 同档按文件名升序.
   * 结果可复现, 且与 listAccounts 的排序口径一致.
   */
  matches.sort((a, b) => a.rank - b.rank || a.full.localeCompare(b.full))
  const found = matches[0]
  if (matches.length > 1) {
    logger.warn('按 key 命中多个同邮箱账号, 取确定的一个', {
      key,
      picked: accountKeyOf(found.u),
      candidates: matches.map((m) => accountKeyOf(m.u)),
    })
  }
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
 * 同邮箱但 id 不同的两个账号(GitHub 与 Google 登录同一邮箱)各自存到
 * 自己的 <id>.json,互不覆盖; 只有 id 相同的重登才更新原文件.
 * <email>.json 若属于同一账号(id 相同)则删除,属于别的账号则保留.
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
    // 同邮箱的旧文件名: 仅当它属于同一个账号(id 相同)才清理.
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
    // 脏凭据文件(语法坏 / 缺 id+email / 缺 authToken)显式记入 invalidCredentialFiles.
    if (!user) {
      invalidCredentialFiles.push(full)
      continue
    }
    const key = accountKeyOf(user)
    let target: string
    try {
      target = accountCredentialsPath(dir, key)
    } catch (err) {
      // id 是 '' / '.' / '..' 这类无法当文件名用的值时 safeAccountStem 会抛:
      // 记入 invalidCredentialFiles 并跳过该文件, 不中断整轮列举.
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
        // <key>.json 已存在 -> 同账号的 <email>.json 是重复文件,删除
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
