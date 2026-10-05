/**
 * 首次启动的管理员引导(或 env 驱动的密码轮换) -- 从 bin/serve.ts 按职责切出.
 *
 *
 * 口径: 纯搬移, 不改行为, 不改任何一行用户可见文案.
 */
import path from 'node:path'

import { logger } from '../../../src/util/log.ts'

/**
 * 首次启动的管理员引导(或 env 驱动的密码轮换).
 *
 * 密码来源:env(ADMIN_PASSWORD) / users.default_admin_password(config.yaml) /
 * generated(随机,仅首次启动打印一次).issue #9:旧日志只说
 * "password from env",用户既不知道密码是什么,也分不清是不是 env 生效,
 * 这里必须写清凭据来源与找回方式.
 * @param {any} userStore 用户库
 * @param {any} config 配置
 * @param {string} dataDir 数据目录
 * @returns {void} 无返回值
 */
export function bootstrapAdmin(userStore: any, config: any, dataDir: any) {
  const admin = userStore.ensureDefaultAdmin(
    config.users.defaultAdminUsername,
    config.users.defaultAdminPassword || null,
  )
  const adminPasswordSource = process.env.ADMIN_PASSWORD
    ? 'env'
    : config.users.defaultAdminPassword
      ? 'config'
      : 'generated'
  if (admin.created) {
    if (admin.password) {
      logger.info(
        'default admin created — credentials shown once in logs below',
        { username: admin.username, passwordSource: adminPasswordSource },
      )
      // Visible in docker compose logs for one-click onboarding
      console.log(
        `\n[freebuff-proxy] 首次启动：已创建管理员账号\n` +
          `  登录地址: http://<host>:${config.server.port}/\n` +
          `  用户名:   ${admin.username}\n` +
          `  密码:     ${admin.password}\n` +
          (adminPasswordSource === 'generated'
            ? `  （ADMIN_PASSWORD 未设置或为空 → 已随机生成，只在首次启动时打印这一次）\n` +
              `  请立即登录并修改密码，并把 ADMIN_PASSWORD 写进 .env 以免下次重装丢失。\n`
            : `  （密码来自 ADMIN_PASSWORD 环境变量）\n`),
      )
    } else {
      logger.info('default admin ensured (password from env)', {
        username: admin.username,
        passwordSource: adminPasswordSource,
      })
    }
  } else if (admin.rotated) {
    logger.info('default admin password rotated from env/config', {
      username: admin.username,
      passwordSource: adminPasswordSource,
    })
  } else if (admin.error) {
    logger.warn('ADMIN_PASSWORD/default_admin_password rejected — admin password unchanged', {
      username: admin.username,
      error: admin.error,
    })
  }
  // 已存在管理员且没给密码:把"怎么找回/重置"写进日志,避免重复开 issue.
  if (!admin.created && !admin.password && adminPasswordSource === 'generated') {
    logger.warn(
      'admin password is not printed again — reset by setting ADMIN_PASSWORD or editing users.default_admin_password',
      { username: admin.username, users: path.join(dataDir, 'users.json') },
    )
  }
}
