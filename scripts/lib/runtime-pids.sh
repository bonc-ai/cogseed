#!/bin/bash
# CogSeed worktree 运行时进程匹配（供 scripts/restart-cogseed.sh 与静态回归测试共用）。
#
# 为什么单独成库：`.worktrees/` 嵌套在仓库内部，任何基于「路径前缀」或「子串包含」的
# 宽松匹配都会把嵌套 worktree 的实例算成本 worktree 的运行时。本文件把匹配收成两个
# 纯函数（stdin 读 `ps -ax -o pid= -o command=` 输出），让判定可被测试直接钉住：
#   - worktree_runtime_pids：只返回**本 worktree** 的 Electron 主进程与 gateway 子进程；
#   - other_worktree_runtime_pids：返回**同 variant 但属于其它 worktree**的 Electron 主进程，
#     用于诊断「单实例锁被别的 worktree 占用」这类启动假成功。

# 本 worktree 的 Electron 主可执行文件后缀（路径以它结尾才算主进程）。
_RUNTIME_EXE_SUFFIX="node_modules/electron/dist/CogSeed.app/Contents/MacOS/Electron"

# stdin: ps 输出。stdout: 本 worktree 的运行时 pid，每行一个。
worktree_runtime_pids() {
  local app_dir="$1"
  local own_exe="$app_dir/$_RUNTIME_EXE_SUFFIX"
  local npm_exe="$app_dir/node_modules/.bin/electron ."
  local gateway="$app_dir/p3394-gateway/gateway.cjs"
  local pid command
  while read -r pid command; do
    [ -n "$pid" ] || continue
    case "$command" in
      # 主进程：`open` 启动时命令行以本 worktree 的可执行文件开头（后面跟 APP_DIR 与
      # --cogseed-runtime-variant）。前缀锚定，嵌套 worktree 的路径不会命中。
      "$own_exe"|"$own_exe "*) printf '%s\n' "$pid" ;;
      # npm start / 直接调用：命令里含本 worktree 的 electron 入口。
      *"$npm_exe"*) printf '%s\n' "$pid" ;;
      # 托管网关子进程：主进程停止后它若存活会成为孤儿。
      *"$gateway"*) printf '%s\n' "$pid" ;;
    esac
  done
}

# stdin: ps 输出。stdout: 同 variant、但属于其它 worktree 的 Electron 主进程 pid。
other_worktree_runtime_pids() {
  local app_dir="$1"
  local own_exe="$app_dir/$_RUNTIME_EXE_SUFFIX"
  local pid command exe
  while read -r pid command; do
    [ -n "$pid" ] || continue
    exe="${command%% *}"
    case "$exe" in
      "$own_exe"|"$app_dir/node_modules/.bin/electron") continue ;;
    esac
    case "$exe" in
      */"$_RUNTIME_EXE_SUFFIX") printf '%s\n' "$pid" ;;
    esac
  done
}
