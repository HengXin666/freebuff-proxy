/**
 * 路径解析:仓库根 / 凭据目录 / 默认凭据目录.
 *
 *  projectRootFromModule() 靠 import.meta.url 数层级定位仓库根;
 * 本文件位于 src/config/, 所以上跳两层到仓库根.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 仓库根目录(本文件位于 <root>/src/config/).
 *
 * @returns {string} 绝对路径
 */
export function projectRootFromModule(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
}

/**
 * 旧式凭据目录(<root>/credentials).
 *
 * @returns {string} 绝对路径
 */
export function credentialsDir(): string {
  return path.join(projectRootFromModule(), 'credentials')
}

/**
 * 默认凭据目录: <dataDir>/credentials; 当旧式 <root>/credentials 里还有
 * 账号文件而新目录不存在时, 返回旧式目录.
 *
 * @param {string} dataDir 已解析为绝对路径的数据目录
 * @returns {string} 实际使用的凭据目录
 */
export function resolveDefaultCredentialsDir(dataDir: string): string {
  const primary = path.join(dataDir, 'credentials')
  const legacy = credentialsDir()
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(primary)) {
      const files = fs.readdirSync(legacy).filter((f) => f.endsWith('.json'))
      if (files.length > 0) return legacy
    }
  } catch {
    // fall through
  }
  return primary
}
