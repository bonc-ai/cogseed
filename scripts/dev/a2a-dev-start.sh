#!/usr/bin/env bash
# Owned source clients only. The coordinator owns source sync and normal login.
# Requires an already-running local Hub; this script never creates accounts.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/../.." && pwd)"
PEER="${A2A_PEER_DIR:-$HOME/Documents/CogSeed-2}"
PEER="$(cd "$PEER" && pwd)"
ACTION="${1:-restart}"
case "$ACTION" in
  start|restart|stop) ;;
  *) echo "Usage: $0 [start|restart|stop]" >&2; exit 2 ;;
esac
[ "$HERE" != "$PEER" ] || { echo 'Peer must be a separate checkout' >&2; exit 2; }

export COGSEED_HUB_API_BASE="${COGSEED_HUB_API_BASE:-http://127.0.0.1:4312}"
export COGSEED_BUILD_CHANNEL=dev
# Each owning launcher receives its package lock, never the caller's identity.
unset COGSEED_RUNTIME_VARIANT COGSEED_SOURCE_RUNTIME_VARIANT
export COGSEED_DEV_DEBUG_ADDRESS=127.0.0.1

# Validate BOTH checkouts and port sets before stopping either client.
for owner in "$HERE" "$PEER"; do
  if [ "$owner" = "$HERE" ]; then cdp=9223; inspector=9233; expected=cogseed;
  else cdp=9224; inspector=9234; expected=messaging; fi
  config="$(COGSEED_DEV_CDP_PORT="$cdp" COGSEED_DEV_INSPECT_PORT="$inspector" node "$owner/scripts/lib/source-launch.cjs" "$owner")"
  [ "${config%%$'\n'*}" = "$expected" ] || { echo "Unexpected source variant in $owner (expected $expected)" >&2; exit 2; }
done

COGSEED_DEV_CDP_PORT=9223 COGSEED_DEV_INSPECT_PORT=9233 bash "$HERE/scripts/restart-cogseed.sh" "$ACTION"
COGSEED_DEV_CDP_PORT=9224 COGSEED_DEV_INSPECT_PORT=9234 bash "$PEER/scripts/restart-cogseed.sh" "$ACTION"
echo "Owned clients: cogseed CDP 9223 / inspector 9233; messaging CDP 9224 / inspector 9234"
