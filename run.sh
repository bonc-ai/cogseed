#!/bin/bash
# Mate Agent source launcher. Each runtime variant owns its data, Electron
# userData, application identity, and single-instance lock.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
VARIANT="messaging"

usage() {
  cat <<'EOF'
Usage: ./run.sh

This worktree is locked to the messaging runtime identity.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[Mate Agent] Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ -n "${ORKAS_RUNTIME_VARIANT:-}" ] && [ "$ORKAS_RUNTIME_VARIANT" != "messaging" ]; then
  echo "[Mate Agent] This worktree is locked to the messaging runtime; ORKAS_RUNTIME_VARIANT=$ORKAS_RUNTIME_VARIANT is not allowed." >&2
  exit 2
fi
if [ -n "${ORKAS_WORKSPACE_ROOT:-}" ]; then
  echo "[Mate Agent] This worktree manages its own messaging data root; inherited ORKAS_WORKSPACE_ROOT is not allowed." >&2
  exit 2
fi
export ORKAS_RUNTIME_VARIANT="messaging"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[Mate Agent] $APP_DIR/package.json not found; check the project directory layout." >&2
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
[Mate Agent] WSL/WSLg detected.
[Mate Agent] Launching the Windows-native $VARIANT runtime via run.cmd.
EOF
    exec cmd.exe /d /s /c "pushd \"$WIN_APP_DIR\" && run.cmd"
  fi
  cat >&2 <<'EOF'
[Mate Agent] WSL/WSLg detected, but cmd.exe/wslpath is unavailable.
[Mate Agent] On Windows, launch Mate Agent with run.cmd so Windows IME works normally.
EOF
  exit 1
fi

echo "[Mate Agent] Starting source runtime: $VARIANT"
if command -v git >/dev/null 2>&1; then
  export ORKAS_BUILD_COMMIT="${ORKAS_BUILD_COMMIT:-$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)}"
  if [ -z "${ORKAS_BUILD_DIRTY:-}" ]; then
    if [ -n "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ]; then export ORKAS_BUILD_DIRTY=1; else export ORKAS_BUILD_DIRTY=0; fi
  fi
fi
export ORKAS_BUILD_CHANNEL="${ORKAS_BUILD_CHANNEL:-dev}"
export ORKAS_BUILD_TIME="${ORKAS_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
echo "[Mate Agent] Build identity: ${ORKAS_BUILD_CHANNEL} ${ORKAS_BUILD_COMMIT:-unknown} dirty=${ORKAS_BUILD_DIRTY:-unknown}"

node "$APP_DIR/scripts/ensure-deps.cjs"
node "$APP_DIR/scripts/ensure-dev-dependencies.cjs"
node "$APP_DIR/scripts/prepare-source-runtime.cjs" --variant="$VARIANT"

# Build meta-skill engine if present.
KSTAR_ENGINE_DIR="$APP_DIR/packages/nseap-meta-skill-engine"
if [ -d "$KSTAR_ENGINE_DIR" ]; then
  echo "[Mate Agent] Building meta-skill engine..."
  (cd "$KSTAR_ENGINE_DIR" && npm run build) || {
    echo "[Mate Agent] Meta-skill engine build failed; continuing without it." >&2
  }
fi

KSTAR_ENGINE_ENTRY="$KSTAR_ENGINE_DIR/dist/index.js"
if [ -f "$KSTAR_ENGINE_ENTRY" ]; then
  export ORKAS_KSTAR_ENGINE_COMMAND="${ORKAS_KSTAR_ENGINE_COMMAND:-node}"
  if [ -z "${ORKAS_KSTAR_ENGINE_ARGS:-}" ]; then
    export ORKAS_KSTAR_ENGINE_ARGS="[\"$KSTAR_ENGINE_ENTRY\",\"--stdio\"]"
  fi
  export ORKAS_KSTAR_ENGINE_CWD="${ORKAS_KSTAR_ENGINE_CWD:-$KSTAR_ENGINE_DIR}"
  export ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR="${ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR:-$KSTAR_ENGINE_DIR/ontologies}"
  echo "[Mate Agent] KSTAR engine configured: $KSTAR_ENGINE_ENTRY"
else
  echo "[Mate Agent] KSTAR engine not found at $KSTAR_ENGINE_ENTRY; continuing without external KSTAR engine."
fi

cd "$APP_DIR"
if [ "$(uname -s)" = "Darwin" ]; then
  APP_BUNDLE="$APP_DIR/node_modules/electron/dist/Mate Agent [Messaging].app"
  if [ -d "$APP_BUNDLE" ]; then
    ARGS=("$APP_DIR" "--orkas-runtime-variant=$VARIANT")
    if [ -n "${ORKAS_KSTAR_ENGINE_COMMAND:-}" ]; then
      ARGS+=("--orkas-kstar-engine-command=$ORKAS_KSTAR_ENGINE_COMMAND")
      ARGS+=("--orkas-kstar-engine-args=$ORKAS_KSTAR_ENGINE_ARGS")
      ARGS+=("--orkas-kstar-engine-cwd=$ORKAS_KSTAR_ENGINE_CWD")
      ARGS+=("--orkas-kstar-engine-ontology-dir=$ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR")
    fi
    exec open -W -n "$APP_BUNDLE" --args "${ARGS[@]}"
  fi
fi

exec npm run start:electron -- --orkas-runtime-variant="$VARIANT" \
  2> >(grep -v --line-buffered "EGL Driver message" >&2)
