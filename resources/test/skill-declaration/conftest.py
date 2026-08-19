"""Test-path setup for the skill-declaration suites.

Makes the engine package importable for the white-box conformance suite while
keeping the bytecode-free invariant (pytest runs with -B via the npm runner).
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENGINE = REPO / "resources" / "guardrail" / "skill-declaration-core"

for entry in (ENGINE / "vendor", ENGINE):
    s = str(entry)
    if s not in sys.path:
        sys.path.insert(0, s)
