#!/usr/bin/env python3
"""Formal-test orchestrator: freeze → run formal tests → digest set check.

Wires the engine stages into one stateful flow under an orchestrator state
root: PREVALIDATION evidence → frozen copy + freeze manifest → FORMAL_TEST
against the frozen copy → cross-report digest-set check.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from security_core.freezing import freeze_subject  # noqa: E402
from security_core.models import Result, code_for, serialize_report, utc_timestamp  # noqa: E402
from security_core.pipeline import execute_validation  # noqa: E402


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True, default=str))


def cmd_freeze(args: argparse.Namespace) -> int:
    report = _load_json(Path(args.prevalidation_report))
    out = freeze_subject(
        args.skill_root,
        orchestrator_state_root=args.state_root,
        prevalidation_report=report,
        ontology_version=args.ontology_version,
        freeze_id=args.freeze_id,
    )
    _emit(out)
    return int(out.get("exit_code", 40))


def cmd_formal(args: argparse.Namespace) -> int:
    fm = _load_json(Path(args.freeze_manifest))
    frozen_root = fm.get("frozen_skill_path") or args.skill_root
    result = execute_validation(
        frozen_root,
        mode="FORMAL_TEST",
        ontology_version=args.ontology_version or fm.get("ontology_version"),
        freeze_manifest=fm,
        freeze_id=fm.get("freeze_id"),
        subject_digest=fm.get("subject_digest"),
        report_id=args.report_id,
    )
    report = result["report"]
    sys.stdout.write(serialize_report(report))
    sys.stdout.write("\n")
    if args.report_out:
        Path(args.report_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report_out).write_text(
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    return int(result["exit_code"])


def cmd_check_digests(args: argparse.Namespace) -> int:
    reports = [_load_json(Path(p)) for p in args.reports]
    if not reports:
        _emit({"result": Result.REPORT_SET_INCOMPLETE.value, "exit_code": 34})
        return 34

    subjects = [(r.get("subject") or {}) for r in reports]
    digests = {s.get("subject_digest") for s in subjects}
    freeze_ids = {s.get("freeze_id") for s in subjects}
    profiles = {(s.get("digest_profile") or {}).get("ref") for s in subjects}

    if None in digests or len(digests) != 1:
        _emit(
            {
                "result": Result.DIGEST_SET_MISMATCH.value,
                "exit_code": 33,
                "digests": sorted(d for d in digests if d),
                "checked_at": utc_timestamp(),
            }
        )
        return 33
    if None in freeze_ids or len(freeze_ids) != 1:
        _emit(
            {
                "result": Result.DIGEST_SET_MISMATCH.value,
                "exit_code": 33,
                "message": "freeze_id mismatch across reports",
                "freeze_ids": sorted(x for x in freeze_ids if x),
            }
        )
        return 33
    if None in profiles or len(profiles) != 1:
        _emit(
            {
                "result": Result.DIGEST_SET_MISMATCH.value,
                "exit_code": 33,
                "message": "digest_profile.ref mismatch",
            }
        )
        return 33

    _emit(
        {
            "result": Result.CONSISTENT.value,
            "exit_code": 0,
            "subject_digest": next(iter(digests)),
            "freeze_id": next(iter(freeze_ids)),
            "digest_profile_ref": next(iter(profiles)),
            "report_count": len(reports),
            "checked_at": utc_timestamp(),
            "note": "Formal test set consistent — NOT a delivery/deploy authorization (phase-2 Gate required)",
        }
    )
    return 0


def cmd_run_pipeline(args: argparse.Namespace) -> int:
    """prevalidation → (optional) freeze → formal → check (single formal report)."""
    pre = execute_validation(args.skill_root, mode="PREVALIDATION", ontology_version=args.ontology_version)
    pre_path = Path(args.state_root) / "reports" / "prevalidation" / "latest.json"
    pre_path.parent.mkdir(parents=True, exist_ok=True)
    pre_path.write_text(json.dumps(pre["report"], ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    if pre["exit_code"] not in (0, 10):
        print(serialize_report(pre["report"]))
        return pre["exit_code"]

    fr = freeze_subject(
        args.skill_root,
        orchestrator_state_root=args.state_root,
        prevalidation_report=pre["report"],
        ontology_version=args.ontology_version,
    )
    if fr.get("exit_code", 40) != 0:
        _emit(fr)
        return int(fr.get("exit_code", 40))

    fm_path = Path(fr["freeze_manifest_path"])
    formal = execute_validation(
        fr["freeze_manifest"]["frozen_skill_path"],
        mode="FORMAL_TEST",
        ontology_version=args.ontology_version,
        freeze_manifest=fr["freeze_manifest"],
    )
    formal_path = Path(args.state_root) / "reports" / "formal" / "3.2" / "latest.json"
    formal_path.parent.mkdir(parents=True, exist_ok=True)
    formal_path.write_text(json.dumps(formal["report"], ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    if formal["exit_code"] not in (0, 10):
        print(serialize_report(formal["report"]))
        return formal["exit_code"]

    code = cmd_check_digests(argparse.Namespace(reports=[str(formal_path)]))
    _emit(
        {
            "prevalidation_report": str(pre_path),
            "freeze_manifest": str(fm_path),
            "formal_report": str(formal_path),
            "pipeline_exit": code,
        }
    )
    return code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cogseed-security-orchestrator")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_fr = sub.add_parser("freeze")
    p_fr.add_argument("--skill-root", required=True)
    p_fr.add_argument("--state-root", required=True)
    p_fr.add_argument("--prevalidation-report", required=True)
    p_fr.add_argument("--ontology-version", default="1.1.1")
    p_fr.add_argument("--freeze-id", default=None)

    p_fo = sub.add_parser("formal-test")
    p_fo.add_argument("--skill-root", default=None)
    p_fo.add_argument("--freeze-manifest", required=True)
    p_fo.add_argument("--ontology-version", default=None)
    p_fo.add_argument("--report-out", default=None)
    p_fo.add_argument("--report-id", default=None)

    p_ck = sub.add_parser("check-digests")
    p_ck.add_argument("--reports", nargs="+", required=True)

    p_pl = sub.add_parser("run-pipeline")
    p_pl.add_argument("--skill-root", required=True)
    p_pl.add_argument("--state-root", required=True)
    p_pl.add_argument("--ontology-version", default="1.1.1")

    args = parser.parse_args(argv)
    handlers = {
        "freeze": cmd_freeze,
        "formal-test": cmd_formal,
        "check-digests": cmd_check_digests,
        "run-pipeline": cmd_run_pipeline,
    }
    handler = handlers.get(args.cmd)
    return handler(args) if handler else 40


if __name__ == "__main__":
    raise SystemExit(main())
