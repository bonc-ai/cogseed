#!/usr/bin/env python3
"""Minimal conformance runner for phase-1 smoke vectors."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from security_core.digest import compute_subject_digest
from security_core.result_models import RESULT_EXIT_CODE
from security_core.paths import load_ontology_artifact


def test_exit_codes() -> None:
    vectors = json.loads((ROOT / "tests/conformance/1.1.1/exit-code-vectors.json").read_text(encoding="utf-8"))
    for v in vectors:
        assert RESULT_EXIT_CODE[v["result"]] == v["exit_code"], v


def test_digest_stable() -> None:
    fixture = ROOT / "fixtures/sample-skill"
    a = compute_subject_digest(fixture)
    b = compute_subject_digest(fixture)
    assert a["ok"] and b["ok"]
    assert a["subject_digest"] == b["subject_digest"]
    profile = load_ontology_artifact("1.1.1", "digest-profile.yaml")
    assert profile["ref"] == "cogseed.skill.fileset@1.0.0"


def main() -> int:
    test_exit_codes()
    test_digest_stable()
    print("conformance smoke OK (risk derivation tests skipped — disabled)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
