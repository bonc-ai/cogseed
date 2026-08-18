"""
path_security.py — 路径与压缩包安全检查
=========================================

集中处理与文件系统边界相关的安全逻辑：zip 解包路径穿越防护、
Skill 边界定位（以 SKILL.md 为根）、文本文件证据收集。

设计参照 security-skills 的 path_security.py：路径穿越 / 符号链接 /
非法文件节点检查应独立于业务扫描逻辑，便于单独审计和测试。
"""
from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

TEXT_EXT = {".md", ".txt", ".yaml", ".yml", ".json", ".toml", ".py", ".js", ".ts", ".sh", ".env", ".cfg", ".ini"}
IGNORED_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache"}


def safe_extract(source: Path, destination: Path) -> Path:
    """安全解压 zip 包，拒绝路径穿越（zip slip）。目录输入原样返回。"""
    if source.is_dir():
        return source.resolve()
    if not zipfile.is_zipfile(source):
        return source.resolve()
    with zipfile.ZipFile(source) as archive:
        root = destination.resolve()
        for info in archive.infolist():
            target = (destination / info.filename).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"unsafe zip path: {info.filename}")
        archive.extractall(destination)
    children = [item for item in destination.iterdir() if item.name != "__MACOSX"]
    return children[0] if len(children) == 1 and children[0].is_dir() else destination


def locate_skill_roots(source: Path) -> list[Path]:
    """以 SKILL.md 为根定位 Skill 目录。收窄扫描边界的核心。"""
    if source.is_file():
        return [source.parent.resolve()]
    skill_files = [p for p in source.rglob("SKILL.md") if not IGNORED_DIRS.intersection(p.parts)]
    roots = sorted({p.parent.resolve() for p in skill_files}, key=str)
    return roots or [source.resolve()]


def collect_evidence(skill_dir: Path) -> tuple[set[str], list[tuple[str, str]]]:
    """返回 (相对路径集合, [(相对路径, 文本内容)])。仅收文本文件；二进制交给 binary_rules。"""
    files: set[str] = set()
    docs: list[tuple[str, str]] = []
    total = 0
    for path in sorted(skill_dir.rglob("*")):
        if not path.is_file():
            continue
        relative_path = path.relative_to(skill_dir)
        # Generated/runtime directories are not part of a Skill's source. In
        # particular, Python bytecode in __pycache__ can contain copied URLs or
        # command strings and would otherwise create environment-dependent
        # findings after a local test run.
        if IGNORED_DIRS.intersection(relative_path.parts):
            continue
        rel = relative_path.as_posix()
        files.add(rel.lower())
        if path.suffix.lower() in TEXT_EXT and path.stat().st_size <= 1_000_000:
            try:
                docs.append((rel, path.read_text("utf-8", errors="ignore")))
                total += path.stat().st_size
            except Exception:
                pass
        if total >= 4_000_000:
            break
    return files, docs
