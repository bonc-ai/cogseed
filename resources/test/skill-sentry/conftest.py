"""
Repo-local pytest shim for the vendored skill-sentry tests.

The upstream suite was written to run from the skill-sentry project root; here
the engine lives at `resources/guardrail/skill-sentry` (outside `resources/test`
so it ships as-is). This conftest puts the ENGINE root on sys.path so
`engine.scanner_core` / `runtime_trust` imports resolve against the vendored
bytes — the whole point: the same tree that ships is the one under test.

The upstream `tests/conftest.py` (which resolves its own parent) is also
copied verbatim; it inserts a harmless path and is left untouched so future
syncs stay byte-identical.
"""
import sys
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[3] / 'resources' / 'guardrail' / 'skill-sentry'
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))
# `tests/unit/test_fail_closed.py` imports `agent_gate` bare; upstream ran it
# with the sandbox dir importable. Same shim, documented in SYNC.md.
SANDBOX_DIR = ENGINE_ROOT / 'sandbox'
if str(SANDBOX_DIR) not in sys.path:
    sys.path.insert(0, str(SANDBOX_DIR))

# Fixture samples ship their own internal tests (e.g.
# `fixtures/context-samples/sample-defensive-skill/test/`) that import from the
# sample's own `scripts/` package relative to that sample's directory. They
# verify the SAMPLE, not the engine, and need the sample dir on sys.path —
# which pytest's plain collection here does not provide. The engine regression
# coverage is `tests/unit` + `runtime_trust_tests`; fixture-sample self-tests
# are out of scope for the repo run.
collect_ignore = ['tests/fixtures']

