#!/usr/bin/env node
/**
 - 打印上游 Freebuff 的实时计费 / 定价表(Freebucks).
 *
 - 为什么需要这个命令: 官方没有一份可引用的静态价格表. 上游把定价放在
 - 每次 session 响应的 freebucks.prices 里(模型 → N Freebucks/小时),
 - 这是唯一真源; 网页版定价页并不公开这份[按模型]的价目.
 - 所以这里直接读上游实时数据, 并把[今日池余额能买多少时长]折算出来,
 - 等价于把控制台的额度列搬到命令行.
 *
 - 只读: 走 GET /api/v1/freebuff/session(探测), 不创建 session, 不消耗额度.
 *
 - 用法:
 - npm run pricing                 # 人类可读的价目表
 - npm run pricing -- --json       # 机器可读(脚本/CI 用)
 - node bin/pricing.ts --config /path/to/config.yaml
 *
 - 格式化见 ./pricing/format.ts, 组装与打印见 ./pricing/report.ts.
 */
import process from 'node:process'
import { loadConfig } from '../src/config.ts'
import { buildAppContext } from '../src/app-context.ts'
import { configureLogger } from '../src/util/log.ts'
import { buildPayload, printHuman } from './pricing/report.ts'

/**
 - @param {string[]} argv 命令行参数
 - @returns {string|undefined} --config 或 -c 后面的路径
 */
function parseConfigPath(argv: any) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') return argv[i + 1]
  }
  return undefined
}

/** 只读探测上游并打印价目表. */
async function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const config = loadConfig(parseConfigPath(argv))
  // --json 时压掉日志,保证 stdout 是纯 JSON,可直接被管道消费
  configureLogger(asJson ? { ...config.logging, level: 'error' } : config.logging)

  let ctx
  try {
    ctx = buildAppContext(config)
  } catch (err) {
    console.error('无法读取账号凭据：', err instanceof Error ? err.message : err)
    console.error('提示：先在 Web 控制台添加账号，或运行 npm run login。')
    process.exitCode = 1
    return
  }

  let session
  try {
    // GET 探测:不创建 session,不占额度(与控制台[检测]同一路径)
    session = await ctx.upstream.freebuffSession('GET')
  } catch (err) {
    console.error('上游探测失败：', err instanceof Error ? err.message : err)
    process.exitCode = 1
    return
  }

  const fb = session?.freebucks
  if (!fb || typeof fb !== 'object') {
    console.error('上游未返回 freebucks 计费信息（账号未登录 / 上游未启用该计费方式）。')
    process.exitCode = 1
    return
  }

  const daily = fb.daily || {}
  const limit = Number(daily.limit) || 0
  const { payload, rows, counted } = buildPayload(session)

  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return
  }

  printHuman(payload, rows, counted, { limit, daily, session })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err)
  process.exitCode = 1
})
