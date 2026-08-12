#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="${1:-$ROOT/outputs/research-gate-failure-tests}"
rm -rf "$TMP"
mkdir -p "$TMP"

run_expected_failure() {
  local name="$1"
  local dir="$ROOT/fixtures/research-failures/$name"
  local out="$TMP/$name"
  mkdir -p "$out"
  set +e
  python "$ROOT/scripts/validate_research_bundle.py" \
    --plan "$dir/research-plan.json" \
    --ledger "$dir/web-research-ledger.json" \
    --report-data "$ROOT/fixtures/sample-report-data.json" \
    --gate-out "$out/research-gate.json" \
    --out "$out/research-validation-report.json" \
    --strict
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo "Expected failure but gate passed: $name" >&2
    exit 1
  fi
  python - "$out/research-gate.json" <<'PY'
import json,sys
p=sys.argv[1]
d=json.load(open(p,encoding='utf-8'))
assert d['gate_status']=='failed', d
assert d['blockers'], d
print('expected failure:', p, len(d['blockers']))
PY
}

run_expected_failure missing-primary-source
run_expected_failure unresolved-policy-date-conflict
run_expected_failure standard-version-mismatch

echo "All negative research-gate regressions failed as expected."
