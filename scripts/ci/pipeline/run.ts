/**
 * 场景编排与总报告 -- 从 scripts/ci/pipeline-image-test.ts 按职责切出.
 *
 * 口径: 纯搬移, 不改行为, 不改任何一行用户可见输出.
 */
import { dim, green, log, red, run } from './lib/io.ts'
import { LOCAL_IMAGE, ROOT } from './lib/paths.ts'
import { buildScenarios, printResultLine, runScenario } from './scenarios.ts'
import { listDataSourceFiles, synthesizeDataSource } from './lib/fixtures.ts'

/**
 * 跑完整条流水线:可选构建 -> 准备数据源 -> 逐场景执行 -> 汇总.
 * @param {{image: string, skipBuild: boolean, keep: boolean, withCredentials: boolean, dataSource: string}} opts 运行选项
 * @returns {Promise<void>} 无返回值;有失败场景时退出码 1
 */
export async function main(opts) {
  const docker = run('docker', ['version', '--format', '{{.Server.Version}}'])
  if (docker.status !== 0) {
    console.error(red('Docker 不可用，镜像流水线无法运行'))
    process.exit(2)
  }
  log(dim(`docker ${String(docker.stdout).trim()}`))

  const targetImage = opts.image
  if (!opts.skipBuild) {
    log(`\n▶ 构建镜像 ${targetImage}`)
    const build = run('docker', ['build', '-t', targetImage, '.'], { cwd: ROOT, stdio: 'inherit' })
    if (build.status !== 0) {
      console.error(red('构建失败'))
      process.exit(1)
    }
  } else {
    log(`\n▶ 跳过构建，使用镜像 ${targetImage}`)
  }

  let source = opts.dataSource
  let files = listDataSourceFiles(source)
  if (!files.length) {
    // CI / 全新 clone 没有 data/:合成一份,别让"损坏文件"场景被静默跳过
    source = synthesizeDataSource()
    files = listDataSourceFiles(source)
    log(dim(`数据源 ${opts.dataSource} 为空（未跟踪/首次运行）→ 已合成 ${files.length} 个最小 JSON 作为基线`))
  }
  const scenarios = buildScenarios(files).map((s) => ({ ...s, sourceDir: source }))
  log(dim(`数据源: ${source}（${files.length} 个 JSON）· 凭据: ${opts.withCredentials ? '带上（会连上游）' : '不带（离线）'}`))

  const runOpts = { ...opts, dataSource: source, image: targetImage }
  const results = []
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i]
    log(`\n▶ [${i + 1}/${scenarios.length}] ${s.title}`)
    const r = await runScenario(s, i, targetImage, runOpts)
    for (const n of r.notes) log(`   ${n}`)
    printResultLine(r)
    results.push(r)
  }

  report(results)
}

/** 汇总:逐场景结果 + 失败场景的日志尾部. */
function report(results) {
  const failed = results.filter((r) => !r.ok)
  log('\n' + '─'.repeat(60))
  for (const r of results) {
    log(`${r.ok ? green('') : red('')} ${r.id.padEnd(22)} ${r.title}`)
  }
  log(`\n${results.length - failed.length}/${results.length} 个场景通过`)

  if (failed.length) {
    for (const r of failed) {
      log(`\n=== ${r.id} 日志尾部 ===`)
      log(String(r.logs || '').split('\n').slice(-30).join('\n'))
    }
    process.exit(1)
  }
}

export { LOCAL_IMAGE }
