#!/usr/bin/env python3
"""3.2 Validator CLI — PREVALIDATION / FORMAL_TEST.

stdout carries exactly one line of JSON (the report); the exit code is the
numeric contract from ``exit-code-registry.yaml``. This surface is parsed by
the platform adapter and must not change.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from security_core.models import serialize_report  # noqa: E402
from security_core.pipeline import execute_validation  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cogseed-security-validator")
    parser.add_argument("--skill-root", required=True)
    parser.add_argument("--mode", required=True, choices=["PREVALIDATION", "FORMAL_TEST"])
    parser.add_argument("--ontology-version", default=None)
    parser.add_argument("--freeze-manifest", default=None, help="Path to freeze-manifest.json")
    parser.add_argument("--freeze-id", default=None)
    parser.add_argument("--subject-digest", default=None)
    parser.add_argument("--report-out", default=None, help="Optional write path (orchestrator-controlled)")
    parser.add_argument("--report-id", default=None)
    parser.add_argument("--storage", default="VALIDATOR_CONTROLLED")
    args = parser.parse_args(argv)

    freeze_manifest = None
    if args.freeze_manifest:
        freeze_manifest = json.loads(Path(args.freeze_manifest).read_text(encoding="utf-8"))

    result = execute_validation(
        args.skill_root,
        mode=args.mode,
        ontology_version=args.ontology_version,
        freeze_id=args.freeze_id,
        freeze_manifest=freeze_manifest,
        subject_digest=args.subject_digest,
        report_id=args.report_id,
        storage=args.storage,
    )
    report = result["report"]
    sys.stdout.write(serialize_report(report))
    sys.stdout.write("\n")
    if args.report_out:
        out = Path(args.report_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return int(result["exit_code"])


if __name__ == "__main__":
    raise SystemExit(main())
