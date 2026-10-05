/**
 * 路径与常量真源 -- 供 scripts/ci/pipeline/** 共用.
 *
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
