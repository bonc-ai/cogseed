#!/bin/bash
# 强制显示引导页的启动脚本

export COGSEED_ONBOARDING_ALWAYS=1
cd "$(dirname "$0")"
./run.sh
