#!/bin/bash
# Legacy compatibility alias for one CogSeed release cycle.
# New development and normal source launch must use scripts/restart-cogseed.sh.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "[restart-mate] deprecated alias; forwarding to restart-cogseed.sh" >&2
exec "$APP_DIR/scripts/restart-cogseed.sh" "$@"
