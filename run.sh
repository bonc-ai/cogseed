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

if [ -n "${COGSEED_RUNTIME_VARIANT:-}" ] && [ "$COGSEED_RUNTIME_VARIANT" != "cogseed" ]; then
  echo "[CogSeed] This worktree is locked to the cogseed runtime; COGSEED_RUNTIME_VARIANT=$COGSEED_RUNTIME_VARIANT is not allowed." >&2
  exit 2
fi
if [ -n "${COGSEED_WORKSPACE_ROOT:-}" ]; then
  echo "[CogSeed] This worktree manages its own cogseed data root; inherited COGSEED_WORKSPACE_ROOT is not allowed." >&2
  exit 2
fi
# Do not inherit gateway-only Anthropic credentials into the app model layer.
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_DEFAULT_MODEL

export COGSEED_RUNTIME_VARIANT="cogseed"

# Hub 联调默认值：默认连接测试 Hub 账号服务（https://cogseed-open.bonc.com.cn）。
# 3000 端口已对公网关闭，请勿再直连 http://101.36.66.129:3000。
# 需要连本地服务时，显式导出同名变量即可覆盖：
#   COGSEED_HUB_API_BASE=http://localhost:3000 ./run.sh
export COGSEED_HUB_API_BASE="${COGSEED_HUB_API_BASE:-https://cogseed-open.bonc.com.cn}"

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
  export COGSEED_BUILD_COMMIT="${COGSEED_BUILD_COMMIT:-$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)}"
  if [ -z "${COGSEED_BUILD_DIRTY:-}" ]; then
    if [ -n "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ]; then export COGSEED_BUILD_DIRTY=1; else export COGSEED_BUILD_DIRTY=0; fi
  fi
fi
export COGSEED_BUILD_CHANNEL="${COGSEED_BUILD_CHANNEL:-dev}"
export COGSEED_BUILD_TIME="${COGSEED_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
echo "[CogSeed] Build identity: ${COGSEED_BUILD_CHANNEL} ${COGSEED_BUILD_COMMIT:-unknown} dirty=${COGSEED_BUILD_DIRTY:-unknown}"

node "$APP_DIR/scripts/ensure-deps.cjs"
node "$APP_DIR/scripts/ensure-dev-dependencies.cjs"
node "$APP_DIR/scripts/prepare-source-runtime.cjs" --variant="$VARIANT"

cd "$APP_DIR"
if [ "$(uname -s)" = "Darwin" ]; then
  APP_BUNDLE="$APP_DIR/node_modules/electron/dist/CogSeed.app"
  if [ -d "$APP_BUNDLE" ]; then
    ARGS=("$APP_DIR" "--cogseed-runtime-variant=$VARIANT")
    OPEN_ENV_ARGS=()
    if [ -n "${COGSEED_HUB_API_BASE:-}" ]; then
      OPEN_ENV_ARGS+=(--env "COGSEED_HUB_API_BASE=$COGSEED_HUB_API_BASE")
    fi
    if [ -n "${COGSEED_HUB_API_BASE:-}" ]; then
      OPEN_ENV_ARGS+=(--env "COGSEED_HUB_API_BASE=$COGSEED_HUB_API_BASE")
    fi
    # Hub 账号发布 Gate 显式开关（gate.ts 的 env override）。
    # 发布 Gate 已默认打开；如需强制关闭可设 COGSEED_HUB_ENABLED=false。
    if [ -n "${COGSEED_HUB_ENABLED:-}" ]; then
      OPEN_ENV_ARGS+=(--env "COGSEED_HUB_ENABLED=$COGSEED_HUB_ENABLED")
    fi
    if [ -n "${COGSEED_KSTAR_ENGINE_COMMAND:-}" ] && [ -n "${COGSEED_KSTAR_ENGINE_ARGS:-}" ]; then
      ARGS+=("--cogseed-kstar-engine-command=$COGSEED_KSTAR_ENGINE_COMMAND")
      ARGS+=("--cogseed-kstar-engine-args=$COGSEED_KSTAR_ENGINE_ARGS")
      ARGS+=("--cogseed-kstar-engine-cwd=$COGSEED_KSTAR_ENGINE_CWD")
      ARGS+=("--cogseed-kstar-engine-ontology-dir=$COGSEED_KSTAR_ENGINE_ONTOLOGY_DIR")
    fi
    # macOS ships bash 3.2, where expanding an EMPTY array as
    # "${OPEN_ENV_ARGS[@]}" under `set -u` fails with "unbound variable".
    # Guard the empty case so the launcher works without hub env vars.
    if (( ${#OPEN_ENV_ARGS[@]} > 0 )); then
      exec open -W -n "${OPEN_ENV_ARGS[@]}" "$APP_BUNDLE" --args "${ARGS[@]}"
    else
      exec open -W -n "$APP_BUNDLE" --args "${ARGS[@]}"
    fi
  fi
fi

exec npm run start:electron -- --cogseed-runtime-variant="$VARIANT" \
  2> >(grep -v --line-buffered "EGL Driver message" >&2)
