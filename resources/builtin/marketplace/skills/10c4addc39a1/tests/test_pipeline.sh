#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/outputs/test-run}"
rm -rf "$OUT"
mkdir -p "$OUT"

python "$ROOT/scripts/check_skill.py" "$ROOT"
python "$ROOT/scripts/run_skill.py" \
  --input "$ROOT/fixtures/sample-report-data.json" \
  --research-dir "$ROOT/fixtures/research" \
  --output-dir "$OUT" \
  --strict --render

# A reviewer must inspect every rendered page before recording passed.
echo "Automated pipeline passed. Inspect every $OUT/render/page-*.png at 100% zoom, then run:"
echo "python $ROOT/scripts/record_visual_qa.py --render-dir $OUT/render --reviewer '<reviewer>' --status passed"
