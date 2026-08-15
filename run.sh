#!/bin/bash
# CogSeed source launcher. Each runtime variant owns its data, Electron
# userData, application identity, and single-instance lock.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
VARIANT="cogseed"

usage() {
  cat <<'EOF'
Usage: ./run.sh

This worktree is locked to the CogSeed runtime identity. Run cognition,
expense, or optimization module development from their dedicated worktrees.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[CogSeed] Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ -n "${ORKAS_RUNTIME_VARIANT:-}" ] && [ "$ORKAS_RUNTIME_VARIANT" != "cogseed" ]; then
  echo "[CogSeed] This worktree is locked to the cogseed runtime; ORKAS_RUNTIME_VARIANT=$ORKAS_RUNTIME_VARIANT is not allowed." >&2
  exit 2
fi
if [ -n "${ORKAS_WORKSPACE_ROOT:-}" ]; then
  echo "[CogSeed] This worktree manages its own cogseed data root; inherited ORKAS_WORKSPACE_ROOT is not allowed." >&2
  exit 2
fi
export ORKAS_RUNTIME_VARIANT="cogseed"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[CogSeed] $APP_DIR/package.json not found; check the project directory layout." >&2
  exit 1
fi

is_wsl() {
  [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ] || {
    [ -r /proc/version ] && grep -qiE 'microsoft|wsl' /proc/version
  }
}

if is_wsl; then
  if command -v cmd.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
    WIN_APP_DIR="$(wslpath -w "$APP_DIR")"
    cat >&2 <<EOF
[CogSeed] WSL/WSLg detected.
[CogSeed] Launching the Windows-native $VARIANT runtime via run.cmd.
EOF
    exec cmd.exe /d /s /c "pushd \"$WIN_APP_DIR\" && run.cmd"
  fi
  cat >&2 <<'EOF'
[CogSeed] WSL/WSLg detected, but cmd.exe/wslpath is unavailable.
[CogSeed] On Windows, launch CogSeed with run.cmd so Windows IME works normally.
EOF
  exit 1
fi

echo "[CogSeed] Starting source runtime: $VARIANT"
if command -v git >/dev/null 2>&1; then
  export ORKAS_BUILD_COMMIT="${ORKAS_BUILD_COMMIT:-$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)}"
  if [ -z "${ORKAS_BUILD_DIRTY:-}" ]; then
    if [ -n "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ]; then export ORKAS_BUILD_DIRTY=1; else export ORKAS_BUILD_DIRTY=0; fi
  fi
fi
export ORKAS_BUILD_CHANNEL="${ORKAS_BUILD_CHANNEL:-dev}"
export ORKAS_BUILD_TIME="${ORKAS_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
echo "[CogSeed] Build identity: ${ORKAS_BUILD_CHANNEL} ${ORKAS_BUILD_COMMIT:-unknown} dirty=${ORKAS_BUILD_DIRTY:-unknown}"

node "$APP_DIR/scripts/ensure-deps.cjs"
node "$APP_DIR/scripts/ensure-dev-dependencies.cjs"
node "$APP_DIR/scripts/prepare-source-runtime.cjs" --variant="$VARIANT"

cd "$APP_DIR"
if [ "$(uname -s)" = "Darwin" ]; then
  APP_BUNDLE="$APP_DIR/node_modules/electron/dist/CogSeed.app"
  if [ -d "$APP_BUNDLE" ]; then
    ARGS=("$APP_DIR" "--orkas-runtime-variant=$VARIANT")
    OPEN_ENV_ARGS=()
    if [ -n "${COGSEED_HUB_API_BASE:-}" ]; then
      OPEN_ENV_ARGS+=(--env "COGSEED_HUB_API_BASE=$COGSEED_HUB_API_BASE")
    fi
    if [ -n "${ORKAS_HUB_API_BASE:-}" ]; then
      OPEN_ENV_ARGS+=(--env "ORKAS_HUB_API_BASE=$ORKAS_HUB_API_BASE")
    fi
    if [ -n "${ORKAS_KSTAR_ENGINE_COMMAND:-}" ] && [ -n "${ORKAS_KSTAR_ENGINE_ARGS:-}" ]; then
      ARGS+=("--orkas-kstar-engine-command=$ORKAS_KSTAR_ENGINE_COMMAND")
      ARGS+=("--orkas-kstar-engine-args=$ORKAS_KSTAR_ENGINE_ARGS")
      ARGS+=("--orkas-kstar-engine-cwd=$ORKAS_KSTAR_ENGINE_CWD")
      ARGS+=("--orkas-kstar-engine-ontology-dir=$ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR")
    fi
    if (( ${#OPEN_ENV_ARGS[@]} > 0 )); then
      exec open -W -n "${OPEN_ENV_ARGS[@]}" "$APP_BUNDLE" --args "${ARGS[@]}"
    else
      exec open -W -n "$APP_BUNDLE" --args "${ARGS[@]}"
    fi
  fi
fi

exec npm run start:electron -- --orkas-runtime-variant="$VARIANT" \
  2> >(grep -v --line-buffered "EGL Driver message" >&2)
