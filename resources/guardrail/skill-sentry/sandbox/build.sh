#!/usr/bin/env bash
# 构建 Skill Security Scanner 沙箱镜像
# 构建上下文是项目根（wjy-skill），以便 COPY 01_scanner / 02_rules
set -Eeuo pipefail

IMAGE="${SCANNER_IMAGE:-skill-security-scanner:local}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[INFO] 构建镜像 $IMAGE （上下文: $ROOT）"
docker build -t "$IMAGE" -f "$ROOT/06_sandbox/Dockerfile" "$ROOT"
echo "[DONE] 镜像已构建: $IMAGE"
echo "接下来可运行: bash 06_sandbox/run_sandboxed_scan.sh <skill目录> <报告目录>"
