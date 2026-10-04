/**
 * 路径解析:仓库根 / 凭据目录 / 默认凭据目录.
 *
 *  projectRootFromModule() 靠 import.meta.url 数层级定位仓库根.本文件
 * 从 src/config.js(src/ 下一层)搬到 src/config/(src/ 下两层),
 * 所以上跳层数必须是 ../..  --  写错会让整个仓库的默认 dataDir /
 * credentials 目录指到 src/ 下,且只在运行时表现为找不到数据.
 * 这正是"搬家式重构最典型的静默故障",已用 node -e 实测目录值.
 *
 * 从 src/config.js 拆出(原 446 行单文件).
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
 * 传统凭据目录(<root>/credentials,pre-/data 安装留下的).
 *
 * @returns {string} 绝对路径
 */
export function credentialsDir(): string {
  return path.join(projectRootFromModule(), 'credentials')
}

/**
 * Default credentials dir: <dataDir>/credentials, unless a legacy
 * <projectRoot>/credentials with account files still exists and the new one
 * is empty (keeps pre-/data installs working).
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
