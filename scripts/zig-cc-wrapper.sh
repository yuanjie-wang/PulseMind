#!/bin/sh
# ── zig-cc-wrapper ──
# zig 的 lld 封装把「不认识的链接参数」变成硬错误（"unsupported linker arg"），
# 而 better-sqlite3 的 binding.gyp 带 -Wl,--exclude-libs,ALL —— ziglang/zig#15113
# 从 2023-03 起一直 open（0.13~0.15 都没落地）。这个 flag 只是把静态库的符号从
# 动态符号表里隐藏，插件形态的 .node 缺了它不影响加载，所以滤掉比等上游现实。
# 白名单其余部分按 0.13.0 的 src/main.zig 实测核对过：-Bsymbolic 在列，无需处理。
#
# 用法：zig-cc <zig 子命令> <剩余参数原样透传，只滤 --exclude-libs 系>。
# ZIG_BIN 可指到别的 zig 实现；测试里换 echo 验证参数过滤。
set -e

[ $# -ge 1 ] || {
  echo 'usage: zig-cc <zig-subcommand> [args...]' >&2
  exit 2
}
subcmd=$1
shift
n=$#
i=1
while [ $i -le $n ]; do
  eval "a=\${$i}"
  case "$a" in
    -Wl,--exclude-libs* | --exclude-libs*) ;;
    *) set -- "$@" "$a" ;;
  esac
  i=$((i + 1))
done
shift $n
exec "${ZIG_BIN:-/opt/zig/zig}" "$subcmd" "$@"
