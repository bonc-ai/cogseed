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

variant_pids() {
  pgrep -f "orkas-runtime-variant=${VARIANT}" 2>/dev/null || true
}

worktree_pids() {
  local pid
  for pid in $(variant_pids); do
    if ps -p "$pid" -o command= 2>/dev/null | grep -qF "$APP_DIR"; then
      printf '%s\n' "$pid"
    fi
  done
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
