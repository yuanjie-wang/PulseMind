#!/bin/sh
# PulseMind 免 root 安装器（UOS 20 / Debian 10 及同类发行版）。
#
# 背景：UOS 等政企终端的普通用户没有 root，.deb 装不了（dpkg -i 要 root），
# AppImage 又常缺 libfuse2。本脚本配合 CI 产出的 tar.gz 免安装包工作：
#
#   tar -xzf PulseMind-<版本>-linux-x64.tar.gz
#   cd PulseMind-<版本>-linux-x64      # 解压出的目录（含 PulseMind/、install.sh、icon.png）
#   ./install.sh                       # 安装到 ~/Applications/PulseMind
#
# 所有写入都在当前用户家目录内（应用本体 + 桌面入口 + 图标），不调 sudo、
# 不碰系统目录。用户数据在 ~/.pulsemind，与安装位置无关，重装/卸载都不动它。
#
# 用法：
#   ./install.sh [--dir <安装目录>] [--no-desktop]
#   ./install.sh --uninstall [--dir <安装目录>]
#   ./install.sh --help

set -eu

die() { echo "错误：$*" >&2; exit 1; }
say() { echo "$*"; }

usage() {
  cat <<'EOF'
用法：
  ./install.sh                     安装到 ~/Applications/PulseMind，并注册桌面图标
  ./install.sh --dir <目录>         安装到指定目录（须在当前用户可写位置）
  ./install.sh --no-desktop        只装文件，不写桌面入口/图标
  ./install.sh --uninstall         卸载（默认从桌面入口反解安装目录；用户数据 ~/.pulsemind 保留）
  ./install.sh --help              显示本帮助

环境变量：
  PULSEMIND_HOME   默认安装根目录（缺省 ~/Applications，应用落位 <根>/PulseMind）
EOF
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_SRC_DIR="$SCRIPT_DIR/PulseMind"
ICON_SRC="$SCRIPT_DIR/icon.png"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DESKTOP_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$DESKTOP_DIR/pulsemind.desktop"
ICON_DIR="$DATA_HOME/icons/hicolor/256x256/apps"
ICON_DEST="$ICON_DIR/pulsemind.png"

INSTALL_ROOT="${PULSEMIND_HOME:-$HOME/Applications}"
INSTALL_DIR="$INSTALL_ROOT/PulseMind"
INSTALL_DIR_SET=0
WRITE_DESKTOP=1
MODE=install

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      shift
      [ $# -gt 0 ] || die "--dir 需要一个目录参数"
      INSTALL_DIR="$1"
      INSTALL_DIR_SET=1
      ;;
    --no-desktop) WRITE_DESKTOP=0 ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
  shift
done

# 防手滑：删/装的目标绝不能是根或家目录本身。
case "$INSTALL_DIR" in
  ''|/|"$HOME"|"$HOME/") die "安装目录不合法：'$INSTALL_DIR'" ;;
esac

refresh_desktop_db() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi
}

