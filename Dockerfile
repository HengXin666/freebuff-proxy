# syntax=docker/dockerfile:1
# freebuff-proxy — 超级轻量镜像（node:22-alpine + 2 个 JS 运行时依赖）
FROM node:22-alpine

# su-exec：entrypoint 以 root 初始化 /data 权限后降权到 node(1000)
RUN apk add --no-cache su-exec && \
    npm config set update-notifier false

ENV NODE_ENV=production \
    FREEBUFF_PROXY_DATA_DIR=/data \
    FREEBUFF_PROXY_CONFIG=/data/config.yaml \
    NO_PROXY=127.0.0.1,localhost \
    npm_config_update_notifier=false

WORKDIR /app

# 先装依赖，利用层缓存（仅运行时依赖，镜像保持轻量）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

# 不设 USER：entrypoint 以 root 初始化 /data 属主后自动降权到 node(1000)
# USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "bin/serve.js"]
