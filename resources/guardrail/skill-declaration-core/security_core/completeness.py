"""Declaration completeness audit: required fields, placeholders, deferrals.

Walks the security manifest against the fixed required-path checklist and
reports missing / placeholder / deferred fields per mode. PREVALIDATION is the
only mode that accepts ``DEFERRED_UNTIL_FREEZE`` and ``REQUIRED_INPUT``.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .models import Finding, Severity

FORBIDDEN_PLACEHOLDERS = {
    "REQUIRED_INPUT",
    "TODO",
    "TBD",
    "CHANGEME",
    "YOUR_NAME",
    "placeholder",
    "N/A",
}

DEFERRED_MARKER = "DEFERRED_UNTIL_FREEZE"

REQUIRED_PATHS = [
    "manifest_version",
    "security_ontology.id",
    "security_ontology.version",
    "skill.id",
    "skill.name",
    "skill.version",
    "skill.description",
    "skill.environment",
    "skill.artifact_manifest_ref",
    "skill.skill_spec_ref",
    "skill.business_ontology_ref",
    "ownership.human_owner",
    "ownership.organization",
    "ownership.role",
    "provenance.source_type",
    "provenance.source_uri",
    "provenance.author",
    "provenance.checksum",
    "data_security.input_classification",
    "data_security.output_classification",
    "data_security.external_transmission",
    "data_security.pii_allowed",
    "data_security.secrets_allowed",
    "data_security.retention_days",
    "network.enabled",
    "network.allowlist",
    "network.deny_private_network",
    "network.allow_dynamic_download",
    "runtime_boundary.runtime_contracts_ref",
    "runtime_boundary.direct_resource_access",
    "runtime_boundary.access_via_gateway_only",
    "runtime_boundary.binding_resolved_by",
    "runtime_boundary.audit_emitted_by",
    # risk.* declaration/derivation temporarily not required (risk calc disabled)
    "approval.required",
    "approval.mode",
    "audit.enabled",
    "rollback.supported",
    "rollback.type",
    "rollback.procedure",
    "rollback.maximum_recovery_time_minutes",
    "tests.evals_ref",
    "tests.validation_contract_ref",
    "tests.minimum_test_cases",
]

RISK_CRITICAL_PATHS = [
    "ownership.human_owner",
]


def _lookup(obj: Any, dotted: str) -> Any:
    cur = obj
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def _placeholder(value: Any) -> bool:
    return isinstance(value, str) and value.strip() in FORBIDDEN_PLACEHOLDERS


def audit_completeness(
    manifest: dict[str, Any],
    ontology_version: str,
    mode: str = "PREVALIDATION",
) -> dict[str, Any]:
    """Return ``findings`` + ``needs_input`` for the given mode."""
    _ = ontology_version
    findings: list[Finding] = []
    needs_input = False
    mode = mode.upper()
    allow_deferred = mode == "PREVALIDATION"
    allow_required_input = mode == "PREVALIDATION"

    for dotted in REQUIRED_PATHS:
        value = _lookup(manifest, dotted)

        if value is None or _blank(value):
            if dotted in RISK_CRITICAL_PATHS and allow_required_input:
                needs_input = True
                findings.append(
                    Finding(
                        rule_id="SEC-COMPLETION-NEEDS-INPUT-001",
                        severity=Severity.WARN.value,
                        message=f"Missing risk/ownership fact: {dotted}",
                        path=dotted,
                    )
                )
            else:
                sev = Severity.FAIL.value if mode == "PREVALIDATION" else Severity.BLOCK.value
                findings.append(
                    Finding(
                        rule_id="SEC-COMPLETION-REQUIRED-001",
                        severity=sev,
                        message=f"Required field missing: {dotted}",
                        path=dotted,
                    )
                )
            continue

        if dotted == "provenance.checksum" and value == DEFERRED_MARKER:
            if allow_deferred:
                findings.append(
                    Finding(
                        rule_id="SEC-PROVENANCE-CHECKSUM-DEFERRED-001",
                        severity=Severity.INFO.value,
                        message="provenance.checksum deferred until freeze",
                        path=dotted,
                        manual_review_required=False,
                        freeze_blocking=False,
                    )
                )
            else:
                findings.append(
                    Finding(
                        rule_id="SEC-DIGEST-002",
                        severity=Severity.BLOCK.value,
                        message="provenance.checksum must be real sha256 in FREEZE/FORMAL_TEST",
                        path=dotted,
                    )
                )
            continue

        if _placeholder(value):
            if allow_required_input and dotted in RISK_CRITICAL_PATHS:
                needs_input = True
                findings.append(
                    Finding(
                        rule_id="SEC-COMPLETION-NEEDS-INPUT-001",
                        severity=Severity.WARN.value,
                        message=f"Unresolved required input: {dotted}",
                        path=dotted,
                    )
                )
            else:
                sev = Severity.FAIL.value if mode == "PREVALIDATION" else Severity.BLOCK.value
                findings.append(
                    Finding(
                        rule_id="SEC-COMPLETION-PLACEHOLDER-001",
                        severity=sev,
                        message=f"Placeholder not allowed for mode {mode}: {dotted}",
                        path=dotted,
                    )
                )

    tech = _lookup(manifest, "ownership.technical_owner")
    env = _lookup(manifest, "skill.environment")
    if tech in (None, "") and env in ("development", "test"):
        findings.append(
            Finding(
                rule_id="SEC-OPTIONAL-TECHNICAL-OWNER-001",
                severity=Severity.INFO.value,
                message="technical_owner omitted (allowed in non-production)",
                path="ownership.technical_owner",
                manual_review_required=False,
                freeze_blocking=False,
            )
        )

    return {
        "findings": findings,
        "needs_input": needs_input,
        "mode": mode,
        "manifest": deepcopy(manifest),
    }
