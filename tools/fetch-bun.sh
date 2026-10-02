#!/bin/sh
# 获取与官方客户端**同一份** bun 运行时。
#
# 为什么必须是"同一份"：cli-bridge 的全部意义在于让上游请求的 TLS 栈
# 与官方客户端同源（见 docs/reverse/11-tls-fingerprint.md）。
# 随便下一个 bun 会引入版本差异，等于白做。
#
# 优先级：
#   1. 本机已挂载的官方 AppImage（/tmp/.mount_Freebuf*/resources/bun/bun）
#   2. 环境变量 FREEBUFF_APPIMAGE 指定的 AppImage（自动挂载提取）
#   3. 官方安装脚本（版本可能不同，仅当上面都没有时）
#
# 用法：sh tools/fetch-bun.sh [目标路径]
set -eu

DEST="${1:-cli-bridge/bun}"
HERE=$(cd "$(dirname "$0")" && pwd)
[ -z "${DEST#/}" ] || DEST="$HERE/../$DEST"

# 1) 已挂载的 AppImage
for d in /tmp/.mount_Freebuf*; do
  if [ -f "$d/resources/bun/bun" ]; then
    echo "[fetch-bun] found mounted AppImage: $d"
    cp "$d/resources/bun/bun" "$DEST"
    chmod +x "$DEST"
    echo "[fetch-bun] installed -> $DEST ($("$DEST" --version))"
    exit 0
  fi
done

# 2) 指定的 AppImage：挂载后提取
if [ -n "${FREEBUFF_APPIMAGE:-}" ] && [ -f "$FREEBUFF_APPIMAGE" ]; then
  echo "[fetch-bun] extracting from $FREEBUFF_APPIMAGE"
  TMP=$(mktemp -d)
  # AppImage 自挂载（需要 FUSE；失败则回落到 --appimage-extract）
  "$FREEBUFF_APPIMAGE" --appimage-extract > /dev/null 2>&1 || true
  if [ -f "$TMP/squashfs-root/resources/bun/bun" ]; then
    cp "$TMP/squashfs-root/resources/bun/bun" "$DEST"
  elif [ -f "squashfs-root/resources/bun/bun" ]; then
    cp "squashfs-root/resources/bun/bun" "$DEST"
  else
    echo "[fetch-bun] extract failed" >&2
    rm -rf "$TMP"
    exit 1
  fi
  rm -rf "$TMP" squashfs-root 2>/dev/null || true
  chmod +x "$DEST"
  echo "[fetch-bun] installed -> $DEST ($("$DEST" --version))"
  exit 0
fi

# 3) 官方安装脚本（版本可能与客户端不同，仅兜底）
echo "[fetch-bun] WARNING: falling back to official installer; version may differ" >&2
curl -fsSL https://bun.sh/install | bash
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
cp "$BUN" "$DEST"
chmod +x "$DEST"
echo "[fetch-bun] installed -> $DEST ($("$DEST" --version))"
