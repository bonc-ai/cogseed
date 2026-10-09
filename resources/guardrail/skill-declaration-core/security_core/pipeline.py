"""The declaration pipeline: one entry that runs a skill through every stage.

Stages, in order: manifest load → ontology snapshot resolution → (formal-mode
frozen digest pre-check) → completeness → trust posture → coherence →
warning policy → mode-specific digest computation → report assembly.

Every return value is a dict carrying at least ``report`` and ``exit_code``;
the numeric code is the contract consumed by the platform adapter, the report
is the machine-readable evidence.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .coherence import audit_coherence
from .completeness import audit_completeness
from .digesting import subject_digest as digest_subject, worktree_digest as digest_worktree
from .models import Finding, Result, Severity, code_for, compose_report, fold_verdict
from .registry import engine_build_version, resolve_snapshot
from .trusting import derive_trust_posture
from .warnrules import apply_advisory_policy

# Risk derivation (derive_risk_fields) intentionally not imported / not used.


def load_security_manifest(skill_root: Path) -> dict[str, Any]:
    path = skill_root / "references" / "security-manifest.yaml"
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _report_id_for(manifest: dict[str, Any], mode: str) -> str:
    skill = manifest.get("skill") or {}
    return f"val-{skill.get('id', 'unknown')}-{skill.get('version', '0')}-{mode.lower()}"


def _mutable_subject(manifest: dict[str, Any], mode: str, freeze_id, subject_digest, freeze_manifest) -> dict[str, Any]:
    if mode == "FORMAL_TEST":
        return _frozen_subject(manifest, freeze_id, freeze_manifest, subject_digest, {"fileset_count": 0})
    skill = manifest.get("skill") or {}
    return {
        "skill_id": skill.get("id"),
        "skill_version": skill.get("version"),
        "state": "MUTABLE",
        "subject_digest": None,
    }


def _frozen_subject(manifest, freeze_id, freeze_manifest, subject_digest, digest_result) -> dict[str, Any]:
    skill = manifest.get("skill") or {}
    fm = freeze_manifest or {}
    return {
        "skill_id": skill.get("id") or fm.get("skill_id"),
        "skill_version": skill.get("version") or fm.get("skill_version"),
        "state": "FROZEN",
        "freeze_id": freeze_id or fm.get("freeze_id"),
        "freeze_manifest_ref": fm.get("freeze_manifest_ref")
        or (f"orchestrator://freezes/{freeze_id}/freeze-manifest.json" if freeze_id else None),
        "digest_algorithm": "SHA-256",
        "digest_profile": fm.get("digest_profile")
        or (digest_result.get("digest_profile") if isinstance(digest_result, dict) else None),
        "subject_digest": subject_digest or fm.get("subject_digest"),
        "fileset_count": fm.get("fileset_count")
        or (digest_result.get("fileset_count") if isinstance(digest_result, dict) else 0),
        "frozen_at": fm.get("frozen_at"),
    }


def execute_validation(
    skill_root: str | Path,
    *,
    mode: str,
    ontology_version: str | None = None,
    freeze_id: str | None = None,
    freeze_manifest: dict[str, Any] | None = None,
    subject_digest: str | None = None,
    report_id: str | None = None,
    storage: str = "VALIDATOR_CONTROLLED",
) -> dict[str, Any]:
    root = Path(skill_root).resolve()
    mode = mode.upper()
    findings: list[Finding] = []

    try:
        manifest = load_security_manifest(root)
    except Exception as exc:  # noqa: BLE001
        report = compose_report(
            report_id=report_id or "val-error",
            mode=mode,
            subject={"state": "UNKNOWN"},
            result=Result.EXECUTION_ERROR.value,
            findings=[
                Finding(
                    rule_id="SEC-EXEC-001",
                    severity=Severity.BLOCK.value,
                    message=f"Cannot load security-manifest: {exc}",
                )
            ],
            ontology_version=ontology_version or "unknown",
            engine_version=engine_build_version(),
            storage=storage,
        )
        return {"report": report, "exit_code": 40, "stdout": report}

    ont_ver = ontology_version or (manifest.get("security_ontology") or {}).get("version") or "1.1.1"
    resolution = resolve_snapshot(ont_ver)
    findings.extend(resolution.findings)
    if not resolution.ok:
        result = resolution.result or Result.VERSION_UNSUPPORTED.value
        subject = _mutable_subject(manifest, mode, freeze_id, subject_digest, freeze_manifest)
        report = compose_report(
            report_id=report_id or _report_id_for(manifest, mode),
            mode=mode,
            subject=subject,
            result=result,
            findings=findings,
            ontology_version=ont_ver,
            engine_version=resolution.engine_version,
            storage=storage,
        )
        return {"report": report, "exit_code": code_for(result), "result": result}

    if mode == "FORMAL_TEST":
        if not freeze_manifest and not (freeze_id and subject_digest):
            findings.append(
                Finding(
                    rule_id="SEC-DIGEST-001",
                    severity=Severity.BLOCK.value,
                    message="FORMAL_TEST requires freeze_id/subject_digest or freeze_manifest",
                )
            )
        expected_digest = subject_digest or (freeze_manifest or {}).get("subject_digest")
        fid = freeze_id or (freeze_manifest or {}).get("freeze_id")
        before = digest_subject(root, ont_ver)
        if not before["ok"] or before["subject_digest"] != expected_digest:
            findings.append(
                Finding(
                    rule_id="SEC-DIGEST-001",
                    severity=Severity.BLOCK.value,
                    message="Pre-test subject_digest mismatch",
                    details={
                        "expected": expected_digest,
                        "actual": None if not before["ok"] else before["subject_digest"],
                    },
                )
            )
            result = Result.DIGEST_MISMATCH.value
            subject = _frozen_subject(manifest, fid, freeze_manifest, expected_digest, before)
            report = compose_report(
                report_id=report_id or _report_id_for(manifest, mode),
                mode=mode,
                subject=subject,
                result=result,
                findings=findings,
                ontology_version=ont_ver,
                engine_version=resolution.engine_version,
                storage=storage,
            )
            return {"report": report, "exit_code": 33, "result": result}

    completion = audit_completeness(manifest, ont_ver, mode=mode)
    findings.extend(completion["findings"])
    needs_input = bool(completion.get("needs_input"))

    # Risk derivation cancelled: no derived risk fields computed or compared.
    trust = derive_trust_posture(manifest, ont_ver, effective_risk=None)
    findings.extend(trust["findings"])

    coherence = audit_coherence(
        manifest,
        root,
        ont_ver,
        mode=mode,
        control_matrix=None,
        trust_modifier_approval=trust.get("trust_modifier_approval") or "none",
        subject_digest=subject_digest or (freeze_manifest or {}).get("subject_digest"),
        freeze_id=freeze_id or (freeze_manifest or {}).get("freeze_id"),
    )
    findings.extend(coherence["findings"])

    env = (manifest.get("skill") or {}).get("environment") or "development"
    findings = apply_advisory_policy(findings, ontology_version=ont_ver, mode=mode, environment=env)

    if mode == "PREVALIDATION":
        wt = digest_worktree(root, ont_ver)
        skill = manifest.get("skill") or {}
        if not wt["ok"]:
            findings.extend(wt["findings"])
            result = Result.BLOCK.value
            subject = {
                "skill_id": skill.get("id"),
                "skill_version": skill.get("version"),
                "state": "MUTABLE",
                "subject_digest": None,
                "worktree_digest": None,
                "worktree_profile_ref": wt.get("worktree_profile_ref"),
                "worktree_digest_authority": "NON_AUTHORITATIVE",
            }
        else:
            result = fold_verdict(findings, needs_input=needs_input)
            subject = {
                "skill_id": skill.get("id"),
                "skill_version": skill.get("version"),
                "state": "MUTABLE",
                "subject_digest": None,
                "worktree_digest": wt["worktree_digest"],
                "worktree_profile_ref": wt["worktree_profile_ref"],
                "worktree_digest_authority": "NON_AUTHORITATIVE",
                "fileset_count": wt["fileset_count"],
            }
        report = compose_report(
            report_id=report_id or _report_id_for(manifest, mode),
            mode=mode,
            subject=subject,
            result=result,
            findings=findings,
            ontology_version=ont_ver,
            engine_version=resolution.engine_version,
            storage=storage,
        )
        return {
            "report": report,
            "exit_code": code_for(result),
            "result": result,
        }

    # FORMAL_TEST post digest
    expected_digest = subject_digest or (freeze_manifest or {}).get("subject_digest")
    fid = freeze_id or (freeze_manifest or {}).get("freeze_id")
    after = digest_subject(root, ont_ver)
    if not after["ok"] or after["subject_digest"] != expected_digest:
        findings.append(
            Finding(
                rule_id="SEC-SUBJECT-MUTATED-001",
                severity=Severity.BLOCK.value,
                message="Post-test subject_digest mismatch / subject mutated",
            )
        )
        result = Result.SUBJECT_MUTATED.value
    else:
        result = fold_verdict(findings, needs_input=False)
        if result == Result.NEEDS_INPUT.value:
            result = Result.BLOCK.value

    subject = _frozen_subject(manifest, fid, freeze_manifest, expected_digest, after)
    report = compose_report(
        report_id=report_id or _report_id_for(manifest, mode),
        mode=mode,
        subject=subject,
        result=result,
        findings=findings,
        ontology_version=ont_ver,
        engine_version=resolution.engine_version,
        storage=storage,
    )
    return {"report": report, "exit_code": code_for(result), "result": result}
