#!/bin/bash
# Restart the CogSeed runtime bound to this worktree.
#
# This worktree is locked to COGSEED_RUNTIME_VARIANT=cogseed and is
# launched with `./run.sh` (macOS: `open -W -n` on the variant app bundle).
# This script stops only processes of THIS worktree's cogseed runtime; another
# checkout must never count as this worktree being ready.
#
# Usage: scripts/restart-cogseed.sh [stop|start|restart]   (default: restart)
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VARIANT="cogseed"
RUN_LOG="/tmp/cogseed-${VARIANT}-run.log"
DATA_LOGS="$HOME/.cogseed/runtime-variants/${VARIANT}/data/logs"
ELECTRON_APP="$APP_DIR/node_modules/electron/dist/CogSeed.app/Contents/MacOS/Electron"
# shellcheck source=lib/runtime-pids.sh
source "$APP_DIR/scripts/lib/runtime-pids.sh"

# ps 在 C/POSIX locale 下会把命令里的非 ASCII 路径（如中文目录）转义成 `M-xx` 字节
# 序列，与基于 $APP_DIR 原始 UTF-8 的匹配永远失败 → 「no running runtime」误判、
# 重启停不掉旧实例。统一用 UTF-8 locale 让 ps 输出原始字节；macOS 默认提供
# en_US.UTF-8（不可用时退回原样）。
# 注意：不要用 `locale -a | grep -q` 探测——set -o pipefail 下 grep -q 匹配即关闭
# 管道，locale -a 收到 SIGPIPE（141）导致整条管道误判失败。
ps_snapshot() {
  local ps_cmd=(ps -ax -o pid= -o command=)
  local locale_list locale_has_utf8=false
  locale_list="$(locale -a 2>/dev/null || true)"
  case "$locale_list" in
    *en_US.UTF-8*) locale_has_utf8=true ;;
  esac
  if [ "$locale_has_utf8" = true ]; then
    ps_cmd=(env LC_ALL=en_US.UTF-8 ps -ax -o pid= -o command=)
  fi
  "${ps_cmd[@]}"
}

worktree_pids() {
  ps_snapshot | worktree_runtime_pids "$APP_DIR" "$VARIANT"
}

other_worktree_pids() {
  ps_snapshot | other_worktree_runtime_pids "$APP_DIR" "$VARIANT"
}

stop() {
  local pids
  pids="$(worktree_pids)"
  if [ -z "$pids" ]; then
    echo "[restart-cogseed] no running ${VARIANT} runtime for this worktree"
    return 0
  fi
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 50); do
    if [ -z "$(worktree_pids)" ]; then
      echo "[restart-cogseed] ${VARIANT} runtime stopped"
      return 0
    fi
    sleep 0.2
  done
  echo "[restart-cogseed] force-killing remaining ${VARIANT} processes for this worktree" >&2
  for pid in $(worktree_pids); do
    kill -9 "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 50); do
    if [ -z "$(worktree_pids)" ]; then
      echo "[restart-cogseed] ${VARIANT} runtime stopped (forced)"
      return 0
    fi
    sleep 0.2
  done
  echo "[restart-cogseed] ${VARIANT} processes still present after SIGKILL" >&2
  return 1
}

start() {
  if [ -n "$(worktree_pids)" ]; then
    echo "[restart-cogseed] ${VARIANT} runtime already running for this worktree"
    return 0
  fi
  # 同一 variant 共享 userData 与单实例锁：别的 worktree 已在跑时，本次启动的实例会
  # 先起来再被锁挡下退出。提前说清楚，避免把「launched」当成本 worktree 已就绪。
  local others
  others="$(other_worktree_pids)"
  if [ -n "$others" ]; then
    echo "[restart-cogseed] warning: another worktree already runs the ${VARIANT} variant (pid $(echo $others | tr '\n' ' ')); this instance will be rejected by the shared single-instance lock." >&2
    echo "[restart-cogseed] run scripts/restart-cogseed.sh stop in that worktree first if you want this checkout's code in the window." >&2
  fi
  cd "$APP_DIR"
  nohup ./run.sh >"$RUN_LOG" 2>&1 &
  echo "[restart-cogseed] launched ./run.sh (pid $!) — launcher log: $RUN_LOG"
}

wait_ready() {
  # 单实例锁被别的 worktree 占用时，新实例会先起来再立刻退出；只看一次进程存在会
  # 误报就绪（曾把别的 checkout 的窗口当成自己的启动结果）。要求连续两次采样
  # （间隔 1s）都看到本 worktree 的进程才算稳定就绪。
  local streak=0 others
  for _ in $(seq 1 60); do
    if [ -n "$(worktree_pids)" ]; then
      streak=$((streak + 1))
      if [ "$streak" -ge 2 ]; then
        echo "[restart-cogseed] ${VARIANT} runtime is up for this worktree"
        return 0
      fi
      sleep 1
      continue
    fi
    streak=0
    sleep 0.5
  done
  others="$(other_worktree_pids)"
  if [ -n "$others" ]; then
    echo "[restart-cogseed] ${VARIANT} runtime did not stay up for this worktree: another worktree holds the shared single-instance lock (pid $(echo $others | tr '\n' ' '))." >&2
    echo "[restart-cogseed] stop that instance first, then retry — the window is currently running that checkout's code." >&2
  else
    echo "[restart-cogseed] ${VARIANT} runtime did not start within 30s; check $RUN_LOG" >&2
  fi
  return 1
}

restart() {
  stop
  start
  wait_ready
  echo "[restart-cogseed] app logs: ${DATA_LOGS}/$(date +%Y-%m-%d).log"
}

case "${1:-restart}" in
  stop) stop ;;
  start) start; wait_ready ;;
  restart) restart ;;
  *) echo "usage: $0 [stop|start|restart]" >&2; exit 2 ;;
esac
