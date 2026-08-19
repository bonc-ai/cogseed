"""Exact Ontology / Engine / digest profile resolution."""

from __future__ import annotations

from typing import Any

from .paths import engine_version, load_ontology_artifact, ontology_dir
from .result_models import Finding, Result, Severity


class VersionResolution:
    def __init__(
        self,
        *,
        ok: bool,
        ontology_version: str,
        engine_version: str,
        status: str,
        findings: list[Finding],
        result: str | None = None,
        artifacts: dict[str, Any] | None = None,
    ):
        self.ok = ok
        self.ontology_version = ontology_version
        self.engine_version = engine_version
        self.status = status
        self.findings = findings
        self.result = result
        self.artifacts = artifacts or {}


def resolve_ontology(ontology_version: str, *, ontology_id: str = "cogseed.security.skill") -> VersionResolution:
    eng = engine_version()
    findings: list[Finding] = []
    try:
        ontology_dir(ontology_version)
    except FileNotFoundError:
        findings.append(
            Finding(
                rule_id="SEC-ONTOLOGY-002",
                severity=Severity.BLOCK.value,
                message=f"Unsupported ontology version: {ontology_version}",
            )
        )
        return VersionResolution(
            ok=False,
            ontology_version=ontology_version,
            engine_version=eng,
            status="unsupported",
            findings=findings,
            result=Result.VERSION_UNSUPPORTED.value,
        )

    ontology = load_ontology_artifact(ontology_version, "ontology.yaml")
    policy = load_ontology_artifact(ontology_version, "version-policy.yaml")

    if ontology.get("id") != ontology_id:
        findings.append(
            Finding(
                rule_id="SEC-ONTOLOGY-001",
                severity=Severity.BLOCK.value,
                message=f"Ontology id must be {ontology_id}",
            )
        )
        return VersionResolution(
            ok=False,
            ontology_version=ontology_version,
            engine_version=eng,
            status="invalid",
            findings=findings,
            result=Result.BLOCK.value,
        )

    if ontology_version in policy.get("unsupported", []):
        return VersionResolution(
            ok=False,
            ontology_version=ontology_version,
            engine_version=eng,
            status="unsupported",
            findings=[
                Finding(
                    rule_id="SEC-ONTOLOGY-002",
                    severity=Severity.BLOCK.value,
                    message=f"Ontology {ontology_version} is unsupported",
                )
            ],
            result=Result.VERSION_UNSUPPORTED.value,
        )

    if eng not in policy.get("engine", {}).get("supported", [eng]):
        return VersionResolution(
            ok=False,
            ontology_version=ontology_version,
            engine_version=eng,
            status="engine_mismatch",
            findings=[
                Finding(
                    rule_id="SEC-ONTOLOGY-002",
                    severity=Severity.BLOCK.value,
                    message=f"Engine {eng} not compatible with ontology {ontology_version}",
                )
            ],
            result=Result.VERSION_UNSUPPORTED.value,
        )

    status = "current"
    if ontology_version in policy.get("deprecated_but_supported", []):
        status = "deprecated-but-supported"
        findings.append(
            Finding(
                rule_id="ONTOLOGY-DEPRECATED-SUPPORTED-001",
                severity=Severity.WARN.value,
                message=f"Ontology {ontology_version} is deprecated-but-supported",
            )
        )
    elif ontology_version in policy.get("supported", []) or ontology_version in policy.get("current", []):
        status = "current" if ontology_version in policy.get("current", []) else "supported"
    else:
        return VersionResolution(
            ok=False,
            ontology_version=ontology_version,
            engine_version=eng,
            status="unsupported",
            findings=[
                Finding(
                    rule_id="SEC-ONTOLOGY-002",
                    severity=Severity.BLOCK.value,
                    message=f"Ontology {ontology_version} not in version-policy",
                )
            ],
            result=Result.VERSION_UNSUPPORTED.value,
        )

    artifacts = {
        "ontology": ontology,
        "version_policy": policy,
        "schema": load_ontology_artifact(ontology_version, "manifest.schema.json"),
        "template": load_ontology_artifact(ontology_version, "security-manifest.template.yaml"),
        "fields": load_ontology_artifact(ontology_version, "manifest-fields.yaml"),
        "artifact_template": load_ontology_artifact(
            ontology_version, "artifact-manifest.template.yaml"
        ),
        "artifact_fields": load_ontology_artifact(ontology_version, "artifact-fields.yaml"),
        "compatibility_template": load_ontology_artifact(
            ontology_version, "compatibility-manifest.template.yaml"
        ),
        "derivation_rules": load_ontology_artifact(ontology_version, "derivation-rules.yaml"),
        "trust_rules": load_ontology_artifact(ontology_version, "trust-rules.yaml"),
        "consistency_rules": load_ontology_artifact(ontology_version, "consistency-rules.yaml"),
        "warning_policy": load_ontology_artifact(ontology_version, "warning-policy.yaml"),
        "digest_profile": load_ontology_artifact(ontology_version, "digest-profile.yaml"),
    }
    return VersionResolution(
        ok=True,
        ontology_version=ontology_version,
        engine_version=eng,
        status=status,
        findings=findings,
        artifacts=artifacts,
    )


def list_supported_versions() -> dict[str, Any]:
    # Enumerate snapshots on disk and merge with latest policy
    from .paths import ONTOLOGY_ROOT

    versions = sorted([p.name for p in ONTOLOGY_ROOT.iterdir() if p.is_dir()])
    if not versions:
        return {
            "current": [],
            "supported": [],
            "deprecated-but-supported": [],
            "unsupported": [],
        }
    latest = versions[-1]
    policy = load_ontology_artifact(latest, "version-policy.yaml")
    return {
        "current": policy.get("current", []),
        "supported": policy.get("supported", []),
        "deprecated-but-supported": policy.get("deprecated_but_supported", []),
        "unsupported": policy.get("unsupported", []),
        "on_disk": versions,
    }
