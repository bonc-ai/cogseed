"""Fileset assembly and digest computation.

The digest is the engine's frozen-subject identity: a stable sha256 over the
canonical fileset of a skill tree. The algorithm is part of the cross-process
contract (``digest-profile.yaml``) — historical digests must keep verifying
after any refactor, so the semantics below are frozen:

* files are selected by the profile's include/exclude globs;
* a security-manifest's ``provenance.checksum`` is replaced by a sentinel
  before hashing (the checksum would otherwise circularly include itself);
* the payload is ``{digest_profile, fileset}`` serialized as canonical JSON.
"""

from __future__ import annotations

import fnmatch
import hashlib
import io
from pathlib import Path
from typing import Any

import yaml

from .guards import audit_node
from .models import Finding, Severity
from .normalizing import canonical_json_bytes, fold_path
from .registry import read_artifact

CHECKSUM_SENTINEL = "DIGEST_EXCLUDED"


def _matches(rel: str, patterns: list[str]) -> bool:
    for pat in patterns:
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel, pat.rstrip("/")):
            return True
        if pat.endswith("/**"):
            prefix = pat[:-3]
            if rel == prefix or rel.startswith(prefix + "/"):
                return True
    return False


def _file_bytes(rel: str, path: Path) -> bytes:
    raw = path.read_bytes()
    name = Path(rel).name
    if name in ("security-manifest.yaml", "security-manifest.yml") or rel.endswith("/security-manifest.yaml"):
        try:
            doc = yaml.safe_load(raw.decode("utf-8")) or {}
            if isinstance(doc, dict) and isinstance(doc.get("provenance"), dict):
                prov = dict(doc["provenance"])
                prov["checksum"] = CHECKSUM_SENTINEL
                doc = dict(doc)
                doc["provenance"] = prov
                buf = io.StringIO()
                yaml.safe_dump(doc, buf, allow_unicode=True, sort_keys=True)
                return buf.getvalue().encode("utf-8")
        except Exception:  # noqa: BLE001
            return raw
    return raw


class FilesetAssembler:
    """Collect the digest fileset for one skill tree under one profile."""

    def __init__(self, skill_root: Path, profile: dict[str, Any]):
        self.root = skill_root.resolve()
        self.include = profile.get("include") or []
        self.exclude = profile.get("exclude") or []

    def _candidate_paths(self) -> list[Path]:
        candidates: list[Path] = []
        for pat in self.include:
            if "**" in pat or "*" in pat:
                for p in self.root.glob(pat):
                    if p.is_file():
                        candidates.append(p)
            else:
                p = self.root / pat
                if p.is_file():
                    candidates.append(p)
                elif p.is_dir():
                    candidates.extend([x for x in p.rglob("*") if x.is_file()])
        return candidates

    def assemble(self) -> tuple[list[dict[str, Any]], list[Finding]]:
        findings: list[Finding] = []
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()

        for path in self._candidate_paths():
            findings.extend(audit_node(self.root, path))
            if any(f.severity == Severity.BLOCK.value for f in findings):
                continue
            try:
                rel = fold_path(str(path.relative_to(self.root)))
            except ValueError:
                findings.append(
                    Finding(
                        rule_id="SEC-PATH-ESCAPE-001",
                        severity=Severity.BLOCK.value,
                        message=f"File outside root: {path}",
                    )
                )
                continue
            if _matches(rel, self.exclude):
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
            data = _file_bytes(rel, path)
            entries.append(
                {"path": rel, "size": len(data), "sha256": f"sha256:{hashlib.sha256(data).hexdigest()}"}
            )

        entries.sort(key=lambda e: e["path"].encode("utf-8"))
        return entries, findings


def _digest_payload(profile: dict[str, Any], fileset: list[dict[str, Any]]) -> str:
    payload = {
        "digest_profile": {
            "id": profile.get("id"),
            "version": profile.get("version"),
            "ref": profile.get("ref") or f"{profile.get('id')}@{profile.get('version')}",
        },
        "fileset": fileset,
    }
    return f"sha256:{hashlib.sha256(canonical_json_bytes(payload)).hexdigest()}"


def _default_profile(ontology_version: str) -> dict[str, Any]:
    return read_artifact(ontology_version, "digest-profile.yaml")


def worktree_digest(
    skill_root: str | Path,
    ontology_version: str = "1.1.1",
    profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Non-authoritative digest of a mutable worktree."""
    profile = profile or _default_profile(ontology_version)
    fileset, findings = FilesetAssembler(Path(skill_root), profile).assemble()
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
    return {
        "ok": True,
        "findings": findings,
        "worktree_digest": _digest_payload(profile, fileset),
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


def subject_digest(
    skill_root: str | Path,
    ontology_version: str = "1.1.1",
    profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Authoritative digest of a frozen subject — same algorithm, frozen label."""
    result = worktree_digest(skill_root, ontology_version, profile)
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
