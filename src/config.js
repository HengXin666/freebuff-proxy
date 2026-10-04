/**
 * 配置模块  --  薄门面(barrel):默认值,加载,路径,通道解析.
 *
 * 实现已按职责拆进 ./config/:
 *   - defaults.js DEFAULTS / KEY_MAP / UPSTREAM_API_BASE(数据,无 IO)
 *   - merge.js    纯函数:键归一 / 深拷贝 / 深合并 / 尾斜杠
 *   - paths.js    仓库根,凭据目录解析(靠 import.meta.url 数层)
 *   - load.js     loadConfig(YAML + 默认值 + 环境变量 + 路径)
 *   - channel.js  resolveUpstreamChannel
 *
 * 本文件保留原路径与全部原有导出名(loadConfig / credentialsDir /
 * projectRootFromModule / resolveUpstreamChannel / UPSTREAM_API_BASE /
 * DEFAULTS),因此 src/proxy.js,src/server.js,src/auth-store.js,
 * bin/serve.js 的既有 import 一处都不用改.
 *
 *  test/smoke.mjs 有一条读源码断言(/idleReleaseSec:\s*60/)指向本文件
 *  --  该默认值已随 DEFAULTS 搬到 config/defaults.js,断言需同步;此处保留
 * export { DEFAULTS } 使 import 形态不变.
 */
import { DEFAULTS } from './config/defaults.ts'
import { loadConfig } from './config/load.ts'
import { credentialsDir, projectRootFromModule } from './config/paths.ts'
import { resolveUpstreamChannel } from './config/channel.ts'
import { UPSTREAM_API_BASE } from './config/defaults.ts'

export {
  UPSTREAM_API_BASE,
  DEFAULTS,
  loadConfig,
  credentialsDir,
  projectRootFromModule,
  resolveUpstreamChannel,
}

export { isPlainObject, clonePlain, normalizeKeys, deepMerge } from './config/merge.ts'
export { resolveDefaultCredentialsDir } from './config/paths.ts'
export { KEY_MAP } from './config/defaults.ts'

// 保持默认导出面完整:旧文件末尾是 export { DEFAULTS },上面已包含.
void UPSTREAM_API_BASE
void DEFAULTS
void loadConfig
void credentialsDir
void projectRootFromModule
void resolveUpstreamChannel
