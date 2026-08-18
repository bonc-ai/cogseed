#!/usr/bin/env bash
# =============================================================
# clean-cogseed.sh — CogSeed 桌面端「一键还原全新状态」
#
# 清除：应用数据 / 缓存 / 日志 / 偏好 / 开发运行时 / 登录会话
# （Hub token 密文存在应用状态文件里，随数据目录一并清除，无需动钥匙串）
#
# 用法：
#   ./clean-cogseed.sh                        # 预览模式：只列出将删除的内容，不执行
#   ./clean-cogseed.sh --yes                  # 执行清理（先退出正在运行的实例）
#   ./clean-cogseed.sh --yes --include-app    # 连同 /Applications 下安装一并卸载
# =============================================================
set -euo pipefail

YES=0
INCLUDE_APP=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --include-app) INCLUDE_APP=1 ;;
    *) echo "未知参数: $arg"; echo "用法: $0 [--yes] [--include-app]"; exit 2 ;;
  esac
done
shopt -s nullglob

TARGET_DIRS=(
  "$HOME/Library/Application Support/CogSeed"
  "$HOME/Library/Application Support/cogseed"
  "$HOME/Library/Logs/CogSeed"
  "$HOME/Library/Logs/cogseed"
  "$HOME/Library/Caches/CogSeed"
  "$HOME/Library/Caches/cogseed"
  "$HOME/.cogseed"
  # 旧版 Orkas 遗留目录：不清的话，启动时的自动迁移会把旧状态
  # （含"引导已完成"标记）重新搬回 ~/.cogseed，导致无法回到全新状态
  "$HOME/.orkas"
  "$HOME/.cogseed-dev"
  "$HOME/.cache/orkas-runtime"
  "$HOME/Library/Application Support/Orkas"
  "$HOME/Library/Logs/orkas"
  "$HOME/Library/Caches/Orkas"
)
TARGET_GLOBS=(
  "$HOME/Library/Preferences/com.cogseed."*
  "$HOME/Library/Saved Application State/com.cogseed."*
  "$HOME/Library/Containers/com.cogseed."*
  "$HOME/Library/WebKit/com.cogseed."*
  "$HOME/Library/HTTPStorages/com.cogseed."*
  "$HOME/Library/Preferences/com.orkas."*
  "$HOME/Library/Saved Application State/com.orkas."*
  "$HOME/Library/Containers/com.orkas."*
  "$HOME/Library/WebKit/com.orkas."*
  "$HOME/Library/HTTPStorages/com.orkas."*
)
INSTALLED_APPS=(
  "/Applications/CogSeed.app"
  "/Applications/CogSeed Dev.app"
)

quit_running() {
  echo "==> 退出正在运行的 CogSeed 实例…"
  osascript -e 'tell application "CogSeed" to quit' 2>/dev/null || true
  osascript -e 'tell application "CogSeed Dev" to quit' 2>/dev/null || true
  sleep 2
  # 兜底：按可执行文件路径精确匹配，不会误伤本脚本或无关进程
  pkill -f "CogSeed.app/Contents/MacOS/Electron" 2>/dev/null || true
  pkill -f "node_modules/electron/dist/CogSeed.app/Contents/MacOS/Electron" 2>/dev/null || true
  pkill -f "orkas-runtime-variant=cogseed" 2>/dev/null || true
  sleep 1
}

handle_path() {
  local p="$1"
  if [ -e "$p" ] || [ -L "$p" ]; then
    if [ "$YES" = "1" ]; then
      rm -rf -- "$p"
      echo "已删除: $p"
    else
      local size=""
      size="$(du -sh "$p" 2>/dev/null | cut -f1)"
      echo "将删除: $p ${size:+($size)}"
    fi
  fi
}

main() {
  if [ "$YES" = "1" ]; then
    echo "==> 执行模式：清理开始"
    quit_running
  else
    echo "==> 预览模式（未删除任何内容）。确认后运行: $0 --yes"
    echo
  fi

  for p in "${TARGET_DIRS[@]}"; do handle_path "$p"; done
  for g in "${TARGET_GLOBS[@]}"; do
    for p in $g; do handle_path "$p"; done
  done

  if [ "$INCLUDE_APP" = "1" ]; then
    echo "==> 卸载已安装的 App"
    for p in "${INSTALLED_APPS[@]}"; do handle_path "$p"; done
  else
    echo "（未包含 /Applications 下的安装；需要一并卸载请加 --include-app）"
  fi

  echo
  if [ "$YES" = "1" ]; then
    echo "==> 清理完成。重新进入 CogSeed："
    echo "    开发模式：在仓库目录运行 ./run.sh（数据目录会自动重建）"
    echo "    打包版：从 DMG 重新拖入 /Applications 后打开"
  else
    echo "==> 预览结束。以上路径会被删除，操作不可逆，请确认清单无误。"
  fi
}

main "$@"
