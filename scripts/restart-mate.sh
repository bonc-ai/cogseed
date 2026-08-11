#!/bin/bash
# Restart the CogSeed runtime bound to this worktree.
#
# This worktree is locked to ORKAS_RUNTIME_VARIANT=mate and is
# launched with `./run.sh` (macOS: `open -W -n` on the variant app bundle).
# This script stops only processes of THIS worktree's mate runtime (other
# variants such as expense/cognition are untouched), then relaunches via
# ./run.sh in the background so the caller's shell is not blocked.
#
# Usage: scripts/restart-mate.sh [stop|start|restart]   (default: restart)
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VARIANT="mate"
RUN_LOG="/tmp/mate-agent-${VARIANT}-run.log"
DATA_LOGS="$HOME/.orkas/runtime-variants/${VARIANT}/data/logs"

# The main process and the `open -W -n` wrapper both carry
# `orkas-runtime-variant=mate`; helper processes only carry the app path.
variant_pids() {
  pgrep -f "orkas-runtime-variant=${VARIANT}" 2>/dev/null || true
}

# Every liveness decision uses this, not variant_pids: a mate-variant process
# from another checkout must never count as our app being up, or the relaunch
# gets skipped while the script reports success.
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
    echo "[restart-mate] no running ${VARIANT} runtime"
    return 0
  fi
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  # Give the app a few seconds to exit (main process teardown, flush state).
  for _ in $(seq 1 50); do
    if [ -z "$(worktree_pids)" ]; then
      echo "[restart-mate] ${VARIANT} runtime stopped"
      return 0
    fi
    sleep 0.2
  done
  echo "[restart-mate] force-killing remaining ${VARIANT} processes" >&2
  for pid in $(worktree_pids); do
    kill -9 "$pid" 2>/dev/null || true
  done
  # SIGKILL is asynchronous. Wait for the entries to actually leave the process
  # table, otherwise start() sees a dying pid and skips the relaunch.
  for _ in $(seq 1 50); do
    if [ -z "$(worktree_pids)" ]; then
      echo "[restart-mate] ${VARIANT} runtime stopped (forced)"
      return 0
    fi
    sleep 0.2
  done
  echo "[restart-mate] ${VARIANT} processes still present after SIGKILL" >&2
  return 1
}

start() {
  if [ -n "$(worktree_pids)" ]; then
    echo "[restart-mate] ${VARIANT} runtime already running"
    return 0
  fi
  cd "$APP_DIR"
  nohup ./run.sh >"$RUN_LOG" 2>&1 &
  echo "[restart-mate] launched ./run.sh (pid $!) — launcher log: $RUN_LOG"
}

wait_ready() {
  # Wait until the variant main process is up, then confirm the app logger
  # starts writing today's file.
  for _ in $(seq 1 60); do
    if [ -n "$(worktree_pids)" ]; then
      echo "[restart-mate] ${VARIANT} runtime process is up"
      return 0
    fi
    sleep 0.5
  done
  echo "[restart-mate] ${VARIANT} runtime did not start within 30s; check $RUN_LOG" >&2
  return 1
}

restart() {
  stop
  start
  wait_ready
  echo "[restart-mate] app logs: ${DATA_LOGS}/$(date +%Y-%m-%d).log"
}

case "${1:-restart}" in
  stop) stop ;;
  start) start; wait_ready ;;
  restart) restart ;;
  *) echo "usage: $0 [stop|start|restart]" >&2; exit 2 ;;
esac
