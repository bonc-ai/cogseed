#!/bin/bash
# 强制显示用户旅程的测试脚本

echo "=== 强制显示用户旅程 ==="

# 1. 删除状态文件
echo "1. 删除状态文件..."
rm -f ~/.orkas/data/onboarding-state.json
rm -f ~/.orkas/data/journey-state.json
echo "   状态文件已删除"

# 2. 设置环境变量
echo "2. 设置 ORKAS_ONBOARDING_ALWAYS=1"
export ORKAS_ONBOARDING_ALWAYS=1

# 3. 显示当前环境变量
echo "3. 环境变量确认:"
echo "   ORKAS_ONBOARDING_ALWAYS = $ORKAS_ONBOARDING_ALWAYS"

# 4. 停止现有进程
echo "4. 停止现有的 mate-agent 进程..."
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
pkill -9 -f "$APP_DIR/node_modules/electron/dist" >/dev/null 2>&1 || true
sleep 0.5

# 5. 启动应用
echo "5. 启动 mate-agent..."
cd "$APP_DIR"
exec ./run.sh
