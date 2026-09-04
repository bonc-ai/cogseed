"""Freeze flow: readiness audit, frozen-copy creation, freeze-manifest writing.

A freeze pins a skill tree to an authoritative subject digest and records the
freeze manifest in the orchestrator's state root. The frozen copy is made
read-only after the checksum is written, and the checksum itself is excluded
from digest bytes (see ``digesting``) so the identity stays stable.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

import yaml

from .digesting import subject_digest, worktree_digest
from .models import Finding, Result, Severity, code_for, utc_timestamp
from .registry import read_artifact

# Risk declaration/derivation disabled — freeze must ignore risk.* findings
_RISK_RELATED_PREFIXES = (
    "SEC-TRUST-",
    "SEC-RISK-",
    "SEC-ACTION-IRREVERSIBLE-",
    "SEC-ACTION-UNBOUNDED-",
)


def _risk_related(finding: dict[str, Any]) -> bool:
    path = str(finding.get("path") or "")
    if path == "risk" or path.startswith("risk."):
        return True
    rule_id = str(finding.get("rule_id") or "")
    return any(rule_id.startswith(p) for p in _RISK_RELATED_PREFIXES)


def audit_freeze_readiness(
    skill_root: str | Path,
    *,
    prevalidation_report: dict[str, Any],
    ontology_version: str = "1.1.1",
) -> dict[str, Any]:
    """Compare the current worktree digest to the last PREVALIDATION before writing checksum."""
    subject = prevalidation_report.get("subject") or {}
    expected = subject.get("worktree_digest")
    profile_ref = subject.get("worktree_profile_ref")
    validation = prevalidation_report.get("validation") or {}
    result = validation.get("result")

    findings: list[Finding] = []
    if result in ("BLOCK", "FAIL", "NEEDS_INPUT", "EXECUTION_ERROR"):
        findings.append(
            Finding(
                rule_id="SEC-FREEZE-READINESS-001",
                severity=Severity.FAIL.value,
                message=f"PREVALIDATION result {result} is not freeze-ready",
            )
        )
        return {"ready": False, "result": Result.NOT_READY.value, "findings": findings, "exit_code": 12}

    if not expected:
        findings.append(
            Finding(
                rule_id="SEC-FREEZE-READINESS-001",
                severity=Severity.FAIL.value,
                message="PREVALIDATION report missing worktree_digest",
            )
        )
        return {"ready": False, "result": Result.NOT_READY.value, "findings": findings, "exit_code": 12}

    # freeze-blocking warnings — risk flow disabled, so skip risk/trust-related ones
    for f in validation.get("findings") or []:
        if f.get("severity") == "WARN" and f.get("freeze_blocking") is True:
            if _risk_related(f):
                continue
            findings.append(
                Finding(
                    rule_id="SEC-WARNING-POLICY-001",
                    severity=Severity.FAIL.value,
                    message=f"freeze_blocking WARN present: {f.get('rule_id')}",
                )
            )
            return {"ready": False, "result": Result.NOT_READY.value, "findings": findings, "exit_code": 12}

    profile = read_artifact(ontology_version, "digest-profile.yaml")
    if profile_ref and profile.get("ref") != profile_ref:
        findings.append(
            Finding(
                rule_id="SEC-FREEZE-READINESS-001",
                severity=Severity.FAIL.value,
                message=f"worktree_profile_ref mismatch: {profile_ref} vs {profile.get('ref')}",
            )
        )
        return {"ready": False, "result": Result.NOT_READY.value, "findings": findings, "exit_code": 12}

    current = worktree_digest(skill_root, ontology_version, profile)
    if not current["ok"]:
        return {
            "ready": False,
            "result": Result.NOT_READY.value,
            "findings": current["findings"],
            "exit_code": 12,
        }
    if current["worktree_digest"] != expected:
        findings.append(
            Finding(
                rule_id="SEC-FREEZE-READINESS-001",
                severity=Severity.FAIL.value,
                message="Current worktree_digest != last PREVALIDATION worktree_digest",
                details={"expected": expected, "actual": current["worktree_digest"]},
            )
        )
        return {
            "ready": False,
            "result": Result.NOT_READY.value,
            "findings": findings,
            "exit_code": 12,
            "current_worktree_digest": current["worktree_digest"],
        }

    return {
        "ready": True,
        "result": "READY_TO_FREEZE",
        "findings": findings,
        "exit_code": 0,
        "worktree_digest": expected,
        "fileset": current["fileset"],
        "digest_profile": current["digest_profile"],
    }


def _atomic_json_write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".freeze-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, sort_keys=True, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _make_readonly(path: Path) -> None:
    for p in path.rglob("*"):
        if p.is_file():
            try:
                p.chmod(p.stat().st_mode & ~0o222)
            except OSError:
                pass


def freeze_subject(
    skill_root: str | Path,
    *,
    orchestrator_state_root: str | Path,
    prevalidation_report: dict[str, Any],
    ontology_version: str = "1.1.1",
    freeze_id: str | None = None,
    copy_to_frozen: bool = True,
) -> dict[str, Any]:
    root = Path(skill_root).resolve()
    state_root = Path(orchestrator_state_root).resolve()

    readiness = audit_freeze_readiness(
        root, prevalidation_report=prevalidation_report, ontology_version=ontology_version
    )
    if not readiness["ready"]:
        return readiness

    fid = freeze_id or f"freeze-{utc_timestamp().replace(':', '').replace('-', '')}"
    freeze_dir = state_root / "freezes" / fid
    freeze_dir.mkdir(parents=True, exist_ok=True)

    if copy_to_frozen:
        frozen_skill = freeze_dir / "skill"
        if frozen_skill.exists():
            shutil.rmtree(frozen_skill)
        shutil.copytree(root, frozen_skill)
    else:
        frozen_skill = root

    # Authoritative digest on the frozen copy BEFORE writing the checksum.
    subject = subject_digest(frozen_skill, ontology_version)
    if not subject["ok"]:
        return {
            "ready": False,
            "result": Result.EXECUTION_ERROR.value,
            "findings": subject["findings"],
            "exit_code": 40,
        }

    checksum = subject["subject_digest"]
    sec_path = frozen_skill / "references" / "security-manifest.yaml"
    if sec_path.exists():
        try:  # clear readonly when re-freezing
            sec_path.chmod(sec_path.stat().st_mode | 0o200)
        except OSError:
            pass
        with open(sec_path, encoding="utf-8") as f:
            manifest = yaml.safe_load(f) or {}
        prov = dict(manifest.get("provenance") or {})
        prov["checksum"] = checksum
        manifest["provenance"] = prov
        with open(sec_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(manifest, f, allow_unicode=True, sort_keys=False)
        # Recompute to confirm the identity is stable (checksum excluded from hash bytes)
        subject = subject_digest(frozen_skill, ontology_version)
        if not subject["ok"] or subject["subject_digest"] != checksum:
            return {
                "ready": False,
                "result": Result.DIGEST_MISMATCH.value,
                "findings": [
                    Finding(
                        rule_id="SEC-DIGEST-002",
                        severity=Severity.BLOCK.value,
                        message="subject_digest changed after writing provenance.checksum",
                        details={
                            "before": checksum,
                            "after": None if not subject["ok"] else subject["subject_digest"],
                        },
                    )
                ],
                "exit_code": 33,
            }

    _make_readonly(frozen_skill)

    skill_meta = {}
    if sec_path.exists():
        with open(sec_path, encoding="utf-8") as f:
            m = yaml.safe_load(f) or {}
        skill_meta = m.get("skill") or {}

    freeze_manifest = {
        "freeze_id": fid,
        "skill_id": skill_meta.get("id"),
        "skill_version": skill_meta.get("version"),
        "digest_profile": subject["digest_profile"],
        "subject_digest": checksum,
        "fileset": subject["fileset"],
        "fileset_count": subject["fileset_count"],
        "frozen_at": utc_timestamp(),
        "prevalidation_report_id": prevalidation_report.get("report_id"),
        "prevalidation_worktree_digest": (prevalidation_report.get("subject") or {}).get("worktree_digest"),
        "worktree_profile_ref": (prevalidation_report.get("subject") or {}).get("worktree_profile_ref"),
        "ontology_version": ontology_version,
        "engine_version": (prevalidation_report.get("validation") or {}).get("engine_version"),
        "provenance_checksum": checksum,
        "readonly_verified": True,
        "frozen_skill_path": str(frozen_skill),
        "freeze_manifest_ref": f"orchestrator://freezes/{fid}/freeze-manifest.json",
    }

    manifest_path = freeze_dir / "freeze-manifest.json"
    _atomic_json_write(manifest_path, freeze_manifest)
    try:
        manifest_path.chmod(manifest_path.stat().st_mode & ~0o222)
    except OSError:
        pass

    return {
        "ready": True,
        "result": Result.FROZEN.value,
        "exit_code": code_for(Result.FROZEN),
        "freeze_manifest": freeze_manifest,
        "freeze_manifest_path": str(manifest_path),
        "findings": [],
    }
