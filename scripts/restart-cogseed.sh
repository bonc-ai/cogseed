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
RUN_LOG="/tmp/cogseed-agent-${VARIANT}-run.log"
DATA_LOGS="$HOME/.cogseed/runtime-variants/${VARIANT}/data/logs"
ELECTRON_APP="$APP_DIR/node_modules/electron/dist/CogSeed.app/Contents/MacOS/Electron"

worktree_pids() {
  local pid command
  # ps 在 C/POSIX locale 下会把命令里的非 ASCII 路径（如中文目录）转义成
  # `M-xx` 字节序列，与下面基于 $APP_DIR 原始 UTF-8 的 glob 匹配永远失败 →
  # 「no running runtime」误判、重启停不掉旧实例。统一用 UTF-8 locale 让 ps
  # 输出原始字节；macOS 默认提供 en_US.UTF-8（不可用时退回原样）。
  # 注意：不要用 `locale -a | grep -q` 探测——set -o pipefail 下 grep -q 匹配
  # 即关闭管道，locale -a 收到 SIGPIPE（141）导致整条管道误判失败。
  local ps_cmd=(ps -ax -o pid= -o command=)
  local locale_list locale_has_utf8=false
  locale_list="$(locale -a 2>/dev/null || true)"
  case "$locale_list" in
    *en_US.UTF-8*) locale_has_utf8=true ;;
  esac
  if [ "$locale_has_utf8" = true ]; then
    ps_cmd=(env LC_ALL=en_US.UTF-8 ps -ax -o pid= -o command=)
  fi
  while read -r pid command; do
    [ -n "$pid" ] || continue
    case "$command" in
      *"$APP_DIR/node_modules/.bin/electron ."|*"$APP_DIR/node_modules/.bin/electron . --orkas-runtime-variant=${VARIANT}"*|"$ELECTRON_APP"|"$ELECTRON_APP ."|"$ELECTRON_APP $APP_DIR --orkas-runtime-variant=${VARIANT}"*)
        printf '%s\n' "$pid"
        ;;
      # 托管网关子进程（gateway.cjs）也是本工作区运行时的一部分：主进程
      # 停止后它们若存活会成为孤儿，持续向 bridge hello → 删除的智能体
      # 被投影自动重建（同名撞名）。重启必须一并清掉。
      *"$APP_DIR/p3394-gateway/gateway.cjs"*)
        printf '%s\n' "$pid"
        ;;
    esac
  done < <("${ps_cmd[@]}")
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
  cd "$APP_DIR"
  nohup ./run.sh >"$RUN_LOG" 2>&1 &
  echo "[restart-cogseed] launched ./run.sh (pid $!) — launcher log: $RUN_LOG"
}

wait_ready() {
  for _ in $(seq 1 60); do
    if [ -n "$(worktree_pids)" ]; then
      echo "[restart-cogseed] ${VARIANT} runtime process is up for this worktree"
      return 0
    fi
    sleep 0.5
  done
  echo "[restart-cogseed] ${VARIANT} runtime did not start within 30s; check $RUN_LOG" >&2
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
