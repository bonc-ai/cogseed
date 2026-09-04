"""Warning-policy application: attach review/freeze metadata to WARN findings.

The policy table lives in ``warning-policy.yaml``; entries are matched by
rule_id and filtered by mode/environment. Unmatched or out-of-scope WARNs
fail closed (review required, freeze blocking).
"""

from __future__ import annotations

from typing import Any

from .models import Finding
from .registry import read_artifact

_RISK_AND_TRUST_PREFIXES = ("SEC-TRUST-", "SEC-RISK-")


def apply_advisory_policy(
    findings: list[Finding],
    *,
    ontology_version: str,
    mode: str,
    environment: str,
) -> list[Finding]:
    policy = read_artifact(ontology_version, "warning-policy.yaml")
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


def warnings_permit_freeze(findings: list[Finding]) -> bool:
    for f in findings:
        path = f.path or ""
        if path == "risk" or path.startswith("risk."):
            continue
        if f.rule_id.startswith(_RISK_AND_TRUST_PREFIXES):
            continue
        if f.severity == "WARN" and f.freeze_blocking is True:
            return False
        if f.severity == "WARN" and f.manual_review_required is True:
            return False
    return True
