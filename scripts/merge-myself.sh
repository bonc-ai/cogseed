#!/bin/bash
# merge-myself.sh — 把个人开发分支 Myself 合入 dev/niubaokang 的固定流程。
#
# 背景：Myself worktree 锁定了独立运行身份（runtime variant = myself），
# 分支上带有 7 个环境锁定文件（run.sh / package.json / identity.json /
# brand.ts / install-data-root.cjs / prepare-source-runtime.cjs /
# restart-cogseed.sh）。这些改动是 Myself 实例的运行配置，绝不能被
# merge 进 dev/niubaokang（否则主 checkout 会被锁成 Myself 身份）。
# 本脚本自动执行合入并把这些环境文件还原为主线版本，防止误合。
#
# 用法：
#   scripts/merge-myself.sh            # 完整合入流程（默认）
#   scripts/merge-myself.sh --check    # 只检查，不合并（合入前预览）
#
# 前置：必须在主 checkout（cogseed-agent/，分支 dev/niubaokang）执行。
set -euo pipefail

# 自动定位到本仓库根（脚本可能在任意目录被调用）
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

BRANCH="Myself"
MODE="merge"
if [ "${1:-}" = "--check" ]; then MODE="check"; fi

# ── Myself 分支锁定的环境文件（合入时必须还原为主线版本）──────────────
ENV_FILES=(
  run.sh
  package.json
  src/resources/identity.json
  src/main/brand.ts
  src/main/install-data-root.cjs
  scripts/prepare-source-runtime.cjs
  scripts/restart-cogseed.sh
)

fail() { echo "[merge-myself] ERROR: $*" >&2; exit 1; }

# ── 1. 前置校验 ──────────────────────────────────────────────────────────
CURRENT="$(git branch --show-current)"
[ "${CURRENT}" = "dev/niubaokang" ] || fail "必须在主 checkout 的 dev/niubaokang 分支执行（当前: ${CURRENT}）"
git rev-parse --verify "refs/heads/$BRANCH" >/dev/null 2>&1 || fail "本地分支 $BRANCH 不存在"

# 主 checkout 工作树必须干净（有其他并行改动时停下，不干预）
# 排除脚本自身（未提交时以未跟踪文件出现，不视为"其他改动"）
DIRTY="$(git status --porcelain -- ':(exclude)scripts/merge-myself.sh')"
if [ -n "$DIRTY" ]; then
  fail "主 checkout 工作树不干净，请先处理（不干预并行会话的改动）:\n$DIRTY"
fi

# ── 2. 同步远端基线 ──────────────────────────────────────────────────────
echo "[merge-myself] fetch origin ..."
git fetch --prune origin || fail "fetch origin 失败"

# ── 3. 合入预览 ──────────────────────────────────────────────────────────
echo ""
echo "[merge-myself] ===== ${BRANCH} 待合入提交（dev/niubaokang..${BRANCH}）====="
git log --oneline "dev/niubaokang..$BRANCH" || true
echo "[merge-myself] ===== $BRANCH 落后主线的提交（$BRANCH..dev/niubaokang，共 $(git rev-list --count "$BRANCH..dev/niubaokang") 个）====="
git log --oneline "$BRANCH..dev/niubaokang" | head -10 || true
echo ""
echo "[merge-myself] 提示：若 $BRANCH 落后主线较多，建议先在 Myself worktree 里执行"
echo "              git merge dev/niubaokang 同步，再回来合入（减少功能文件冲突）。"

if [ "$MODE" = "check" ]; then
  echo ""
  echo "[merge-myself] --check 完成：以上为合入预览，未做任何改动。"
  exit 0
fi

# ── 4. 执行合并（不自动提交，便于排除环境文件）─────────────────────────
echo ""
echo "[merge-myself] merging $BRANCH (no-commit) ..."
git merge --no-commit "$BRANCH" || true

# 功能文件冲突：停下由用户解决（不自动处理）
UNRESOLVED="$(git diff --name-only --diff-filter=U)"
if [ -n "$UNRESOLVED" ]; then
  echo "[merge-myself] 功能文件存在冲突，请先解决后再继续:"
  echo "$UNRESOLVED"
  echo "[merge-myself] 解决后执行: git add <文件> && git commit"
  exit 1
fi

# ── 5. 还原环境锁定文件为主线版本 ────────────────────────────────────────
echo "[merge-myself] 还原环境锁定文件为主线版本（$BRANCH 的运行身份配置不入主线）:"
for f in "${ENV_FILES[@]}"; do
  if git diff --quiet HEAD -- "$f"; then
    echo "  - $f （无差异，跳过）"
  else
    git checkout HEAD -- "$f"
    echo "  - $f （已还原）"
  fi
done

# ── 6. 校验：环境文件必须与主线一致、无冲突标记 ─────────────────────────
echo ""
echo "[merge-myself] 校验 ..."
for f in "${ENV_FILES[@]}"; do
  git diff --quiet HEAD -- "$f" || fail "环境文件 $f 与主线仍有差异，合入中止"
done
if grep -rln '^<<<<<<<\|^>>>>>>>\|^=======$' run.sh src scripts 2>/dev/null | head -3 | grep -q .; then
  fail "存在残留冲突标记，合入中止"
fi
echo "[merge-myself] 环境文件与主线一致 ✓  无冲突标记 ✓"

# ── 7. 提示验证并提交 ────────────────────────────────────────────────────
echo ""
echo "[merge-myself] 建议先验证再提交:"
echo "  npm run typecheck"
echo "  npm test（或针对性测试）"
echo ""
echo "[merge-myself] 确认无误后执行:"
echo "  git add -A && git commit"
echo "  git push origin dev/niubaokang"
echo ""
echo "[merge-myself] 完成（未自动提交，交由你验证后提交推送）"
