"""Apply warning-policy metadata to WARN findings."""

from __future__ import annotations

from typing import Any

from .paths import load_ontology_artifact
from .result_models import Finding


def apply_warning_policy(
    findings: list[Finding],
    *,
    ontology_version: str,
    mode: str,
    environment: str,
) -> list[Finding]:
    policy = load_ontology_artifact(ontology_version, "warning-policy.yaml")
    defaults = policy.get("default_unknown_warn") or {
        "manual_review_required": True,
        "freeze_blocking": True,
    }
    entries = {e["rule_id"]: e for e in policy.get("entries") or []}
    mode = mode.upper()
    out: list[Finding] = []
    for f in findings:
        if f.severity != "WARN":
            out.append(f)
            continue
        entry = entries.get(f.rule_id)
        if not entry:
            f.manual_review_required = bool(defaults.get("manual_review_required", True))
            f.freeze_blocking = bool(defaults.get("freeze_blocking", True))
            out.append(f)
            continue
        applies = entry.get("applies_to") or {}
        modes = [m.upper() for m in applies.get("modes") or []]
        envs = applies.get("environments") or []
        if modes and mode not in modes:
            # policy entry does not apply — fail closed
            f.manual_review_required = True
            f.freeze_blocking = True
        elif envs and environment not in envs:
            f.manual_review_required = True
            f.freeze_blocking = True
        else:
            f.manual_review_required = bool(entry.get("manual_review_required", True))
            f.freeze_blocking = bool(entry.get("freeze_blocking", True))
        out.append(f)
    return out


def freeze_allowed_by_warnings(findings: list[Finding]) -> bool:
    for f in findings:
        path = f.path or ""
        if path == "risk" or path.startswith("risk."):
            continue
        if f.rule_id.startswith(("SEC-TRUST-", "SEC-RISK-")):
            continue
        if f.severity == "WARN" and f.freeze_blocking is True:
            return False
        if f.severity == "WARN" and f.manual_review_required is True:
            return False
    return True
