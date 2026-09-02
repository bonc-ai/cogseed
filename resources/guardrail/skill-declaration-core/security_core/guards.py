"""Filesystem guards: path traversal, symlinks, and special node auditing.

These checks run on every file the engine looks at — referenced paths from the
manifest and every file collected into a digest fileset. All checks are
fail-closed: anything that looks like it can leave the skill root is BLOCK.
"""

from __future__ import annotations

import os
import stat as statmod
from pathlib import Path

from .models import Finding, Severity
from .normalizing import fold_path

DANGEROUS_ALLOWLIST_TOKENS = {"*", "all", "0.0.0.0/0", "unrestricted"}


def lies_beneath_root(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def audit_relative_path(root: Path, rel: str) -> list[Finding]:
    findings: list[Finding] = []
    norm = fold_path(rel)
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
    if not lies_beneath_root(root, target):
        findings.append(
            Finding(
                rule_id="SEC-PATH-ESCAPE-001",
                severity=Severity.BLOCK.value,
                message=f"Resolved path escapes skill root: {rel}",
                path=rel,
            )
        )
    return findings


def audit_node(root: Path, path: Path) -> list[Finding]:
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
    mode = st.st_mode
    if statmod.S_ISCHR(mode) or statmod.S_ISBLK(mode) or statmod.S_ISFIFO(mode) or statmod.S_ISSOCK(mode):
        findings.append(
            Finding(
                rule_id="SEC-PATH-SPECIAL-001",
                severity=Severity.BLOCK.value,
                message=f"Special filesystem node not allowed: {path}",
                path=str(path),
            )
        )
    # Hardlink-escape analysis is OS-specific and skipped in phase 1; the
    # resolve() check in audit_relative_path already covers the common escape.
    return findings


def walk_tree_guards(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    root = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        base = Path(dirpath)
        for name in list(dirnames) + list(filenames):
            entry = base / name
            findings.extend(audit_node(root, entry))
            if entry.is_symlink() and name in dirnames:
                dirnames.remove(name)
    return findings
