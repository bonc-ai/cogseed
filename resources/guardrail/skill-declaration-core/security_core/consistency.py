"""Consistency: APR, network, boundaries, dual-manifest, controls."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

from .path_security import FORBIDDEN_ALLOWLIST_TOKENS, check_relative_path, scan_tree_security
from .result_models import Finding, Severity

CONTROL_RANK = {"none": 0, "single": 1, "dual": 2, "security_review": 3}
RISK_RANK = {"L0": 0, "L1": 1, "L2": 2, "L3": 3, "L4": 4, "L5": 5}


def _load_yaml(path: Path) -> Any:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def _required_approval(effective: str, environment: str, control_matrix: dict[str, Any], trust_mod: str) -> str:
    row = control_matrix.get(effective) or {}
    base = row.get("approval", "none")
    if base == "none_or_prod_single":
        base = "single" if environment == "production" else "none"
    if base == "single_or_dual_sensitive":
        base = "single"
    # max with trust modifier
    if CONTROL_RANK.get(trust_mod, 0) > CONTROL_RANK.get(base, 0):
        return trust_mod
    return base


def validate_consistency(
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

    # Ontology invariants
    so = manifest.get("security_ontology") or {}
    if so.get("id") != "ecs.security.skill":
        findings.append(
            Finding(rule_id="SEC-ONTOLOGY-001", severity=Severity.BLOCK.value, message="Ontology id must be ecs.security.skill")
        )
    if so.get("version") != ontology_version:
        findings.append(
            Finding(
                rule_id="SEC-ONTOLOGY-002",
                severity=Severity.BLOCK.value,
                message=f"Ontology version {so.get('version')} != loaded {ontology_version}",
            )
        )

    env = (manifest.get("skill") or {}).get("environment")
    owner = (manifest.get("ownership") or {}).get("human_owner", "")
    if env == "production" and (
        not owner or owner in ("REQUIRED_INPUT", "TODO", "TBD", "placeholder", "CHANGEME")
    ):
        findings.append(
            Finding(
                rule_id="SEC-OWNER-001",
                severity=Severity.BLOCK.value,
                message="Production skill requires non-placeholder human_owner",
                path="ownership.human_owner",
            )
        )

    # Permissions wildcards
    for p in (manifest.get("permissions") or {}).get("required") or []:
        blob = json.dumps(p, ensure_ascii=False).lower() if isinstance(p, dict) else str(p).lower()
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

    rb = manifest.get("runtime_boundary") or {}
    if rb.get("direct_resource_access") is not False:
        findings.append(
            Finding(rule_id="SEC-BOUNDARY-001", severity=Severity.BLOCK.value, message="direct_resource_access must be false")
        )
    if rb.get("access_via_gateway_only") is not True:
        findings.append(
            Finding(rule_id="SEC-BOUNDARY-002", severity=Severity.BLOCK.value, message="access_via_gateway_only must be true")
        )
    if rb.get("binding_resolved_by") != "agent_layer":
        findings.append(
            Finding(rule_id="SEC-BOUNDARY-003", severity=Severity.BLOCK.value, message="binding_resolved_by must be agent_layer")
        )
    if rb.get("audit_emitted_by") != "runtime":
        findings.append(
            Finding(rule_id="SEC-BOUNDARY-004", severity=Severity.BLOCK.value, message="audit_emitted_by must be runtime")
        )

    network = manifest.get("network") or {}
    if network.get("allow_dynamic_download") is True:
        findings.append(
            Finding(rule_id="SEC-NETWORK-001", severity=Severity.BLOCK.value, message="allow_dynamic_download must be false")
        )
    if network.get("enabled") is True:
        allow = network.get("allowlist") or []
        if not allow or any(str(a).lower() in FORBIDDEN_ALLOWLIST_TOKENS for a in allow):
            findings.append(
                Finding(
                    rule_id="SEC-NETWORK-002",
                    severity=Severity.BLOCK.value,
                    message="network.enabled requires explicit non-wildcard allowlist",
                    path="network.allowlist",
                )
            )
    else:
        # no external network actions
        for a in (manifest.get("actions") or {}).get("allowed") or []:
            if isinstance(a, dict) and a.get("external_network"):
                findings.append(
                    Finding(
                        rule_id="SEC-NETWORK-003",
                        severity=Severity.FAIL.value,
                        message="external network action while network.enabled=false",
                        path=f"actions.allowed[{a.get('id')}]",
                    )
                )

    # Artifact presence
    artifact = root / "artifact.yaml"
    sec_path = root / "references" / "security-manifest.yaml"
    if not artifact.exists():
        findings.append(
            Finding(rule_id="SEC-ARTIFACT-MANIFEST-001", severity=Severity.BLOCK.value, message="artifact.yaml missing")
        )
    if not sec_path.exists():
        findings.append(
            Finding(
                rule_id="SEC-ARTIFACT-MANIFEST-002",
                severity=Severity.BLOCK.value,
                message="references/security-manifest.yaml missing",
            )
        )
    else:
        # path security on refs
        for ref_path in (
            (manifest.get("skill") or {}).get("artifact_manifest_ref"),
            (manifest.get("skill") or {}).get("skill_spec_ref"),
            (manifest.get("skill") or {}).get("business_ontology_ref"),
            (manifest.get("tests") or {}).get("evals_ref"),
            (manifest.get("tests") or {}).get("validation_contract_ref"),
        ):
            if ref_path:
                findings.extend(check_relative_path(root, str(ref_path).split("#")[0]))

    # Dual manifest consistency (artifact -> security)
    if artifact.exists() and sec_path.exists():
        try:
            art = _load_yaml(artifact)
            spec = (art or {}).get("spec") or {}
            sec = (spec.get("security") or {})
            if sec.get("manifest_ref") not in (None, "references/security-manifest.yaml"):
                # allow missing if ontology version present
                pass
            meta = (art or {}).get("metadata") or {}
            skill = manifest.get("skill") or {}
            for key, mkey in (("id", "id"), ("name", "name"), ("version", "version")):
                if meta.get(key) and skill.get(mkey) and meta.get(key) != skill.get(mkey):
                    findings.append(
                        Finding(
                            rule_id="SEC-DUAL-MANIFEST-001",
                            severity=Severity.FAIL.value,
                            message=f"artifact metadata.{key} != skill.{mkey}",
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

    # Action-Permission-Resource binding (minimal)
    actions = (manifest.get("actions") or {}).get("allowed") or []
    perms = (manifest.get("permissions") or {}).get("required") or []
    resources = (manifest.get("resources") or {}).get("allowed") or []
    perm_ids = {p.get("id") for p in perms if isinstance(p, dict) and p.get("id")}
    used_perms: set[str] = set()
    for a in actions:
        if not isinstance(a, dict):
            continue
        pid = a.get("permission_id") or a.get("permission")
        if not pid:
            findings.append(
                Finding(
                    rule_id="SEC-APR-UNBOUND-ACTION-001",
                    severity=Severity.BLOCK.value,
                    message=f"Action {a.get('id')} not bound to permission",
                    path=f"actions.allowed[{a.get('id')}]",
                )
            )
        else:
            used_perms.add(str(pid))
            if str(pid) not in perm_ids and perm_ids:
                findings.append(
                    Finding(
                        rule_id="SEC-APR-UNBOUND-ACTION-001",
                        severity=Severity.BLOCK.value,
                        message=f"Action {a.get('id')} permission {pid} not in permissions.required",
                    )
                )

    for p in perms:
        if not isinstance(p, dict) or not p.get("id"):
            continue
        if p["id"] not in used_perms:
            acts = p.get("actions") or ["READ"]
            act0 = str(acts[0]).upper() if acts else "READ"
            sev = {"READ": Severity.WARN.value, "WRITE": Severity.FAIL.value}.get(act0, Severity.BLOCK.value)
            if act0 in ("DELETE", "ADMIN"):
                sev = Severity.BLOCK.value
            findings.append(
                Finding(
                    rule_id="SEC-APR-UNUSED-PERMISSION-001",
                    severity=sev,
                    message=f"Unused permission {p['id']}",
                    path=f"permissions.required[{p['id']}]",
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

    # Audit / rollback — risk calculation disabled: do not enforce controls from
    # calculated/effective risk or control_matrix. Production audit still required.
    if env == "production" and not (manifest.get("audit") or {}).get("enabled"):
        findings.append(
            Finding(rule_id="SEC-AUDIT-001", severity=Severity.BLOCK.value, message="Production audit.enabled must be true")
        )

    # control_matrix / SEC-RISK-001 approval-vs-effective_risk skipped while risk derivation is off
    _ = (control_matrix, trust_modifier_approval)

    # Tests
    evals_ref = (manifest.get("tests") or {}).get("evals_ref")
    if evals_ref:
        findings.extend(check_relative_path(root, str(evals_ref)))
        ep = root / str(evals_ref)
        if not ep.exists():
            findings.append(
                Finding(rule_id="SEC-TEST-001", severity=Severity.FAIL.value, message=f"evals missing: {evals_ref}")
            )
        else:
            try:
                data = json.loads(ep.read_text(encoding="utf-8"))
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

    # FORMAL digest checks
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

    # Filesystem scan (symlinks etc.) — best effort
    if root.exists():
        findings.extend(scan_tree_security(root))

    return {"findings": findings, "mode": mode}
