# syntax=docker/dockerfile:1
# freebuff-proxy —— 镜像。
#
# ⚠️ 基镜像从 alpine 换成 **slim**（glibc）的原因（2026-10-04 实测）：
#
#   cli-bridge 必须携带 bun 运行时（见下），而 bun 官方二进制是 **glibc**
#   动态链接的（`NEEDED libc.so.6` / `interpreter /lib64/ld-linux-x86-64.so.2`）。
#   alpine 是 musl：直接 COPY 进去跑不起来，报
#     `Error relocating /tmp/bun: __pthread_key_create: symbol not found`
#   （实测。装 `apk add gcompat` 也一样缺符号。）
#   `node:22-slim` 实测 `bun --version` → `1.4.2` 正常。
FROM node:22-slim

# 下载 bun 运行时（**锁定版本**，与官方桌面客户端同源）。
#
# 为什么必须打进镜像（2026-10-04 真实事故）：镜像里没有 bun 时，
# `buildRpcCfg`/`rpcReuse` 抛 `spawn bun ENOENT`，日志里只有一行
# `official channel rpc failed, falling back to legacy`，然后静默走 legacy
# 形态发 chat —— 而那条形态**必然**被上游拒（428 waiting_room_required），
# 于是"花了钱、请求失败、会话还被释放掉"。
# 即：**没有 bun 的部署 = 每次 chat 都在白烧一小时额度。**
#
# 版本锁 1.4.2：与本地 `cli-bridge/bun` 及官方客户端 AppImage 内那份一致
# （docs/reverse/11-tls-fingerprint.md 要求 TLS 栈同源）。换版本等于换指纹。
ARG BUN_VERSION=1.4.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && unzip -q -o /tmp/bun.zip -d /tmp \
 && mkdir -p /opt/bun \
 && cp /tmp/bun-linux-x64/bun /opt/bun/bun \
 && chmod 0755 /opt/bun/bun \
 && /opt/bun/bun --version \
 && rm -rf /tmp/bun.zip /tmp/bun-linux-x64 \
 && apt-get purge -y --auto-remove unzip \
 && rm -rf /var/lib/apt/lists/*

# 降权工具：Debian 侧用 **setpriv**（util-linux 自带，无需安装），
# 替代 alpine 的 su-exec（Debian 无此包，实测 `E: Unable to locate package su-exec`）。
# entrypoint 用它从 root 降到 node(1000) 运行应用。
# 留这一行只为显式声明依赖可满足性（setpriv 已内置于基镜像）。
RUN setpriv --version > /dev/null && node -e "process.exit(0)" \
 && npm config set update-notifier false

ENV NODE_ENV=production \
    FREEBUFF_PROXY_DATA_DIR=/data \
    FREEBUFF_PROXY_CONFIG=/data/config.yaml \
    # cli-bridge 用它在容器里找到 bun（bridge.mjs 的 resolveBun 优先级：
    # FREEBUFF_BUN_BIN > ./bun > PATH）
    FREEBUFF_BUN_BIN=/opt/bun/bun \
    # 172.16.0.0/12：docker 网关/内网地址不走代理（代理本身若在宿主机网关不受影响）
    NO_PROXY=127.0.0.1,localhost,172.16.0.0/12 \
    npm_config_update_notifier=false

WORKDIR /app

# 先装依赖，利用层缓存（仅运行时依赖，镜像保持轻量）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

# 构建上下文里若有权限过窄的文件（如本地 umask 造成的 600），降权到 node 后
# 会读不到源码（issue #9 里 catalog 同步因此被静默禁用）。统一放宽为可读：
# 不改变属主、只保证 node 能读，且不可写（仍由 root 拥有）。
RUN chmod -R a+rX /app && chmod 0755 /app/docker-entrypoint.sh

# 启动自检：bun 必须可用 —— 缺它时**不允许**静默降级（见上面的说明）。
# 这里只做可见性检查（fail 会写在启动日志里），真正的硬门禁在运行时代码。
RUN /opt/bun/bun --version > /dev/null && echo "bun runtime present: $(/opt/bun/bun --version)"

# 不设 USER：entrypoint 以 root 初始化 /data 属主后自动降权到 node(1000)
# USER node
VOLUME ["/data"]
EXPOSE 8787

# ⚠️ HEALTHCHECK 用 **node 自己探活**，不用 wget/curl。
#
# 为什么（2026-10-04 CI 实测踩到）：基镜像从 alpine 换成 slim 后，
# `wget` **不存在**（alpine 是 busybox 内置，Debian 没有）——
# 于是 HEALTHCHECK 永远失败，容器一直停在 `health: starting`，
# CI 的 image-boot 13 个场景**全部 FAIL**（而应用其实起得好好的，
# healthz 明明回 200）。这类"应用正常但探活工具缺失"的失败极具迷惑性。
#
# node 一定存在（基镜像就是 node），用它发一次 HTTP 请求最稳、零额外依赖。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.FREEBUFF_PROXY_PORT||8787)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "bin/serve.js"]
