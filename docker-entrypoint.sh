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
    # 挂载卷由 root 创建时文件属主仍是 root（宿主上是 uid 0），降权到 node 前
    # 必须改成 node 可读写：否则 /data/config.yaml 变成"生成了但改不动"，
    # 用户按 entrypoint 提示去编辑会直接 EACCES（issue #9 相关）。
    # chown 失败（如只读挂载）不阻断启动，但要告警，别让用户以为是别的问题。
    if ! chown node:node "$DATA_DIR/config.yaml" 2>/dev/null; then
      echo "[freebuff-proxy] 警告: 无法修改 $DATA_DIR/config.yaml 属主（只读挂载？）" >&2
    fi
    chmod 0644 "$DATA_DIR/config.yaml" 2>/dev/null || true
    echo "[freebuff-proxy] 已生成默认配置: $DATA_DIR/config.yaml"
  fi

  exec su-exec node "$@"
else
  mkdir -p "$DATA_DIR/credentials" 2>/dev/null || true
  exec "$@"
fi
