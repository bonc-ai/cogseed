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

_runtime_app_command() {
  local rest="$1" app_dir="$2" variant="$3"
  # Electron/Node switches precede the application directory when launched
  # through open --args. Never consume an arbitrary application or test entry.
  while :; do
    case "$rest" in
      --inspect=127.0.0.1:*\ *|--remote-debugging-address=127.0.0.1\ *|--remote-debugging-port=*\ *) rest="${rest#* }" ;;
      *) break ;;
    esac
  done
  case "$rest" in
    "$app_dir --cogseed-runtime-variant=$variant"|"$app_dir --cogseed-runtime-variant=$variant "*) return 0 ;;
    *) return 1 ;;
  esac
}

# stdin: ps 输出。stdout: 本 worktree 的运行时 pid，每行一个。
# Optional fourth argument `main` excludes gateways/renderers for readiness.
worktree_runtime_pids() {
  local app_dir="$1"
  local variant="${2:-cogseed}"
  local scope="${4:-all}"
  local _RUNTIME_EXE_SUFFIX="node_modules/electron/dist/${3:-CogSeed}.app/Contents/MacOS/Electron"
  local own_exe="$app_dir/$_RUNTIME_EXE_SUFFIX"
  local linux_exe="$app_dir/node_modules/electron/dist/electron"
  local npm_exe="$app_dir/node_modules/.bin/electron"
  local gateway="$app_dir/p3394-gateway/gateway.cjs"
  local pid command rest node_exe
  while read -r pid command; do
    [ -n "$pid" ] || continue
    if [ "$scope" = main ]; then
      case "$command" in *" --type="*) continue ;; esac
    fi
    case "$command" in
      # 主进程：`open` 启动时命令行以本 worktree 的可执行文件开头（后面跟 APP_DIR 与
      # --cogseed-runtime-variant）。前缀锚定，嵌套 worktree 的路径不会命中。
      "$own_exe "*|"$linux_exe "*)
        case "$command" in
          "$own_exe "*) command="${command#"$own_exe "}" ;;
          "$linux_exe "*) command="${command#"$linux_exe "}" ;;
        esac
        case "$command" in
          "$gateway"|"$gateway "*) if [ "$scope" != main ]; then printf '%s\n' "$pid"; fi ;;
          *) if _runtime_app_command "$command" "$app_dir" "$variant"; then printf '%s\n' "$pid"; fi ;;
        esac ;;
      "./$_RUNTIME_EXE_SUFFIX "*)
        if _runtime_app_command "${command#"./$_RUNTIME_EXE_SUFFIX "}" "$app_dir" "$variant"; then printf '%s\n' "$pid"; fi ;;
      # Electron 也用于 Vitest：只有带本工作区应用目录或网关入口的进程才可停止。
      # Wrappers belong to stop cleanup only; they can outlive Electron main.
      "$npm_exe "*|"node $npm_exe "*|*/node\ "$npm_exe "*)
        [ "$scope" != main ] || continue
        case "$command" in
          "$npm_exe "*) rest="${command#"$npm_exe "}" ;;
          *)
            node_exe="${command%% *}"
            case "$node_exe" in node|/*/node) ;; *) continue ;; esac
            case "$command" in
              "$node_exe $npm_exe "*) rest="${command#"$node_exe $npm_exe "}" ;;
              *) continue ;;
            esac ;;
        esac
        if _runtime_app_command "$rest" "$app_dir" "$variant" || _runtime_app_command "$rest" . "$variant"; then
          printf '%s\n' "$pid"
        fi ;;
      # 托管网关子进程：主进程停止后它若存活会成为孤儿。
      "node $gateway"|"node $gateway "*|*/node\ "$gateway"|*/node\ "$gateway "*)
        [ "$scope" != main ] || continue
        node_exe="${command%% *}"
        case "$node_exe" in node|/*/node) ;; *) continue ;; esac
        case "$command" in
          "$node_exe $gateway"|"$node_exe $gateway "*) printf '%s\n' "$pid" ;;
        esac ;;
    esac
  done
}

# stdin: ps 输出。stdout: 同 variant、但属于其它 worktree 的 Electron 主进程 pid。
other_worktree_runtime_pids() {
  local app_dir="$1"
  local variant="${2:-cogseed}"
  local _RUNTIME_EXE_SUFFIX="node_modules/electron/dist/${3:-CogSeed}.app/Contents/MacOS/Electron"
  local pid command other_dir rest
  while read -r pid command; do
    [ -n "$pid" ] || continue
    case "$command" in
      "./$_RUNTIME_EXE_SUFFIX $app_dir"|"./$_RUNTIME_EXE_SUFFIX $app_dir "*) continue ;;
    esac
    case "$command" in
      /*/"$_RUNTIME_EXE_SUFFIX "*)
        other_dir="${command%%/"$_RUNTIME_EXE_SUFFIX" *}"
        [ "$other_dir" != "$app_dir" ] || continue
        rest="${command#"$other_dir/$_RUNTIME_EXE_SUFFIX "}"
        if _runtime_app_command "$rest" "$other_dir" "$variant"; then printf '%s\n' "$pid"; fi ;;
      /*/node_modules/electron/dist/electron\ *)
        other_dir="${command%%/node_modules/electron/dist/electron *}"
        [ "$other_dir" != "$app_dir" ] || continue
        rest="${command#"$other_dir/node_modules/electron/dist/electron "}"
        if _runtime_app_command "$rest" "$other_dir" "$variant"; then printf '%s\n' "$pid"; fi ;;
    esac
  done
}
