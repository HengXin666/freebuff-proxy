/**
 - doctor 的输出段 -- 从 bin/doctor.ts 按职责切出.
 *
 - 为什么切出来: 原 main 是 92 行的单函数, 大半在拼配置与账号的打印块,
 - 诊断动作本身只占几行. 切出来后"诊断做什么"与"打印什么"可以分开读.
 */

/**
 - 打印配置来源与关键路径(排查"配置没生效"的第一屏).
 - @param {any} config 已加载配置
 - @param {string} dir 凭据目录
 - @param {(p: string) => boolean} existsSync 存在性判定
 - @returns {void} 无返回值
 */
export function printConfigSummary(config: any, dir: string, existsSync: (p: string) => boolean): void {
  console.log(
    'config path:',
    config._configPath,
    config._configExists ? '(found)' : '(missing, using defaults)',
  )
  console.log('data dir:', config.server.dataDir)
  console.log(
    'credentials dir:',
    dir,
    existsSync(dir) ? '(found)' : '(missing)',
  )
  console.log('api_base:', config.upstream.apiBase)
  console.log('login_base:', config.upstream.loginBase)
  console.log(
    'proxy:',
    config.upstream.proxy ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      '(none)',
  )
}

/**
 - 探测上游 session(两次 GET, 第二次只是复述结果).
 *
 - 不再用 GET /api/v1/me: 客户端 165 条抓包里它出现 0 次(见 docs/reverse/20 §20.2).
 - doctor 是用户主动执行的诊断工具, 允许探测, 但只准用客户端真实发过的端点.
 - @param {any} upstream 上游客户端
 - @param {string[]} issues 问题收集器(原地追加)
 - @returns {Promise<void>} 无返回值
 */
export async function probeUpstream(upstream: any, issues: string[]): Promise<void> {
  try {
    const session = await upstream.freebuffSession('GET')
    console.log('GET /api/v1/freebuff/session: OK', {
      status: session?.status,
      accessTier: session?.accessTier,
    })
  } catch (err) {
    issues.push(
      `GET /api/v1/freebuff/session failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  try {
    const session = await upstream.freebuffSession('GET')
    console.log('GET /api/v1/freebuff/session:', session?.status || session)
  } catch (err) {
    issues.push(
      `GET freebuff session failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 - 打印问题清单(空则明确说"全过").
 - @param {string[]} issues 问题列表
 - @returns {void} 无返回值
 */
export function printIssues(issues: string[]): void {
  if (!issues.length) {
    console.log('doctor: all checks passed')
    return
  }
  console.log('doctor: issues')
  for (const i of issues) console.log(' -', i)
}
