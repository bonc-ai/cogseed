#!/bin/bash
# 测试用户旅程显示的脚本

echo "=== Onboarding Test Script ==="
echo "1. Setting COGSEED_ONBOARDING_ALWAYS=1"
export COGSEED_ONBOARDING_ALWAYS=1

echo "2. Checking onboarding-state.json"
if [ -f ~/.cogseed/data/onboarding-state.json ]; then
  echo "   File exists:"
  cat ~/.cogseed/data/onboarding-state.json
else
  echo "   File does NOT exist (good for first run)"
fi

echo "3. Launching Electron with environment variable..."
cd "$(dirname "$0")"
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
