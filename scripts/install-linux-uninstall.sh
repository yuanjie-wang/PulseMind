#!/bin/sh
# PulseMind 卸载器（免 root 包里的「双击卸载」入口）。
#
# 只做一件事：把 install.sh --uninstall 包一层。安装目录默认从桌面入口反解，
# 所以当初装到哪儿（默认 ~/Applications/PulseMind，还是 --dir 指定的位置）都
# 卸得掉；用户数据 ~/.pulsemind 不动。
#
# 用 `sh install.sh` 而不是直接执行：从 U 盘 / FAT 分区拿到本包时执行位可能
# 丢了，双击能跑、直接 exec 会 Permission denied。

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALLER="$SCRIPT_DIR/install.sh"

[ -f "$INSTALLER" ] || {
  echo "错误：同目录下找不到 install.sh，无法卸载。" >&2
  exit 1
}

exec sh "$INSTALLER" --uninstall "$@"
