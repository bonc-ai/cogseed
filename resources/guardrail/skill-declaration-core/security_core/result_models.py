"""Result models, findings, exit-code mapping, report serialization."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class Severity(str, Enum):
    INFO = "INFO"
    WARN = "WARN"
    FAIL = "FAIL"
    BLOCK = "BLOCK"


class Result(str, Enum):
    PASS = "PASS"
    PASS_WITH_WARNINGS = "PASS_WITH_WARNINGS"
    NEEDS_INPUT = "NEEDS_INPUT"
    FAIL = "FAIL"
    BLOCK = "BLOCK"
    NOT_READY = "NOT_READY"
    SUBJECT_MUTATED = "SUBJECT_MUTATED"
    DIGEST_MISMATCH = "DIGEST_MISMATCH"
    VERSION_UNSUPPORTED = "VERSION_UNSUPPORTED"
    EXECUTION_ERROR = "EXECUTION_ERROR"
    FROZEN = "FROZEN"
    CONSISTENT = "CONSISTENT"
    DIGEST_SET_MISMATCH = "DIGEST_SET_MISMATCH"
    REPORT_SET_INCOMPLETE = "REPORT_SET_INCOMPLETE"
    TEMPLATE_PROVIDED = "TEMPLATE_PROVIDED"
    VERSION_DEPRECATED = "VERSION_DEPRECATED"
    REQUIRED_FIELD_MISSING = "REQUIRED_FIELD_MISSING"
    DERIVATION_FAILED = "DERIVATION_FAILED"
    CONSISTENCY_FAILED = "CONSISTENCY_FAILED"


RESULT_EXIT_CODE: dict[str, int] = {
    "PASS": 0,
    "FROZEN": 0,
    "CONSISTENT": 0,
    "TEMPLATE_PROVIDED": 0,
    "PASS_WITH_WARNINGS": 10,
    "VERSION_DEPRECATED": 10,
    "NEEDS_INPUT": 11,
    "REQUIRED_FIELD_MISSING": 11,
    "NOT_READY": 12,
    "FAIL": 20,
    "DERIVATION_FAILED": 21,
    "CONSISTENCY_FAILED": 22,
    "VERSION_UNSUPPORTED": 23,
    "BLOCK": 31,
    "SUBJECT_MUTATED": 32,
    "DIGEST_MISMATCH": 33,
    "DIGEST_SET_MISMATCH": 33,
    "REPORT_SET_INCOMPLETE": 34,
    "EXECUTION_ERROR": 40,
}


@dataclass
class Finding:
    rule_id: str
    severity: str
    message: str
    path: str | None = None
    details: dict[str, Any] = field(default_factory=dict)
    manual_review_required: bool | None = None
    freeze_blocking: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return {k: v for k, v in d.items() if v is not None}


def utc_now_z() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def exit_code_for(result: str | Result) -> int:
    key = result.value if isinstance(result, Result) else result
    return RESULT_EXIT_CODE.get(key, 40)


def aggregate_result(findings: list[Finding], *, needs_input: bool = False) -> str:
    if needs_input:
        return Result.NEEDS_INPUT.value
    severities = {f.severity for f in findings}
    if Severity.BLOCK.value in severities:
        return Result.BLOCK.value
    if Severity.FAIL.value in severities:
        return Result.FAIL.value
    warns = [f for f in findings if f.severity == Severity.WARN.value]
    if warns:
        return Result.PASS_WITH_WARNINGS.value
    return Result.PASS.value


def warnings_from_findings(findings: list[Finding]) -> list[dict[str, Any]]:
    return [
        {"rule_id": f.rule_id, "message": f.message, "path": f.path}
        for f in findings
        if f.severity == Severity.WARN.value
    ]


def build_report(
    *,
    report_id: str,
    mode: str,
    subject: dict[str, Any],
    result: str,
    findings: list[Finding],
    ontology_version: str,
    engine_version: str,
    engine_build_digest: str = "sha256:phase1-dev-build",
    rule_bundle_digest: str = "sha256:phase1-dev-rules",
    validator_id: str = "skill-security-validator",
    validator_version: str = "1.3.0",
    storage: str = "VALIDATOR_CONTROLLED",
    creator_writable: bool = False,
) -> dict[str, Any]:
    return {
        "report_id": report_id,
        "mode": mode,
        "subject": subject,
        "validation": {
            "result": result,
            "ontology_version": ontology_version,
            "engine_version": engine_version,
            "engine_build_digest": engine_build_digest,
            "rule_bundle_digest": rule_bundle_digest,
            "findings": [f.to_dict() for f in findings],
            "warnings": warnings_from_findings(findings),
        },
        "validator": {"id": validator_id, "version": validator_version},
        "report_integrity": {
            "storage": storage,
            "creator_writable": creator_writable,
        },
        "validated_at": utc_now_z(),
    }


def dumps_report(report: dict[str, Any]) -> str:
    return json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