if [ "$MODE" = uninstall ]; then
  # 没显式给 --dir 时从桌面入口反解安装目录 —— 装在自定义路径也能卸干净。
  if [ "$INSTALL_DIR_SET" = 0 ] && [ -f "$DESKTOP_FILE" ]; then
    EXEC_PATH=$(sed -n 's/^Exec="\([^"]*\)".*/\1/p' "$DESKTOP_FILE" | head -n 1)
    if [ -n "$EXEC_PATH" ]; then
      INSTALL_DIR=$(dirname -- "$EXEC_PATH")
      # 反解出的路径必须在当前用户家目录内 —— 一个手写的 desktop 文件
      # 不该能指使本脚本去删任意目录。确要卸别处就显式给 --dir。
      case "$INSTALL_DIR" in
        "$HOME"/*) ;;
        *) die "桌面入口指向家目录之外（'$INSTALL_DIR'）；如确要卸载请显式给 --dir" ;;
      esac
    fi
  fi
  case "$INSTALL_DIR" in
    ''|/|"$HOME"|"$HOME/") die "拒绝卸载：安装目录不合法（'$INSTALL_DIR'）" ;;
  esac
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf -- "$INSTALL_DIR"
    say "已删除应用目录：$INSTALL_DIR"
  else
    say "应用目录不存在，跳过：$INSTALL_DIR"
  fi
  rm -f -- "$DESKTOP_FILE" "$ICON_DEST"
  refresh_desktop_db
  say "已移除桌面入口与图标。用户数据（~/.pulsemind）未改动。"
  exit 0
fi

[ -x "$APP_SRC_DIR/pulsemind" ] || die "当前目录不像解压后的安装包（缺 PulseMind/pulsemind）。请在解压出来的目录里运行本脚本。"

if [ "$(id -u)" = 0 ]; then
  say "提示：当前是 root。本脚本不需要 root，装到 root 家目录后普通用户用不了；建议换普通用户运行。"
fi

# 沙箱判定：Electron 的 SUID 沙箱要 setuid 位（只有 root 能给），普通用户因此
# 依赖内核的非特权 user namespace。UOS/Debian 10 默认开启；被加固关掉的机器
# 只能带 --no-sandbox 启动（安全边界变弱，但能跑）。证据优先：能实测就实测。
SANDBOX_FLAG=""
if [ "$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo 1)" = "0" ]; then
  SANDBOX_FLAG="--no-sandbox"
fi
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  SANDBOX_FLAG="--no-sandbox"
fi
if command -v unshare >/dev/null 2>&1; then
  unshare -U true >/dev/null 2>&1 || SANDBOX_FLAG="--no-sandbox"
fi

say "安装 PulseMind 到：$INSTALL_DIR"
mkdir -p -- "$(dirname -- "$INSTALL_DIR")"
OLD_DIR=""
# 复制失败（磁盘满等）时把旧目录原样搬回去 —— 升级中途断掉不该留下半个应用。
cleanup_old() {
  if [ -n "$OLD_DIR" ] && [ -d "$OLD_DIR" ]; then
    rm -rf -- "$INSTALL_DIR"
    mv -- "$OLD_DIR" "$INSTALL_DIR"
  fi
}
trap cleanup_old EXIT
if [ -e "$INSTALL_DIR" ]; then
  OLD_DIR="$INSTALL_DIR.old.$$"
  mv -- "$INSTALL_DIR" "$OLD_DIR"
fi
cp -R -- "$APP_SRC_DIR" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/pulsemind"
if [ -n "$OLD_DIR" ]; then
  rm -rf -- "$OLD_DIR"
  OLD_DIR=""
fi

if [ "$WRITE_DESKTOP" = 1 ]; then
  mkdir -p -- "$DESKTOP_DIR" "$ICON_DIR"
  if [ -f "$ICON_SRC" ]; then
    cp -f -- "$ICON_SRC" "$ICON_DEST"
  else
    say "提示：安装包里没有 icon.png，桌面图标可能显示为默认图标。"
  fi
  EXEC_LINE="Exec=\"$INSTALL_DIR/pulsemind\""
  if [ -n "$SANDBOX_FLAG" ]; then
    EXEC_LINE="$EXEC_LINE $SANDBOX_FLAG"
  fi
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=PulseMind
$EXEC_LINE %U
Terminal=false
Type=Application
Icon=pulsemind
StartupWMClass=PulseMind
Comment=PulseMind Desktop AI Chat Application
Categories=Development;
EOF
  chmod 644 "$DESKTOP_FILE"
  refresh_desktop_db
  say "桌面入口已写入：$DESKTOP_FILE"
fi

say ""
say "安装完成。"
LAUNCH_CMD="\"$INSTALL_DIR/pulsemind\""
if [ -n "$SANDBOX_FLAG" ]; then
  LAUNCH_CMD="$LAUNCH_CMD $SANDBOX_FLAG"
fi
say "启动：应用菜单里找 PulseMind，或直接运行："
say "  $LAUNCH_CMD"
if [ -n "$SANDBOX_FLAG" ]; then
  say "（本机没有可用的非特权 user namespace，桌面入口已带 --no-sandbox）"
fi
say "用户数据位置：~/.pulsemind（卸载不会删除）"
