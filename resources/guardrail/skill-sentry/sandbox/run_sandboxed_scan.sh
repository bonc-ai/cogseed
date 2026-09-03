#!/usr/bin/env bash
# ============================================================
# run_sandboxed_scan.sh — 在隔离沙箱中扫描一个不可信 Skill
# ------------------------------------------------------------
# 隔离措施（对应“扫描对象本身可能是恶意的”这一威胁模型）：
#   --network none        全程断网（消灭数据外传/SSRF/认知资产外传通道）
#   -v <skill>:/target:ro 被测 Skill 只读挂载，扫描器无写权限
#   --read-only           容器根文件系统只读
#   --tmpfs /tmp          临时目录用内存 tmpfs，容器销毁即消失
#   --user 10001          非 root
#   --cap-drop ALL        丢弃所有 Linux capabilities
#   --security-opt no-new-privileges  禁止提权
#   --pids-limit          防 fork 炸弹
#   --memory / --cpus     资源限额，防资源耗尽/zip 炸弹
#   --rm                  用完即焚，不复用容器
# ============================================================
set -Eeuo pipefail

IMAGE="${SCANNER_IMAGE:-skill-security-scanner:local}"
FAIL_ON="${FAIL_ON:-DO_NOT_INSTALL}"
MEM_LIMIT="${MEM_LIMIT:-1g}"
CPU_LIMIT="${CPU_LIMIT:-1.0}"
PIDS_LIMIT="${PIDS_LIMIT:-256}"
TIMEOUT_SECS="${TIMEOUT_SECS:-180}"

usage() {
  cat <<EOF
用法: bash run_sandboxed_scan.sh <被测skill目录> <报告输出目录>

环境变量（可选）:
  SCANNER_IMAGE   镜像名（默认 skill-security-scanner:local）
  FAIL_ON         达到该等级返回非0（DO_NOT_INSTALL|CAUTION|ALLOW|never）
  MEM_LIMIT       内存上限（默认 1g）
  CPU_LIMIT       CPU 上限（默认 1.0）
  PIDS_LIMIT      进程数上限（默认 256）
  TIMEOUT_SECS    扫描超时秒数（默认 180）
EOF
  exit 2
}

[ $# -lt 2 ] && usage
SKILL_DIR="$(cd "$1" && pwd)"
REPORT_DIR="$(mkdir -p "$2" && cd "$2" && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] 未安装 docker，无法进行沙箱隔离扫描" >&2
  exit 3
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[ERROR] 镜像 $IMAGE 不存在，请先构建: bash build.sh" >&2
  exit 4
fi

echo "[INFO] 沙箱扫描: $SKILL_DIR"
echo "[INFO] 报告输出: $REPORT_DIR/report.json"

# timeout 命令在 macOS 默认不存在（GNU coreutils）。有则用，无则回退到 docker --stop-timeout。
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
fi

set +e
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" "${TIMEOUT_SECS}s" docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    --user 10001:10001 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit "$PIDS_LIMIT" \
    --memory "$MEM_LIMIT" \
    --cpus "$CPU_LIMIT" \
    -v "$SKILL_DIR:/target:ro" \
    -v "$REPORT_DIR:/reports:rw" \
    "$IMAGE" \
    --artifact /target --output /reports/report.json --fail-on "$FAIL_ON"
  code=$?
else
  # 无 timeout：用 docker --stop-timeout 兜底（不是硬超时，但仍限制 stop 阶段）
  echo "[INFO] 未找到 timeout/gtimeout，改用容器内超时兜底（建议安装 coreutils 获得硬超时）"
  docker run --rm \
    --stop-timeout "$TIMEOUT_SECS" \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    --user 10001:10001 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit "$PIDS_LIMIT" \
    --memory "$MEM_LIMIT" \
    --cpus "$CPU_LIMIT" \
    -v "$SKILL_DIR:/target:ro" \
    -v "$REPORT_DIR:/reports:rw" \
    "$IMAGE" \
    --artifact /target --output /reports/report.json --fail-on "$FAIL_ON"
  code=$?
fi
set -e

if [ "$code" -eq 124 ]; then
  echo "[WARN] 扫描超时（${TIMEOUT_SECS}s），可能是超大制品或 zip 炸弹" >&2
fi
echo "[DONE] 退出码: $code"
exit "$code"
