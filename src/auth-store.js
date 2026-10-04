/**
 * 多账号 Freebuff 登录存储 -- 薄门面(barrel).
 *
 * 实现已按职责拆进 ./auth-store/:
 *   files.ts     凭据目录与文件名规则(路径解析 / 哈希 / 读写原语)
 *   records.ts   账号记录形状归一 + 上游鉴权头 + 本机指纹
 *   accounts.ts  读取 / 保存 / 迁移 / 列出 / 删除
 *
 * 保留原路径与全部原有导出名,既有 import 点一处都不用改.
 *
 * 目录布局:
 *   credentials/<key>.json      key = Freebuff 用户 id(新布局)
 *   credentials/<email>.json    历史布局,读取时自动迁移到 <id>.json
 *
 * No "active" pointer -- runtime picks accounts by availability.
 */
export {
  accountCredentialsPath,
  accountKeyToFilename,
  emailToFilename,
  ensureCredentialsDir,
  readJsonFile,
  resolveCredentialsDir,
  safeAccountStem,
  writeJsonFile,
} from './auth-store/files.ts'

export { coerceUser, freebuffAuthHeaders, generateFingerprintId } from './auth-store/records.ts'

export { deleteAccountUser, invalidCredentialFiles, listAccounts, readAccountUser, saveAccountUser } from './auth-store/accounts.ts'

export { accountKeyOf } from './auth-store/files.ts'
