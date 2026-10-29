#!/bin/bash
# Shared by run/restart: validate before dependency preparation or process stops.
if [ -n "${NODE_OPTIONS:-}" ]; then
  echo '[CogSeed] inherited NODE_OPTIONS is not allowed in the source launcher' >&2
  exit 2
fi
LAUNCH_CONFIG="$(node "$APP_DIR/scripts/lib/source-launch.cjs" "$APP_DIR")" || exit 2
LAUNCH_FIELDS=()
while IFS= read -r field; do
  LAUNCH_FIELDS+=("$field")
done <<< "$LAUNCH_CONFIG"
VARIANT="${LAUNCH_FIELDS[0]}"
APP_NAME="${LAUNCH_FIELDS[1]}"
RUN_LOG="${LAUNCH_FIELDS[2]}"
APP_BUNDLE="$APP_DIR/node_modules/electron/dist/$APP_NAME.app"
DEBUG_ARGS=()
for ((i=3; i<${#LAUNCH_FIELDS[@]}; i++)); do
  DEBUG_ARGS+=("${LAUNCH_FIELDS[$i]}")
done
# Bootstrap selects the package-locked variant from argv; identity.json's
# production environment normalizer must never receive a source variant.
unset COGSEED_RUNTIME_VARIANT COGSEED_SOURCE_RUNTIME_VARIANT
