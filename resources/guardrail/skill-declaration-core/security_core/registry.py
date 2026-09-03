"""Ontology snapshot registry: artifact loading and version-policy resolution.

The engine is data-driven: every rule table (fields, trust, consistency,
warnings, digest profile, …) lives in a versioned snapshot directory under
``ontologies/cogseed.security.skill/<version>/``. This module is the single
door through which snapshots are located, loaded and version-checked.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from .models import Finding, Result, Severity

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
ONTOLOGY_ROOT = PACKAGE_ROOT / "ontologies" / "cogseed.security.skill"

ONTOLOGY_ID = "cogseed.security.skill"

_ARTIFACT_NAMES = (
    "ontology.yaml",
    "version-policy.yaml",
    "manifest.schema.json",
    "security-manifest.template.yaml",
    "manifest-fields.yaml",
    "artifact-manifest.template.yaml",
    "artifact-fields.yaml",
    "compatibility-manifest.template.yaml",
    "derivation-rules.yaml",
    "trust-rules.yaml",
    "consistency-rules.yaml",
    "warning-policy.yaml",
    "digest-profile.yaml",
)


@dataclass
class SnapshotResolution:
    ok: bool
    ontology_version: str
    engine_version: str
    status: str
    findings: list[Finding]
    result: str | None = None
    artifacts: dict[str, Any] = field(default_factory=dict)


def engine_build_version() -> str:
    return (PACKAGE_ROOT / "VERSION").read_text(encoding="utf-8").strip()


def snapshot_dir(version: str) -> Path:
    path = ONTOLOGY_ROOT / version
    if not path.is_dir():
        raise FileNotFoundError(f"Ontology snapshot not found: {version}")
    return path


@lru_cache(maxsize=64)
def _read_text(path_str: str) -> Any:
    path = Path(path_str)
    with open(path, encoding="utf-8") as f:
        return json.load(f) if path.suffix == ".json" else yaml.safe_load(f)


def read_artifact(version: str, name: str) -> Any:
    path = snapshot_dir(version) / name
    if not path.exists():
        raise FileNotFoundError(path)
    return _read_text(str(path))


def read_exit_code_registry() -> dict[str, Any]:
    return _read_text(str(PACKAGE_ROOT / "exit-code-registry.yaml"))


def _finding(rule_id: str, message: str) -> Finding:
    return Finding(rule_id=rule_id, severity=Severity.BLOCK.value, message=message)


def resolve_snapshot(ontology_version: str) -> SnapshotResolution:
    """Resolve a requested ontology version against disk and version policy."""
    eng = engine_build_version()

    try:
        snapshot_dir(ontology_version)
    except FileNotFoundError:
        return SnapshotResolution(
            ok=False,
            ontology_version=ontology_version,
            engine_version=eng,
            status="unsupported",
            findings=[_finding("SEC-ONTOLOGY-002", f"Unsupported ontology version: {ontology_version}")],
            result=Result.VERSION_UNSUPPORTED.value,
        )

    ontology = read_artifact(ontology_version, "ontology.yaml")
    policy = read_artifact(ontology_version, "version-policy.yaml")

    if ontology.get("id") != ONTOLOGY_ID:
        return SnapshotResolution(
            ok=False,
            ontology_version=ontology_version,
            engine_version=eng,
            status="invalid",
            findings=[_finding("SEC-ONTOLOGY-001", f"Ontology id must be {ONTOLOGY_ID}")],
            result=Result.BLOCK.value,
        )

    if ontology_version in policy.get("unsupported", []):
        return SnapshotResolution(
            ok=False,
            ontology_version=ontology_version,
            engine_version=eng,
            status="unsupported",
            findings=[_finding("SEC-ONTOLOGY-002", f"Ontology {ontology_version} is unsupported")],
            result=Result.VERSION_UNSUPPORTED.value,
        )

    if eng not in policy.get("engine", {}).get("supported", [eng]):
        return SnapshotResolution(
            ok=False,
            ontology_version=ontology_version,
            engine_version=eng,
            status="engine_mismatch",
            findings=[
                _finding(
                    "SEC-ONTOLOGY-002",
                    f"Engine {eng} not compatible with ontology {ontology_version}",
                )
            ],
            result=Result.VERSION_UNSUPPORTED.value,
        )

    current = policy.get("current", [])
    supported = policy.get("supported", [])
    deprecated = policy.get("deprecated_but_supported", [])
    if ontology_version in deprecated:
        status = "deprecated-but-supported"
        findings = [
            Finding(
                rule_id="ONTOLOGY-DEPRECATED-SUPPORTED-001",
                severity=Severity.WARN.value,
                message=f"Ontology {ontology_version} is deprecated-but-supported",
            )
        ]
    elif ontology_version in current or ontology_version in supported:
        status = "current" if ontology_version in current else "supported"
        findings = []
    else:
        return SnapshotResolution(
            ok=False,
            ontology_version=ontology_version,
            engine_version=eng,
            status="unsupported",
            findings=[_finding("SEC-ONTOLOGY-002", f"Ontology {ontology_version} not in version-policy")],
            result=Result.VERSION_UNSUPPORTED.value,
        )

    artifacts = {name: read_artifact(ontology_version, name) for name in _ARTIFACT_NAMES}
    return SnapshotResolution(
        ok=True,
        ontology_version=ontology_version,
        engine_version=eng,
        status=status,
        findings=findings,
        artifacts=artifacts,
    )


def available_versions() -> dict[str, Any]:
    versions = sorted(p.name for p in ONTOLOGY_ROOT.iterdir() if p.is_dir())
    if not versions:
        return {
            "current": [],
            "supported": [],
            "deprecated-but-supported": [],
            "unsupported": [],
        }
    policy = read_artifact(versions[-1], "version-policy.yaml")
    return {
        "current": policy.get("current", []),
        "supported": policy.get("supported", []),
        "deprecated-but-supported": policy.get("deprecated_but_supported", []),
        "unsupported": policy.get("unsupported", []),
        "on_disk": versions,
    }
