/**
 * 路径与常量真源 -- 供 scripts/ci/pipeline/** 共用.
 *
 * 为什么要单独一个文件: ROOT 是从本文件位置往上推的. 实现搬进子目录后
 * 每个文件离仓库根的层数都变了, 各处各推一次必然有两处算错(而且症状是
 * "fixture 复制不到文件"这类间接失败). 只允许一处推.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根(本文件在 scripts/ci/pipeline/lib/ 下, 上推四层). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/** 本地构建用的镜像名. */
export const LOCAL_IMAGE = 'freebuff-proxy-pipeline:local'

/** 容器内监听端口(Dockerfile EXPOSE 8787). */
export const CONTAINER_PORT = 8787

/** 冷启动预算:Dockerfile 的 start-period(15s) + 首次 catalog/句柄装载. */
export const BOOT_TIMEOUT_MS = 60_000
