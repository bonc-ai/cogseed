"""Worktree (non-authoritative) and subject digest computation."""

from __future__ import annotations

import hashlib
import fnmatch
import io
from pathlib import Path
from typing import Any

import yaml

from .canonicalization import normalize_path, stable_json_bytes
from .path_security import inspect_filesystem_node
from .paths import load_ontology_artifact
from .result_models import Finding, Severity

# provenance.checksum must equal subject_digest after freeze, but the field lives
# inside the hashed fileset. Digest bytes therefore always hash manifests with a
# fixed sentinel so the digest is independent of the checksum value itself.
CHECKSUM_DIGEST_SENTINEL = "DIGEST_EXCLUDED"


def _match_any(rel: str, patterns: list[str]) -> bool:
    for pat in patterns:
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel, pat.rstrip("/")):
            return True
        # directory prefix patterns like references/**
        if pat.endswith("/**"):
            prefix = pat[:-3]
            if rel == prefix or rel.startswith(prefix + "/"):
                return True
    return False


def collect_fileset(
    skill_root: Path,
    profile: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[Finding]]:
    root = skill_root.resolve()
    include = profile.get("include") or []
    exclude = profile.get("exclude") or []
    findings: list[Finding] = []
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()

    candidates: list[Path] = []
    for pat in include:
        if "**" in pat or "*" in pat:
            # recursive glob from root
            for p in root.glob(pat):
                if p.is_file():
                    candidates.append(p)
        else:
            p = root / pat
            if p.is_file():
                candidates.append(p)
            elif p.is_dir():
                candidates.extend([x for x in p.rglob("*") if x.is_file()])

    for path in candidates:
        findings.extend(inspect_filesystem_node(root, path))
        if any(f.severity == Severity.BLOCK.value for f in findings):
            continue
        try:
            rel = normalize_path(str(path.relative_to(root)))
        except ValueError:
            findings.append(
                Finding(
                    rule_id="SEC-PATH-ESCAPE-001",
                    severity=Severity.BLOCK.value,
                    message=f"File outside root: {path}",
                )
            )
            continue
        if _match_any(rel, exclude):
            continue
        if rel in seen:
            findings.append(
                Finding(
                    rule_id="SEC-DIGEST-DUP-PATH-001",
                    severity=Severity.BLOCK.value,
                    message=f"Duplicate normalized path: {rel}",
                    path=rel,
                )
            )
            continue
        seen.add(rel)
        data = _file_digest_bytes(rel, path)
        digest = hashlib.sha256(data).hexdigest()
        entries.append({"path": rel, "size": len(data), "sha256": f"sha256:{digest}"})

    entries.sort(key=lambda e: e["path"].encode("utf-8"))
    return entries, findings


def _file_digest_bytes(rel: str, path: Path) -> bytes:
    """Raw bytes for most files; strip provenance.checksum for security manifests."""
    raw = path.read_bytes()
    name = Path(rel).name
    if name in ("security-manifest.yaml", "security-manifest.yml") or rel.endswith(
        "/security-manifest.yaml"
    ):
        try:
            doc = yaml.safe_load(raw.decode("utf-8")) or {}
            if isinstance(doc, dict) and isinstance(doc.get("provenance"), dict):
                prov = dict(doc["provenance"])
                prov["checksum"] = CHECKSUM_DIGEST_SENTINEL
                doc = dict(doc)
                doc["provenance"] = prov
                buf = io.StringIO()
                yaml.safe_dump(doc, buf, allow_unicode=True, sort_keys=True)
                return buf.getvalue().encode("utf-8")
        except Exception:  # noqa: BLE001
            return raw
    return raw


def _digest_from_fileset(profile: dict[str, Any], fileset: list[dict[str, Any]]) -> str:
    payload = {
        "digest_profile": {
            "id": profile.get("id"),
            "version": profile.get("version"),
            "ref": profile.get("ref") or f"{profile.get('id')}@{profile.get('version')}",
        },
        "fileset": fileset,
    }
    digest = hashlib.sha256(stable_json_bytes(payload)).hexdigest()
    return f"sha256:{digest}"


def compute_worktree_digest(
    skill_root: str | Path,
    ontology_version: str = "1.1.1",
    profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    profile = profile or load_ontology_artifact(ontology_version, "digest-profile.yaml")
    fileset, findings = collect_fileset(Path(skill_root), profile)
    if any(f.severity == Severity.BLOCK.value for f in findings):
        return {
            "ok": False,
            "findings": findings,
            "worktree_digest": None,
            "fileset": fileset,
            "fileset_count": len(fileset),
            "authority": "NON_AUTHORITATIVE",
            "worktree_profile_ref": profile.get("ref"),
        }
    digest = _digest_from_fileset(profile, fileset)
    return {
        "ok": True,
        "findings": findings,
        "worktree_digest": digest,
        "fileset": fileset,
        "fileset_count": len(fileset),
        "authority": "NON_AUTHORITATIVE",
        "worktree_profile_ref": profile.get("ref"),
        "digest_profile": {
            "id": profile.get("id"),
            "version": profile.get("version"),
            "ref": profile.get("ref"),
        },
    }


def compute_subject_digest(
    skill_root: str | Path,
    ontology_version: str = "1.1.1",
    profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Authoritative digest for FROZEN subjects — same algorithm as worktree, different authority label."""
    result = compute_worktree_digest(skill_root, ontology_version, profile)
    if not result["ok"]:
        return {
            "ok": False,
            "findings": result["findings"],
            "subject_digest": None,
            "fileset": result.get("fileset") or [],
            "fileset_count": result.get("fileset_count") or 0,
        }
    return {
        "ok": True,
        "findings": result["findings"],
        "subject_digest": result["worktree_digest"],
        "fileset": result["fileset"],
        "fileset_count": result["fileset_count"],
        "digest_profile": result["digest_profile"],
        "authority": "AUTHORITATIVE",
    }
