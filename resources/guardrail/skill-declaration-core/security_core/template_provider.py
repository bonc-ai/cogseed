"""3.1 Template Provider API — aligned to design doc §6."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .paths import load_ontology_artifact
from .result_models import Result, exit_code_for
from .version_resolver import list_supported_versions as _list_versions_raw
from .version_resolver import resolve_ontology

# §6.2 derived risk fields exist on the template but calculation/assignment is disabled.
DERIVED_FIELDS = [
    "risk.calculated_risk_level",
    "risk.effective_risk_level",
    "risk.calculation_rule_version",
    "risk.calculation_factors",
    "risk.triggered_rule_ids",
]

# Risk derivation cancelled: FORMAL_TEST does not require derived risk fields.
FORMAL_EXTRA_REQUIRED: list[str] = []
RISK_DERIVATION_ENABLED = False


def _load_field_catalog(ontology_version: str) -> dict[str, Any]:
    return load_ontology_artifact(ontology_version, "manifest-fields.yaml")


def _index_fields(catalog: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {f["path"]: f for f in catalog.get("fields") or [] if f.get("path")}


def _walk_schema(schema: dict[str, Any], field_path: str) -> dict[str, Any] | None:
    node: Any = schema
    for part in field_path.split("."):
        if not isinstance(node, dict):
            return None
        props = node.get("properties") or {}
        if part not in props:
            return None
        node = props[part]
    return node if isinstance(node, dict) else None


def _is_required_in_schema(schema: dict[str, Any], field_path: str) -> bool | None:
    parts = field_path.split(".")
    node: Any = schema
    for i, part in enumerate(parts):
        if not isinstance(node, dict):
            return None
        required = node.get("required") or []
        props = node.get("properties") or {}
        if part not in props:
            return None
        if i == len(parts) - 1:
            return part in required
        node = props[part]
    return None


def _declaration_required_paths(catalog: dict[str, Any]) -> list[str]:
    return [f["path"] for f in catalog.get("fields") or [] if f.get("required") and not f.get("derived")]


def _extract_rule_ids(doc: Any) -> list[str]:
    ids: list[str] = []
    if isinstance(doc, dict):
        if isinstance(doc.get("rule_id"), str):
            ids.append(doc["rule_id"])
        for key in ("rules", "escalations", "entries"):
            for item in doc.get(key) or []:
                ids.extend(_extract_rule_ids(item))
        for v in doc.values():
            if isinstance(v, (dict, list)) and not isinstance(v, str):
                # avoid double-count from known lists already walked
                pass
    elif isinstance(doc, list):
        for item in doc:
            ids.extend(_extract_rule_ids(item))
    return sorted(set(ids))


# ---------------------------------------------------------------------------
# §6 operations
# ---------------------------------------------------------------------------


def get_template(ontology_version: str) -> dict[str, Any]:
    """按指定版本返回模板（§6.1/6.2 Security Manifest + §6.3 Artifact Manifest）。"""
    resolution = resolve_ontology(ontology_version)
    if not resolution.ok:
        return {
            "ok": False,
            "result": resolution.result,
            "exit_code": exit_code_for(resolution.result or Result.VERSION_UNSUPPORTED),
            "findings": [f.to_dict() for f in resolution.findings],
            "message": "精确版本匹配失败；请先 list-supported-versions。",
        }
    security_template = deepcopy(resolution.artifacts["template"])
    artifact_template = deepcopy(resolution.artifacts["artifact_template"])
    compatibility_template = deepcopy(resolution.artifacts["compatibility_template"])
    result = (
        Result.VERSION_DEPRECATED.value
        if resolution.status == "deprecated-but-supported"
        else Result.TEMPLATE_PROVIDED.value
    )
    return {
        "ok": True,
        "result": result,
        "exit_code": exit_code_for(result),
        "ontology_id": "cogseed.security.skill",
        "ontology_version": ontology_version,
        # 向后兼容：template = Security Manifest
        "template": security_template,
        "security_manifest_template": security_template,
        "security_manifest_target": "references/security-manifest.yaml",
        "artifact_manifest_template": artifact_template,
        "artifact_manifest_target": "artifact.yaml",
        "compatibility_manifest_template": compatibility_template,
        "compatibility_manifest_target": "manifest.yaml",
        "compatibility_note": (
            "manifest.yaml 由 artifact.yaml 单向生成；关键字段与安全引用必须一致，"
            "不得以 compatibility manifest 反向覆盖 artifact.yaml。"
        ),
        "findings": [f.to_dict() for f in resolution.findings],
    }


def describe_field(ontology_version: str, field_path: str) -> dict[str, Any]:
    """返回字段含义、类型、是否必填、填写责任、枚举范围和 mode 约束。"""
    # Exact version gate
    resolution = resolve_ontology(ontology_version)
    if not resolution.ok:
        return {
            "ok": False,
            "error": f"Unsupported ontology version: {ontology_version}",
            "result": resolution.result,
            "exit_code": exit_code_for(resolution.result or Result.VERSION_UNSUPPORTED),
        }

    catalog = resolution.artifacts.get("fields") or _load_field_catalog(ontology_version)
    artifact_catalog = resolution.artifacts.get("artifact_fields") or load_ontology_artifact(
        ontology_version, "artifact-fields.yaml"
    )
    index = _index_fields(catalog)
    artifact_index = _index_fields(artifact_catalog)

    # Allow artifact.<path> prefix for disambiguation
    norm = field_path.rstrip("[]")
    manifest_kind = "security_manifest"
    entry = None
    if norm.startswith("artifact."):
        norm = norm[len("artifact.") :]
        entry = artifact_index.get(norm)
        manifest_kind = "artifact_manifest"
    else:
        entry = index.get(field_path) or index.get(norm)
        if entry is None and norm in artifact_index:
            entry = artifact_index.get(norm)
            manifest_kind = "artifact_manifest"

    schema = resolution.artifacts.get("schema") or load_ontology_artifact(
        ontology_version, "manifest.schema.json"
    )
    schema_node = _walk_schema(schema, norm) if manifest_kind == "security_manifest" else None

    if entry is None and schema_node is None:
        return {
            "ok": False,
            "error": f"Unknown field: {field_path}",
            "hint": (
                "Security Manifest 字段见 §6.1/§6.2；Artifact Manifest 字段见 §6.3 "
                "(可用 artifact.spec.entrypoint 等形式查询)。"
            ),
            "exit_code": 11,
        }

    filler = (entry or {}).get("filler")
    if filler is None:
        filler = "security_core" if norm in DERIVED_FIELDS or any(
            x in norm for x in ("calculated_", "triggered_rule", "calculation_")
        ) else "creator"

    required = (entry or {}).get("required")
    if required is None and manifest_kind == "security_manifest":
        required = _is_required_in_schema(schema, norm)

    enum = (entry or {}).get("enum")
    if enum is None and isinstance(schema_node, dict):
        enum = schema_node.get("enum") or (
            [schema_node["const"]] if "const" in schema_node else None
        )

    field_mode = (entry or {}).get("mode")
    global_mode = schema.get("x-mode-required") or {} if manifest_kind == "security_manifest" else {}
    if manifest_kind == "artifact_manifest":
        mode_constraints = {
            "note": "Artifact Manifest 为制品主清单；与 Security Manifest 关键字段必须一致。",
            "PREVALIDATION": {"required": bool(required)},
            "FREEZE": {"required": bool(required)},
            "FORMAL_TEST": {"required": bool(required)},
        }
    else:
        mode_constraints = {
            "field": field_mode,
            "global": global_mode,
            "PREVALIDATION": {
                "allow_deferred": norm == "provenance.checksum",
                "allow_required_input": filler == "creator",
                "required": bool(required) if not (entry or {}).get("derived") else False,
            },
            "FREEZE": {
                "allow_deferred": False,
                "allow_required_input": False,
                "required": bool(required) or norm in FORMAL_EXTRA_REQUIRED,
            },
            "FORMAL_TEST": {
                "allow_deferred": False,
                "allow_required_input": False,
                "required": bool(required) or norm in FORMAL_EXTRA_REQUIRED,
            },
        }

    meaning = (entry or {}).get("meaning")
    ftype = (entry or {}).get("type") or (schema_node or {}).get("type") or ("enum" if enum else None)

    return {
        "ok": True,
        "field": norm,
        "manifest_kind": manifest_kind,
        "target_file": (
            "artifact.yaml"
            if manifest_kind == "artifact_manifest"
            else "references/security-manifest.yaml"
        ),
        "meaning": meaning,
        "type": ftype,
        "required": bool(required) if required is not None else None,
        "filler": filler,
        "enum": enum,
        "mode_constraints": mode_constraints,
        "含义": meaning,
        "类型": ftype,
        "是否必填": bool(required) if required is not None else None,
        "填写责任": filler,
        "枚举范围": enum,
        "mode约束": mode_constraints,
        "const": (entry or {}).get("const", (schema_node or {}).get("const")),
        "derived": bool((entry or {}).get("derived", False)),
        "ontology_version": ontology_version,
        "exit_code": 0,
    }


def list_required_fields(ontology_version: str) -> dict[str, Any]:
    """分别返回 PREVALIDATION、FREEZE、FORMAL_TEST 的必填字段清单。"""
    resolution = resolve_ontology(ontology_version)
    if not resolution.ok:
        return {
            "ok": False,
            "result": resolution.result,
            "exit_code": exit_code_for(resolution.result or Result.VERSION_UNSUPPORTED),
            "findings": [f.to_dict() for f in resolution.findings],
        }

    catalog = resolution.artifacts.get("fields") or _load_field_catalog(ontology_version)
    artifact_catalog = resolution.artifacts.get("artifact_fields") or load_ontology_artifact(
        ontology_version, "artifact-fields.yaml"
    )
    base = _declaration_required_paths(catalog)
    artifact_required = []
    for f in artifact_catalog.get("fields") or []:
        if not f.get("required") or not f.get("path"):
            continue
        # skip pure group containers that only document nested meaning
        if f["path"] in (
            "metadata",
            "spec.implementation",
            "spec.security",
            "spec.contracts",
            "spec.tests",
            "spec.lifecycle",
        ):
            continue
        artifact_required.append(f"artifact.{f['path']}")

    prevalidation = list(base)
    freeze = list(base)
    formal = list(base) + [p for p in FORMAL_EXTRA_REQUIRED if p not in base]

    return {
        "ok": True,
        "ontology_version": ontology_version,
        "PREVALIDATION": prevalidation,
        "FREEZE": freeze,
        "FORMAL_TEST": formal,
        "artifact_manifest_required": artifact_required,
        "notes": {
            "PREVALIDATION": (
                "声明字段必填；provenance.checksum 允许 DEFERRED_UNTIL_FREEZE；"
                "风险关键字段可用 REQUIRED_INPUT → NEEDS_INPUT。"
            ),
            "FREEZE": (
                "与 PREVALIDATION 声明必填相同，但禁止 DEFERRED/REQUIRED_INPUT；"
                "provenance.checksum 由 Security Core 在冻结时写入。"
            ),
            "FORMAL_TEST": (
                "与 FREEZE 相同。"
                "注意：risk 五维派生（calculated/effective/…）已停用，不要求也不计算派生风险字段。"
            ),
            "artifact_manifest": (
                "§6.3 根目录 artifact.yaml 必填字段；manifest.yaml 由其单向生成。"
            ),
            "risk_derivation": "disabled",
        },
        "exit_code": 0,
    }


def list_supported_versions() -> dict[str, Any]:
    """返回 current、supported、deprecated-but-supported 和 unsupported。"""
    raw = _list_versions_raw()
    return {
        "ok": True,
        "current": raw.get("current", []),
        "supported": raw.get("supported", []),
        "deprecated-but-supported": raw.get("deprecated-but-supported", []),
        "unsupported": raw.get("unsupported", []),
        "exit_code": 0,
    }


def get_defaults(ontology_version: str) -> dict[str, Any]:
    """返回安全默认值，但不主动写入业务事实或派生结论。"""
    resolution = resolve_ontology(ontology_version)
    if not resolution.ok:
        return {
            "ok": False,
            "result": resolution.result,
            "exit_code": exit_code_for(resolution.result or Result.VERSION_UNSUPPORTED),
            "findings": [f.to_dict() for f in resolution.findings],
        }

    template = deepcopy(resolution.artifacts["template"])
    catalog = resolution.artifacts.get("fields") or _load_field_catalog(ontology_version)

    # Only safe defaults — never business facts / derived conclusions
    defaults: dict[str, Any] = {
        "security_ontology.id": "cogseed.security.skill",
        "security_ontology.version": ontology_version,
        "manifest_version": template.get("manifest_version", ontology_version),
        "data_security.secrets_allowed": False,
        "data_security.pii_allowed": False,
        "data_security.external_transmission": False,
        "data_security.retention_days": 0,
        "network.enabled": False,
        "network.allowlist": [],
        "network.deny_private_network": True,
        "network.allow_dynamic_download": False,
        "runtime_boundary.direct_resource_access": False,
        "runtime_boundary.access_via_gateway_only": True,
        "runtime_boundary.binding_resolved_by": "agent_layer",
        "runtime_boundary.audit_emitted_by": "runtime",
        "provenance.checksum": "DEFERRED_UNTIL_FREEZE",
        "permissions.required": [],
        "permissions.prohibited": [],
        "resources.allowed": [],
        "resources.denied": [],
        "actions.allowed": [],
        "actions.prohibited": [],
        "dependencies.packages": [],
        "dependencies.external_tools": [],
    }

    # Catalog-declared defaults
    for f in catalog.get("fields") or []:
        if f.get("default") is not None and f.get("path"):
            defaults[f["path"]] = f["default"]
        if f.get("const") is not None and f.get("path"):
            defaults[f["path"]] = f["const"]

    return {
        "ok": True,
        "ontology_version": ontology_version,
        "defaults": defaults,
        "do_not_write": {
            "business_facts": [
                "skill.id",
                "skill.name",
                "skill.description",
                "ownership.*",
                "provenance.source_uri",
                "provenance.author",
                "risk.risk_level",
                "risk.trust_level",
                "risk.maximum_impact",
                "risk.risk_reasons",
            ],
            "derived_conclusions": DERIVED_FIELDS,
        },
        "template_includes_derived_fields": DERIVED_FIELDS,
        "note": (
            "仅返回安全默认值；3.1 不写入业务事实或派生结论。"
            "§6.2 派生字段已包含在 get-template 的 risk.* 中，占位为 null/[]，由 Security Core 填充。"
        ),
        "exit_code": 0,
    }


def get_rule_index(ontology_version: str) -> dict[str, Any]:
    """返回 derivation、trust、consistency、warning、digest 规则版本和 rule_id 索引。"""
    resolution = resolve_ontology(ontology_version)
    if not resolution.ok:
        return {
            "ok": False,
            "result": resolution.result,
            "exit_code": exit_code_for(resolution.result or Result.VERSION_UNSUPPORTED),
            "findings": [f.to_dict() for f in resolution.findings],
        }

    ontology = resolution.artifacts["ontology"]
    base = ontology.get("rule_index") or {}

    derivation = resolution.artifacts["derivation_rules"]
    trust = resolution.artifacts["trust_rules"]
    consistency = resolution.artifacts["consistency_rules"]
    warning = resolution.artifacts["warning_policy"]
    digest = resolution.artifacts["digest_profile"]

    return {
        "ok": True,
        "ontology_version": ontology_version,
        "derivation": {
            "policy_version": (base.get("derivation") or {}).get("policy_version")
            or derivation.get("policy_version"),
            "file": (base.get("derivation") or {}).get("file", "derivation-rules.yaml"),
            "rule_ids": _extract_rule_ids(derivation),
        },
        "trust": {
            "policy_version": (base.get("trust") or {}).get("policy_version")
            or trust.get("policy_version"),
            "file": (base.get("trust") or {}).get("file", "trust-rules.yaml"),
            "rule_ids": _extract_rule_ids(trust),
        },
        "consistency": {
            "policy_version": (base.get("consistency") or {}).get("policy_version")
            or consistency.get("policy_version"),
            "file": (base.get("consistency") or {}).get("file", "consistency-rules.yaml"),
            "rule_ids": _extract_rule_ids(consistency),
        },
        "warning": {
            "policy_version": (base.get("warning") or {}).get("policy_version")
            or warning.get("policy_version"),
            "file": (base.get("warning") or {}).get("file", "warning-policy.yaml"),
            "rule_ids": _extract_rule_ids(warning),
        },
        "digest": {
            "policy_version": (base.get("digest") or {}).get("policy_version"),
            "profile_ref": digest.get("ref")
            or (base.get("digest") or {}).get("profile_ref"),
            "file": (base.get("digest") or {}).get("file", "digest-profile.yaml"),
            "rule_ids": ["SEC-DIGEST-001", "SEC-DIGEST-002", "SEC-FREEZE-READINESS-001"],
        },
        "exit_code": 0,
    }


# Optional helper (not in §6 table) — browse field catalog backing describe-field
def list_fields(
    ontology_version: str,
    *,
    only_required: bool | None = None,
    filler: str | None = None,
) -> dict[str, Any]:
    catalog = _load_field_catalog(ontology_version)
    rows = []
    for f in catalog.get("fields") or []:
        if only_required is True and not f.get("required"):
            continue
        if only_required is False and f.get("required"):
            continue
        if filler and f.get("filler") != filler:
            continue
        rows.append(
            {
                "path": f.get("path"),
                "type": f.get("type"),
                "required": bool(f.get("required")),
                "filler": f.get("filler"),
                "meaning": f.get("meaning"),
                "enum": f.get("enum"),
                "derived": bool(f.get("derived", False)),
            }
        )
    return {
        "ok": True,
        "ontology_version": ontology_version,
        "count": len(rows),
        "fields": rows,
        "note": "辅助浏览；文档 §6 正式能力为 describe-field / list-required-fields。",
    }
