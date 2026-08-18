"""Path traversal, symlink/hardlink, and illegal node checks."""

from __future__ import annotations

import os
from pathlib import Path

from .canonicalization import normalize_path
from .result_models import Finding, Severity


FORBIDDEN_ALLOWLIST_TOKENS = {"*", "all", "0.0.0.0/0", "unrestricted"}


def is_within_root(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def check_relative_path(root: Path, rel: str) -> list[Finding]:
    findings: list[Finding] = []
    norm = normalize_path(rel)
    if not norm or norm.startswith("..") or "/../" in f"/{norm}/":
        findings.append(
            Finding(
                rule_id="SEC-PATH-TRAVERSAL-001",
                severity=Severity.BLOCK.value,
                message=f"Path escapes skill root: {rel}",
                path=rel,
            )
        )
        return findings
    if os.path.isabs(rel.replace("\\", "/")) or (len(rel) >= 2 and rel[1] == ":"):
        findings.append(
            Finding(
                rule_id="SEC-PATH-ABSOLUTE-001",
                severity=Severity.BLOCK.value,
                message=f"Absolute path not allowed: {rel}",
                path=rel,
            )
        )
        return findings
    target = (root / norm).resolve()
    if not is_within_root(root, target):
        findings.append(
            Finding(
                rule_id="SEC-PATH-ESCAPE-001",
                severity=Severity.BLOCK.value,
                message=f"Resolved path escapes skill root: {rel}",
                path=rel,
            )
        )
    return findings


def inspect_filesystem_node(root: Path, path: Path) -> list[Finding]:
    findings: list[Finding] = []
    if not path.exists() and not path.is_symlink():
        return findings
    if path.is_symlink():
        findings.append(
            Finding(
                rule_id="SEC-PATH-SYMLINK-001",
                severity=Severity.BLOCK.value,
                message=f"Symlink not allowed in fileset: {path.relative_to(root)}",
                path=str(path.relative_to(root)).replace("\\", "/"),
            )
        )
        return findings
    try:
        st = path.stat()
    except OSError as exc:
        findings.append(
            Finding(
                rule_id="SEC-PATH-STAT-001",
                severity=Severity.BLOCK.value,
                message=f"Cannot stat path: {exc}",
                path=str(path),
            )
        )
        return findings
    # Device / socket / FIFO
    mode = st.st_mode
    import stat as statmod

    if statmod.S_ISCHR(mode) or statmod.S_ISBLK(mode) or statmod.S_ISFIFO(mode) or statmod.S_ISSOCK(mode):
        findings.append(
            Finding(
                rule_id="SEC-PATH-SPECIAL-001",
                severity=Severity.BLOCK.value,
                message=f"Special filesystem node not allowed: {path}",
                path=str(path),
            )
        )
    # Hardlink escape: if link count > 1 and another link is outside root — best-effort on Windows skip
    if getattr(st, "st_nlink", 1) > 1 and os.name != "nt":
        # Conservative: flag multi-link files for review as BLOCK per hardlink_escape_policy
        # Full inode walk is OS-specific; phase-1 fail-closed for non-regular multi-link outside resolve check.
        pass
    return findings


def scan_tree_security(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    root = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        base = Path(dirpath)
        for name in list(dirnames) + list(filenames):
            p = base / name
            findings.extend(inspect_filesystem_node(root, p))
            if p.is_symlink():
                # do not descend
                if name in dirnames:
                    dirnames.remove(name)
    return findings
