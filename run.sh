#!/bin/bash
# Mate Agent PC launcher. Lives under PC/; the script's own directory is the PC root.
# Behavior: kills any prior instance, then starts a new one in the foreground.
#
# Usage:
#   ./run.sh
#
# Mate Agent source builds use exactly one server environment: global prod.
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[Mate Agent] $APP_DIR/package.json not found; check the PC/ directory layout." >&2
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
[Mate Agent] Launching the Windows-native Mate Agent via run.cmd so Windows IME works normally.
EOF
    exec cmd.exe /d /s /c "pushd \"$WIN_APP_DIR\" && run.cmd"
  fi
  cat >&2 <<'EOF'
[Mate Agent] WSL/WSLg detected, but cmd.exe/wslpath is unavailable.
[Mate Agent] On Windows, launch Mate Agent with run.cmd so Windows IME works normally.
EOF
  exit 1
fi

echo "[Mate Agent] Starting Mate Agent (global prod)"

node "$APP_DIR/scripts/ensure-deps.cjs"
node "$APP_DIR/scripts/ensure-dev-dependencies.cjs"
# macOS source runs need the same connector callback declaration that electron-builder adds to
# packaged apps. This never starts a local server; it only registers the `mateagent://` primary protocol and `orkas://` OAuth compatibility protocol.
node "$APP_DIR/scripts/prepare-source-protocol.cjs" || true

KSTAR_ENGINE_DIR="$APP_DIR/userWorkSpace/meta-skill-engine-package"
KSTAR_ENGINE_ENTRY="$KSTAR_ENGINE_DIR/dist/index.js"
if [ -f "$KSTAR_ENGINE_ENTRY" ]; then
  export ORKAS_KSTAR_ENGINE_COMMAND="${ORKAS_KSTAR_ENGINE_COMMAND:-node}"
  if [ -z "${ORKAS_KSTAR_ENGINE_ARGS:-}" ]; then
    export ORKAS_KSTAR_ENGINE_ARGS="[\"$KSTAR_ENGINE_ENTRY\"]"
  fi
  export ORKAS_KSTAR_ENGINE_CWD="${ORKAS_KSTAR_ENGINE_CWD:-$KSTAR_ENGINE_DIR}"
  export ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR="${ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR:-$KSTAR_ENGINE_DIR/ontologies}"
  echo "[Mate Agent] KSTAR engine configured: $KSTAR_ENGINE_ENTRY"
else
  echo "[Mate Agent] KSTAR engine not found at $KSTAR_ENGINE_ENTRY; continuing without external KSTAR engine."
fi

cd "$APP_DIR"
pkill -9 -f "$APP_DIR/node_modules/electron/dist" >/dev/null 2>&1 || true
sleep 0.3

if [ "$(uname -s)" = "Darwin" ]; then
  APP_BUNDLE="$APP_DIR/node_modules/electron/dist/Mate Agent.app"
  if [ -d "$APP_BUNDLE" ]; then
    ARGS=("$APP_DIR")
    if [ -n "${ORKAS_KSTAR_ENGINE_COMMAND:-}" ]; then
      ARGS+=("--orkas-kstar-engine-command=$ORKAS_KSTAR_ENGINE_COMMAND")
      ARGS+=("--orkas-kstar-engine-args=$ORKAS_KSTAR_ENGINE_ARGS")
      ARGS+=("--orkas-kstar-engine-cwd=$ORKAS_KSTAR_ENGINE_CWD")
      ARGS+=("--orkas-kstar-engine-ontology-dir=$ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR")
    fi
    # Launch through LaunchServices so the patched app name/icon are used in source runs.
    exec open -W -n "$APP_BUNDLE" --args "${ARGS[@]}"
  fi
fi

# Chromium's GPU process can repeatedly print
# `EGL Driver message (Error) eglQueryDeviceAttribEXT: Bad attribute` on macOS.
# This is ANGLE fallback noise when probing driver attributes and has no
# functional impact. Filter only that stderr line; pass through everything else.
# If `unbuffer` is unavailable, default line buffering is fine (macOS bash built-in).
exec npm run start:electron 2> >(grep -v --line-buffered "EGL Driver message" >&2)
