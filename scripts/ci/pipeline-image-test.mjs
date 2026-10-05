#!/usr/bin/env node
/**
 * 镜像流水线:真实构建 → 真实启动 → 真实探测.
 *
 * 为什么要有它:镜像"能 build,能 push"不等于"能跑".真实事故是 -- 换了新镜像后
 * 用户环境里的容器起不来,删掉几个 /data/*.json 才恢复.本地 docker build .
 * 和 CI 的 smoke(mock 上游)都覆盖不到这条路径:它们要么没挂 /data,要么不真正
 * 启动容器.于是"镜像 + 旧数据目录"这个组合永远没人验过.
 *
 * 这个脚本把那条路径补上,且完全离线(固件里不放凭据,避免真连上游):
 *
 * 1. build   构建镜像(--no-build 可跳过,直接测已有镜像)
 * 2. fixture 造数据目录:空目录 / 仓库当前 data/ 的副本 / 逐个把某个 JSON 写坏
 * 3. run     每个场景起一个容器(独立端口 + 独立挂载卷),等 /healthz
 * 4. assert  进程活着 + 健康检查通过 + 启动日志里的[数据文件自检]符合预期
 *            (损坏文件应当被点名;users.json 损坏应当拒绝启动并说明原因)
 * 5. report  逐场景 PASS/FAIL + 失败时打印容器日志尾部;有失败则退出码 1
 *
 * 用法:
 * node scripts/ci/pipeline-image-test.mjs                 # 构建 + 全场景
 * node scripts/ci/pipeline-image-test.mjs --no-build      # 只测已有镜像
 * node scripts/ci/pipeline-image-test.mjs --image ghcr.io/hengxin666/freebuff-proxy:latest
 * node scripts/ci/pipeline-image-test.mjs --keep          # 保留 fixture/容器便于排查
 * node scripts/ci/pipeline-image-test.mjs --with-credentials   # 带上真实凭据(会连上游,慎用)
 *
 * 本文件是薄门面:实现已按职责拆进 scripts/ci/pipeline/**(lib 小工具 /
 * scenarios 场景与断言 / run 编排).保留原路径与入口,package.json 的
 * pipeline:image 脚本无需改动.
 */
import path from 'node:path'
import { LOCAL_IMAGE, ROOT } from './pipeline/lib/paths.mjs'
import { main } from './pipeline/run.mjs'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

main({
  image: valueOf('--image', LOCAL_IMAGE),
  skipBuild: has('--no-build'),
  keep: has('--keep'),
  withCredentials: has('--with-credentials'),
  dataSource: valueOf('--data', path.join(ROOT, 'data')),
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
