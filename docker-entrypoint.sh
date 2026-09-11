#!/bin/sh
# 初始化 /data 布局，然后以降权用户运行应用。
set -e

DATA_DIR="${FREEBUFF_PROXY_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  # mkdir 失败（如只读挂载）不阻断启动：应用自身也会创建 /data/credentials
  mkdir -p "$DATA_DIR/credentials" 2>/dev/null || true
  # 一键体验：自动修复挂载卷的属主（含已存在文件）；失败（如只读挂载）不阻断启动
  # 注意 GNU coreutils 的 chown 会**先 chown 根目录、再遍历子项**：即使子项失败，
  # 根目录（应保证可写）也已生效——所以下面用「根目录能否写」作为唯一判据。
  chown -R node:node "$DATA_DIR" 2>/dev/null || true

  # 唯一要紧的判据：降权用户能否写数据目录。不能写时给出**准确**的原因与补救，
  # 而不是让用户对着 EROFS/EACCES 堆栈猜（issue #9 要的就是这份可诊断性）。
  # 实测：/data 真只读时应用起不来（要写 users.json），所以这里是「错误」不是「提示」。
  if ! su-exec node test -w "$DATA_DIR" 2>/dev/null; then
    echo "[freebuff-proxy] 错误: $DATA_DIR 对 node 用户不可写，应用将无法启动（需要写 users.json 等）。只读挂载请改为可写；root 拥有的宿主目录可执行: chown -R 1000:1000 <宿主机 data 目录>" >&2
  fi

  # 首次启动生成默认配置，方便直接编辑 /data/config.yaml
  if [ ! -f "$DATA_DIR/config.yaml" ]; then
    # cp 结果是 0644 root:root，属主靠上面的 chown -R 落到 node；这里再补一次，
    # 覆盖「生成晚于 chown」的窄缝（cp 失败重试等），确保降权后仍可编辑
    if cp /app/config.example.yaml "$DATA_DIR/config.yaml" 2>/dev/null; then
      chown node:node "$DATA_DIR/config.yaml" 2>/dev/null || true
      echo "[freebuff-proxy] 已生成默认配置: $DATA_DIR/config.yaml"
    else
      echo "[freebuff-proxy] 警告: 无法生成 $DATA_DIR/config.yaml（目录不可写），将使用内置默认值" >&2
    fi
  fi

  exec su-exec node "$@"
else
  mkdir -p "$DATA_DIR/credentials" 2>/dev/null || true
  exec "$@"
fi
