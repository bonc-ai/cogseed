"""Mode-aware completion / required-field checks."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .result_models import Finding, Severity

PLACEHOLDERS = {
    "REQUIRED_INPUT",
    "TODO",
    "TBD",
    "CHANGEME",
    "YOUR_NAME",
    "placeholder",
    "N/A",
}

DEFERRED = "DEFERRED_UNTIL_FREEZE"

# Dot-paths that must be filled (non-empty, non-placeholder) by mode
BASE_REQUIRED = [
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

RISK_CRITICAL = [
    "ownership.human_owner",
]


def _get(obj: Any, path: str) -> Any:
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and value.strip() == "":
        return True
    if isinstance(value, (list, dict)) and len(value) == 0 and False:
        # empty arrays are allowed for permissions etc.; only string empties count here
        return False
    return False


def _is_placeholder(value: Any) -> bool:
    if isinstance(value, str) and value.strip() in PLACEHOLDERS:
        return True
    return False


def validate_completion(
    manifest: dict[str, Any],
    ontology_version: str,
    mode: str = "PREVALIDATION",
) -> dict[str, Any]:
    """Return findings + needs_input flag for the given mode."""
    _ = ontology_version
    findings: list[Finding] = []
    needs_input = False
    mode = mode.upper()
    allow_deferred = mode == "PREVALIDATION"
    allow_required_input = mode == "PREVALIDATION"

    for path in BASE_REQUIRED:
        value = _get(manifest, path)
        if value is None or _is_empty(value):
            if path in RISK_CRITICAL and allow_required_input:
                needs_input = True
                findings.append(
                    Finding(
                        rule_id="SEC-COMPLETION-NEEDS-INPUT-001",
                        severity=Severity.WARN.value,
                        message=f"Missing risk/ownership fact: {path}",
                        path=path,
                    )
                )
            else:
                sev = Severity.FAIL.value if mode == "PREVALIDATION" else Severity.BLOCK.value
                findings.append(
                    Finding(
                        rule_id="SEC-COMPLETION-REQUIRED-001",
                        severity=sev,
                        message=f"Required field missing: {path}",
                        path=path,
                    )
                )
            continue

        if path == "provenance.checksum" and value == DEFERRED:
            if allow_deferred:
                findings.append(
                    Finding(
                        rule_id="SEC-PROVENANCE-CHECKSUM-DEFERRED-001",
                        severity=Severity.INFO.value,
                        message="provenance.checksum deferred until freeze",
                        path=path,
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
                        path=path,
                    )
                )
            continue

        if _is_placeholder(value):
            if allow_required_input and path in RISK_CRITICAL:
                needs_input = True
                findings.append(
                    Finding(
                        rule_id="SEC-COMPLETION-NEEDS-INPUT-001",
                        severity=Severity.WARN.value,
                        message=f"Unresolved required input: {path}",
                        path=path,
                    )
                )
            else:
                sev = Severity.FAIL.value if mode == "PREVALIDATION" else Severity.BLOCK.value
                findings.append(
                    Finding(
                        rule_id="SEC-COMPLETION-PLACEHOLDER-001",
                        severity=sev,
                        message=f"Placeholder not allowed for mode {mode}: {path}",
                        path=path,
                    )
                )

    tech = _get(manifest, "ownership.technical_owner")
    env = _get(manifest, "skill.environment")
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
