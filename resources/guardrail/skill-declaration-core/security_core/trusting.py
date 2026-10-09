"""Trust posture derivation from provenance evidence.

With the five-dimension risk flow disabled, declared ``risk.trust_level`` is
accepted as-is and only the evidence ceiling is computed. The output shape is
consumed by the pipeline (``trust_modifier_approval``) and must stay stable.
"""

from __future__ import annotations

from typing import Any

from .models import Finding, Severity
from .registry import read_artifact

TRUST_LEVELS = {"T0": 0, "T1": 1, "T2": 2, "T3": 3, "T4": 4}

# Aligned with risk derivation disablement: empty risk.* must not block freeze
RISK_TRUST_CHECKS_ENABLED = False


def _evidence_ceiling(provenance: dict[str, Any], rules: dict[str, Any]) -> str | None:
    source = provenance.get("source_type")
    if not source:
        return None
    candidates = [
        level
        for level, meta in rules.get("levels", {}).items()
        if source in (meta.get("max_source_types") or [])
    ]
    if not candidates:
        if source in ("third_party", "modified_third_party"):
            return "T3"
        return None
    return min(candidates, key=lambda x: TRUST_LEVELS[x])


def derive_trust_posture(
    manifest: dict[str, Any],
    ontology_version: str = "1.1.1",
    *,
    effective_risk: str | None = None,
) -> dict[str, Any]:
    """Trust posture. With the risk flow disabled, empty trust_level yields no findings."""
    _ = effective_risk
    rules = read_artifact(ontology_version, "trust-rules.yaml")
    findings: list[Finding] = []
    provenance = manifest.get("provenance") or {}
    declared = (manifest.get("risk") or {}).get("trust_level")

    evidence = _evidence_ceiling(provenance, rules) or "T4"

    if not RISK_TRUST_CHECKS_ENABLED:
        return {
            "findings": findings,
            "evidence_trust": evidence,
            "applied_trust": declared if declared in TRUST_LEVELS else None,
            "trust_modifier_approval": "none",
            "isolation_required": False,
            "risk_trust_checks": "disabled",
        }

    if evidence is None:
        findings.append(
            Finding(
                rule_id="SEC-TRUST-UNRESOLVED-001",
                severity=Severity.WARN.value,
                message="Unable to derive trust from provenance",
                path="risk.trust_level",
                freeze_blocking=False,
                manual_review_required=False,
            )
        )
        evidence = "T4"

    if declared not in TRUST_LEVELS:
        findings.append(
            Finding(
                rule_id="SEC-TRUST-UNRESOLVED-001",
                severity=Severity.WARN.value,
                message="trust_level missing or invalid",
                path="risk.trust_level",
                freeze_blocking=False,
                manual_review_required=False,
            )
        )
        declared = evidence

    if TRUST_LEVELS[declared] < TRUST_LEVELS[evidence]:
        findings.append(
            Finding(
                rule_id="SEC-TRUST-001",
                severity=Severity.BLOCK.value,
                message=f"Declared trust {declared} higher than evidence allows ({evidence})",
                path="risk.trust_level",
            )
        )
    elif TRUST_LEVELS[declared] > TRUST_LEVELS[evidence]:
        findings.append(
            Finding(
                rule_id="SEC-TRUST-CONSERVATIVE-001",
                severity=Severity.WARN.value,
                message=f"Declared trust {declared} more conservative than evidence ({evidence})",
                path="risk.trust_level",
                freeze_blocking=False,
                manual_review_required=False,
            )
        )

    applied = declared if TRUST_LEVELS[declared] >= TRUST_LEVELS[evidence] else evidence

    if applied == "T4":
        findings.append(
            Finding(
                rule_id="SEC-TRUST-001",
                severity=Severity.BLOCK.value,
                message="T4 trust cannot produce final PASS",
                path="risk.trust_level",
            )
        )

    return {
        "findings": findings,
        "evidence_trust": evidence,
        "applied_trust": applied,
        "trust_modifier_approval": "none",
        "isolation_required": bool((rules.get("levels") or {}).get(applied, {}).get("formal_test_isolation")),
    }
