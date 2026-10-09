"""Cross-manifest coherence audit.

Verifies that the declaration (security manifest) is internally consistent and
consistent with the artifact manifest and the filesystem: ontology identity,
ownership rules, permission wildcards, runtime boundaries, network policy,
action-permission-resource binding, test evidence and formal-mode digest
requirements.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

from .guards import DANGEROUS_ALLOWLIST_TOKENS, audit_relative_path, walk_tree_guards
from .models import Finding, Severity

_APPROVAL_RANK = {"none": 0, "single": 1, "dual": 2, "security_review": 3}

_PROD_OWNER_PLACEHOLDERS = ("REQUIRED_INPUT", "TODO", "TBD", "placeholder", "CHANGEME")


def _read_yaml(path: Path) -> Any:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def _required_approval(effective: str, environment: str, control_matrix: dict[str, Any], trust_mod: str) -> str:
    row = control_matrix.get(effective) or {}
    base = row.get("approval", "none")
    if base == "none_or_prod_single":
        base = "single" if environment == "production" else "none"
    if base == "single_or_dual_sensitive":
        base = "single"
    if _APPROVAL_RANK.get(trust_mod, 0) > _APPROVAL_RANK.get(base, 0):
        return trust_mod
    return base


def audit_coherence(
    manifest: dict[str, Any],
    skill_root: str | Path,
    ontology_version: str = "1.1.1",
    *,
    mode: str = "PREVALIDATION",
    control_matrix: dict[str, Any] | None = None,
    trust_modifier_approval: str = "none",
    subject_digest: str | None = None,
    freeze_id: str | None = None,
) -> dict[str, Any]:
    root = Path(skill_root)
    findings: list[Finding] = []
    mode = mode.upper()

    # Ontology identity invariants
    so = manifest.get("security_ontology") or {}
    if so.get("id") != "cogseed.security.skill":
        findings.append(
            Finding(
                rule_id="SEC-ONTOLOGY-001",
                severity=Severity.BLOCK.value,
                message="Ontology id must be cogseed.security.skill",
            )
        )
    if so.get("version") != ontology_version:
        findings.append(
            Finding(
                rule_id="SEC-ONTOLOGY-002",
                severity=Severity.BLOCK.value,
                message=f"Ontology version {so.get('version')} != loaded {ontology_version}",
            )
        )

    # Production ownership
    env = (manifest.get("skill") or {}).get("environment")
    owner = (manifest.get("ownership") or {}).get("human_owner", "")
    if env == "production" and (not owner or owner in _PROD_OWNER_PLACEHOLDERS):
        findings.append(
            Finding(
                rule_id="SEC-OWNER-001",
                severity=Severity.BLOCK.value,
                message="Production skill requires non-placeholder human_owner",
                path="ownership.human_owner",
            )
        )

    # Permission wildcards
    for perm in (manifest.get("permissions") or {}).get("required") or []:
        blob = json.dumps(perm, ensure_ascii=False).lower() if isinstance(perm, dict) else str(perm).lower()
        if any(tok in blob for tok in ("*", "all", "unrestricted")):
            findings.append(
                Finding(
                    rule_id="SEC-PERMISSION-001",
                    severity=Severity.BLOCK.value,
                    message="Wildcard/unrestricted permission forbidden",
                    path="permissions.required",
                )
            )
            break

    # Runtime boundary contract
    rb = manifest.get("runtime_boundary") or {}
    boundary_rules = (
        ("direct_resource_access", False, "SEC-BOUNDARY-001", "direct_resource_access must be false"),
        ("access_via_gateway_only", True, "SEC-BOUNDARY-002", "access_via_gateway_only must be true"),
        ("binding_resolved_by", "agent_layer", "SEC-BOUNDARY-003", "binding_resolved_by must be agent_layer"),
        ("audit_emitted_by", "runtime", "SEC-BOUNDARY-004", "audit_emitted_by must be runtime"),
    )
    for key, expected, rule_id, message in boundary_rules:
        if rb.get(key) != expected:
            findings.append(Finding(rule_id=rule_id, severity=Severity.BLOCK.value, message=message))

    # Network policy
    network = manifest.get("network") or {}
    if network.get("allow_dynamic_download") is True:
        findings.append(
            Finding(
                rule_id="SEC-NETWORK-001",
                severity=Severity.BLOCK.value,
                message="allow_dynamic_download must be false",
            )
        )
    if network.get("enabled") is True:
        allow = network.get("allowlist") or []
        if not allow or any(str(a).lower() in DANGEROUS_ALLOWLIST_TOKENS for a in allow):
            findings.append(
                Finding(
                    rule_id="SEC-NETWORK-002",
                    severity=Severity.BLOCK.value,
                    message="network.enabled requires explicit non-wildcard allowlist",
                    path="network.allowlist",
                )
            )
    else:
        for action in (manifest.get("actions") or {}).get("allowed") or []:
            if isinstance(action, dict) and action.get("external_network"):
                findings.append(
                    Finding(
                        rule_id="SEC-NETWORK-003",
                        severity=Severity.FAIL.value,
                        message="external network action while network.enabled=false",
                        path=f"actions.allowed[{action.get('id')}]",
                    )
                )

    # Manifest presence
    artifact_path = root / "artifact.yaml"
    security_path = root / "references" / "security-manifest.yaml"
    if not artifact_path.exists():
        findings.append(
            Finding(rule_id="SEC-ARTIFACT-MANIFEST-001", severity=Severity.BLOCK.value, message="artifact.yaml missing")
        )
    if not security_path.exists():
        findings.append(
            Finding(
                rule_id="SEC-ARTIFACT-MANIFEST-002",
                severity=Severity.BLOCK.value,
                message="references/security-manifest.yaml missing",
            )
        )
    else:
        refs = (
            (manifest.get("skill") or {}).get("artifact_manifest_ref"),
            (manifest.get("skill") or {}).get("skill_spec_ref"),
            (manifest.get("skill") or {}).get("business_ontology_ref"),
            (manifest.get("tests") or {}).get("evals_ref"),
            (manifest.get("tests") or {}).get("validation_contract_ref"),
        )
        for ref_path in refs:
            if ref_path:
                findings.extend(audit_relative_path(root, str(ref_path).split("#")[0]))

    # Dual-manifest identity agreement
    if artifact_path.exists() and security_path.exists():
        try:
            artifact = _read_yaml(artifact_path)
            metadata = (artifact or {}).get("metadata") or {}
            skill = manifest.get("skill") or {}
            for key in ("id", "name", "version"):
                if metadata.get(key) and skill.get(key) and metadata.get(key) != skill.get(key):
                    findings.append(
                        Finding(
                            rule_id="SEC-DUAL-MANIFEST-001",
                            severity=Severity.FAIL.value,
                            message=f"artifact metadata.{key} != skill.{key}",
                        )
                    )
        except Exception as exc:  # noqa: BLE001
            findings.append(
                Finding(
                    rule_id="SEC-DUAL-MANIFEST-001",
                    severity=Severity.FAIL.value,
                    message=f"Cannot parse artifact.yaml: {exc}",
                )
            )

    # Action-Permission-Resource binding
    actions = (manifest.get("actions") or {}).get("allowed") or []
    perms = (manifest.get("permissions") or {}).get("required") or []
    resources = (manifest.get("resources") or {}).get("allowed") or []
    perm_ids = {p.get("id") for p in perms if isinstance(p, dict) and p.get("id")}
    used_perms: set[str] = set()
    for action in actions:
        if not isinstance(action, dict):
            continue
        pid = action.get("permission_id") or action.get("permission")
        if not pid:
            findings.append(
                Finding(
                    rule_id="SEC-APR-UNBOUND-ACTION-001",
                    severity=Severity.BLOCK.value,
                    message=f"Action {action.get('id')} not bound to permission",
                    path=f"actions.allowed[{action.get('id')}]",
                )
            )
        else:
            used_perms.add(str(pid))
            if str(pid) not in perm_ids and perm_ids:
                findings.append(
                    Finding(
                        rule_id="SEC-APR-UNBOUND-ACTION-001",
                        severity=Severity.BLOCK.value,
                        message=f"Action {action.get('id')} permission {pid} not in permissions.required",
                    )
                )

    for perm in perms:
        if not isinstance(perm, dict) or not perm.get("id"):
            continue
        if perm["id"] not in used_perms:
            acts = perm.get("actions") or ["READ"]
            act0 = str(acts[0]).upper() if acts else "READ"
            sev = {"READ": Severity.WARN.value, "WRITE": Severity.FAIL.value}.get(act0, Severity.BLOCK.value)
            if act0 in ("DELETE", "ADMIN"):
                sev = Severity.BLOCK.value
            findings.append(
                Finding(
                    rule_id="SEC-APR-UNUSED-PERMISSION-001",
                    severity=sev,
                    message=f"Unused permission {perm['id']}",
                    path=f"permissions.required[{perm['id']}]",
                )
            )

    res_ids = {r.get("id") for r in resources if isinstance(r, dict) and r.get("id")}
    used_res = {p.get("resource") for p in perms if isinstance(p, dict) and p.get("resource")}
    for rid in res_ids - used_res:
        findings.append(
            Finding(
                rule_id="SEC-APR-UNUSED-RESOURCE-001",
                severity=Severity.WARN.value,
                message=f"Unused resource {rid}",
            )
        )

    # Production audit requirement (risk calc disabled: control matrix skipped)
    if env == "production" and not (manifest.get("audit") or {}).get("enabled"):
        findings.append(
            Finding(
                rule_id="SEC-AUDIT-001",
                severity=Severity.BLOCK.value,
                message="Production audit.enabled must be true",
            )
        )
    _ = (control_matrix, trust_modifier_approval)

    # Test evidence
    evals_ref = (manifest.get("tests") or {}).get("evals_ref")
    if evals_ref:
        findings.extend(audit_relative_path(root, str(evals_ref)))
        evals_path = root / str(evals_ref)
        if not evals_path.exists():
            findings.append(
                Finding(rule_id="SEC-TEST-001", severity=Severity.FAIL.value, message=f"evals missing: {evals_ref}")
            )
        else:
            try:
                data = json.loads(evals_path.read_text(encoding="utf-8"))
                cases = data if isinstance(data, list) else data.get("cases") or data.get("evals") or []
                min_n = int((manifest.get("tests") or {}).get("minimum_test_cases") or 1)
                if len(cases) < min_n:
                    findings.append(
                        Finding(
                            rule_id="SEC-TEST-001",
                            severity=Severity.FAIL.value,
                            message=f"Need >= {min_n} test cases, found {len(cases)}",
                        )
                    )
            except Exception as exc:  # noqa: BLE001
                findings.append(
                    Finding(rule_id="SEC-TEST-001", severity=Severity.FAIL.value, message=f"evals unreadable: {exc}")
                )

    # Formal-mode digest requirements
    if mode == "FORMAL_TEST":
        checksum = (manifest.get("provenance") or {}).get("checksum")
        if not freeze_id or not subject_digest:
            findings.append(
                Finding(
                    rule_id="SEC-DIGEST-001",
                    severity=Severity.BLOCK.value,
                    message="FORMAL_TEST requires freeze_id and subject_digest",
                )
            )
        if checksum != subject_digest:
            findings.append(
                Finding(
                    rule_id="SEC-DIGEST-002",
                    severity=Severity.BLOCK.value,
                    message="provenance.checksum must equal subject_digest",
                    path="provenance.checksum",
                )
            )

    # Filesystem audit (symlinks etc.) — best effort
    if root.exists():
        findings.extend(walk_tree_guards(root))

    return {"findings": findings, "mode": mode}
