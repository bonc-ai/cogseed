"""Freeze readiness, freeze_id generation, freeze manifest writing."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

import yaml

from .digest import compute_subject_digest, compute_worktree_digest
from .paths import load_ontology_artifact
from .result_models import Finding, Result, Severity, exit_code_for, utc_now_z

# Risk declaration/derivation temporarily disabled — freeze must ignore risk.* findings
_RISK_FREEZE_IGNORE_RULE_PREFIXES = (
    "SEC-TRUST-",
    "SEC-RISK-",
    "SEC-ACTION-IRREVERSIBLE-",
    "SEC-ACTION-UNBOUNDED-",
)


def _is_risk_related_finding(finding: dict[str, Any]) -> bool:
    path = str(finding.get("path") or "")
    if path == "risk" or path.startswith("risk."):
        return True
    rule_id = str(finding.get("rule_id") or "")
    return any(rule_id.startswith(p) for p in _RISK_FREEZE_IGNORE_RULE_PREFIXES)


def check_freeze_readiness(
    skill_root: str | Path,
    *,
    prevalidation_report: dict[str, Any],
    ontology_version: str = "1.1.1",
) -> dict[str, Any]:
    """Compare current worktree digest to last PREVALIDATION before writing checksum."""
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

    # freeze_blocking warnings — skip risk.* / trust-risk path (risk flow disabled)
    for f in validation.get("findings") or []:
        if f.get("severity") == "WARN" and f.get("freeze_blocking") is True:
            if _is_risk_related_finding(f):
                continue
            findings.append(
                Finding(
                    rule_id="SEC-WARNING-POLICY-001",
                    severity=Severity.FAIL.value,
                    message=f"freeze_blocking WARN present: {f.get('rule_id')}",
                )
            )
            return {"ready": False, "result": Result.NOT_READY.value, "findings": findings, "exit_code": 12}

    profile = load_ontology_artifact(ontology_version, "digest-profile.yaml")
    if profile_ref and profile.get("ref") != profile_ref:
        findings.append(
            Finding(
                rule_id="SEC-FREEZE-READINESS-001",
                severity=Severity.FAIL.value,
                message=f"worktree_profile_ref mismatch: {profile_ref} vs {profile.get('ref')}",
            )
        )
        return {"ready": False, "result": Result.NOT_READY.value, "findings": findings, "exit_code": 12}

    current = compute_worktree_digest(skill_root, ontology_version, profile)
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


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
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


def _set_readonly_tree(path: Path) -> None:
    for p in path.rglob("*"):
        if p.is_file():
            try:
                mode = p.stat().st_mode
                p.chmod(mode & ~0o222)
            except OSError:
                pass


def freeze_skill(
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
    readiness = check_freeze_readiness(root, prevalidation_report=prevalidation_report, ontology_version=ontology_version)
    if not readiness["ready"]:
        return readiness

    fid = freeze_id or f"freeze-{utc_now_z().replace(':', '').replace('-', '')}"
    freeze_dir = state_root / "freezes" / fid
    freeze_dir.mkdir(parents=True, exist_ok=True)

    frozen_skill = freeze_dir / "skill"
    if copy_to_frozen:
        if frozen_skill.exists():
            shutil.rmtree(frozen_skill)
        shutil.copytree(root, frozen_skill)
    else:
        frozen_skill = root

    # Compute authoritative digest on frozen copy BEFORE writing checksum into working tree?
    # Spec: write provenance.checksum during freeze on the frozen object.
    subject = compute_subject_digest(frozen_skill, ontology_version)
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
        # Clear readonly if re-freezing
        try:
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
        # Recompute to confirm digest is stable (checksum excluded from hash bytes)
        subject = compute_subject_digest(frozen_skill, ontology_version)
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

    _set_readonly_tree(frozen_skill)

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
        "frozen_at": utc_now_z(),
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
    _atomic_write_json(manifest_path, freeze_manifest)
    try:
        manifest_path.chmod(manifest_path.stat().st_mode & ~0o222)
    except OSError:
        pass

    return {
        "ready": True,
        "result": Result.FROZEN.value,
        "exit_code": exit_code_for(Result.FROZEN),
        "freeze_manifest": freeze_manifest,
        "freeze_manifest_path": str(manifest_path),
        "findings": [],
    }
