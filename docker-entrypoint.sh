#!/bin/sh
# 初始化 /data 布局，然后以降权用户运行应用。
set -e

DATA_DIR="${FREEBUFF_PROXY_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/credentials"
  # 一键体验：自动修复挂载卷的属主；失败（如只读挂载）不阻断启动
  chown -R node:node "$DATA_DIR" 2>/dev/null || true

  # 首次启动生成默认配置，方便直接编辑 /data/config.yaml
  if [ ! -f "$DATA_DIR/config.yaml" ]; then
    cp /app/config.example.yaml "$DATA_DIR/config.yaml"
    chown node:node "$DATA_DIR/config.yaml" 2>/dev/null || true
    echo "[freebuff-proxy] 已生成默认配置: $DATA_DIR/config.yaml"
  fi

  exec su-exec node "$@"
else
  mkdir -p "$DATA_DIR/credentials" 2>/dev/null || true
  exec "$@"
fi
