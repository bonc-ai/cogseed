"""
signatures.py — 运行 YARA 签名包
====================================

把 ``yara_lite`` 的规则包接进扫描流程：读文件字节、逐条规则匹配、把命中转换成
标准 finding。

三条设计约束
------------
1. **签名包随规则包版本化**：``engine/rulesets/<version>/yara/*.yar``。规则包升级
   即签名包升级，报告里的 ``ruleset_version`` 对两者同时成立。
2. **命中必须经过上下文降权**：同一段 `/dev/tcp/` 出现在源码里与出现在
   「禁止使用反向 shell」的文档段落里不是一回事。这里复用 ``context.py`` 的
   ``severity_for``，与文本规则完全同一套口径——否则 YARA 会绕开 2.1.0 的
   误报校准，把文档里的示例重新变成拦截。
3. **绝不回显命中内容**：finding 的 description 只带规则名与规则作者写的说明，
   不带命中的字节。签名命中的那一段可能正是密钥或载荷本身。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

from .context import file_context, severity_for
from .path_security import IGNORED_DIRS
from .result_models import make_finding
from .yara_lite import SignaturePack

#: 单个文件参与签名匹配的上限。YARA 是逐字节扫描，拿 100MB 的归档去跑会让
#: 一次安装卡住；超限文件记入覆盖信息，不静默当作「已扫」。
MAX_FILE_BYTES = 8_000_000
MAX_TOTAL_BYTES = 64_000_000
MAX_FILES = 600
MAX_FINDINGS = 120

_ALLOWED_SEVERITY = {"critical", "high", "medium", "low", "info"}
_ALLOWED_CONFIDENCE = {"high", "medium", "low"}


def _iter_files(skill_dir: Path):
    """遍历文件，剪掉生成目录与符号链接。"""
    for root, dirs, files in os.walk(skill_dir, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name not in IGNORED_DIRS)
        for name in sorted(files):
            path = Path(root) / name
            if path.is_symlink():
                continue
            # FIFO/设备节点会让 read_bytes 永久阻塞；YARA 只扫普通文件。
            if not path.is_file():
                continue
            try:
                rel = path.relative_to(skill_dir).as_posix()
            except ValueError:
                rel = name
            yield path, rel


def load_signature_pack(ruleset_dir: Optional[Path]) -> tuple[Optional[SignaturePack],
                                                               dict[str, Any]]:
    status: dict[str, Any] = {"status": "MISSING", "rules": 0, "files": 0, "errors": []}
    if ruleset_dir is None:
        status["reason"] = "ruleset_dir_absent"
        return None, status
    directory = ruleset_dir / "yara"
    if not directory.is_dir():
        status["reason"] = "directory_absent"
        return None, status
    sources: dict[str, str] = {}
    for path in sorted(directory.glob("*.yar")):
        try:
            sources[path.name] = path.read_text("utf-8")
        except OSError:
            status["errors"].append({"file": path.name, "rule": "", "error": "unreadable"})
    if not sources:
        status["reason"] = "empty_pack"
        return None, status
    pack = SignaturePack.load(sources)
    status.update({
        "status": "OK",
        "rules": len(pack.rules),
        "files": len(sources),
        "errors": pack.errors,
    })
    return pack, status


def _line_and_text(data: bytes, offset: int) -> tuple[int, str]:
    """字节偏移 → (1-based 行号, 该行截断后的文本)。"""
    offset = max(0, min(offset, len(data) - 1))
    line_no = data.count(b"\n", 0, offset) + 1
    start = data.rfind(b"\n", 0, offset) + 1
    end = data.find(b"\n", offset)
    if end < 0:
        end = len(data)
    # 二进制文件常常整份没有换行；截取偏移附近 400 字节即可判断上下文，
    # 不要把整份 8MB 数据解码成一行。
    start = max(start, offset - 200)
    end = min(end, offset + 200)
    return line_no, data[start:end].decode("utf-8", "replace")


def _severity_and_context(rule, rel: str, data: bytes, offset: int,
                          contexts: dict[str, Any]) -> tuple[str, str]:
    meta = rule.meta or {}
    original = str(meta.get("severity") or "high").lower()
    if original not in _ALLOWED_SEVERITY:
        original = "high"
    ctx = contexts.get(rel)
    if ctx is None:
        return severity_for(original, file_context(rel)), file_context(rel)
    line_no, line_text = _line_and_text(data, offset)
    level = ctx.at(line_no, line_text)
    return severity_for(original, level), level


def scan_signatures(skill_dir: Path, contexts: dict[str, Any],
                    ruleset_dir: Optional[Path]) -> dict[str, Any]:
    """运行签名包。返回 findings + 覆盖事实 + 覆盖类提示项。"""
    pack, status = load_signature_pack(ruleset_dir)
    findings: list[dict[str, Any]] = []
    coverage_findings: list[dict[str, Any]] = []
    files_seen = 0
    files_scanned = 0
    bytes_scanned = 0
    skipped_large = 0
    truncated = False

    if pack is not None:
        seen: set[tuple[str, str]] = set()
        for path, rel in _iter_files(skill_dir):
            if files_seen >= MAX_FILES or bytes_scanned >= MAX_TOTAL_BYTES:
                truncated = True
                break
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size > MAX_FILE_BYTES:
                skipped_large += 1
                files_seen += 1
                continue
            try:
                data = path.read_bytes()
            except OSError:
                files_seen += 1
                continue
            files_seen += 1
            if not data:
                continue
            files_scanned += 1
            bytes_scanned += len(data)
            for rule, result in pack.match(data):
                key = (rule.name, rel)
                if key in seen:
                    continue
                seen.add(key)
                offsets = [first for _, first in (result.get("strings") or {}).values()]
                offset = min(offsets) if offsets else 0
                severity, level = _severity_and_context(rule, rel, data, offset, contexts)
                meta = rule.meta or {}
                description = str(meta.get("description") or "").strip()
                confidence = str(meta.get("confidence") or "medium").lower()
                if confidence not in _ALLOWED_CONFIDENCE:
                    confidence = "medium"
                findings.append(make_finding(
                    str(meta.get("sr") or "SR-03"),
                    f"yara:{rule.name}",
                    severity,
                    str(meta.get("category") or "malware_signature"),
                    rel,
                    _line_and_text(data, offset)[0],
                    f"YARA 规则 {rule.name}" + (f"：{description}" if description else ""),
                    str(meta.get("remediation") or ""),
                    source="yara",
                    context=level,
                    original_severity=str(meta.get("severity") or severity),
                    confidence=confidence,
                ))
                if len(findings) >= MAX_FINDINGS:
                    truncated = True
                    break
            if len(findings) >= MAX_FINDINGS:
                break

    if pack is None:
        coverage_findings.append(make_finding(
            "SR-COV", "yara_pack_missing", "info", "scan_coverage",
            "(signature-pack)", None,
            "YARA 签名包未加载，本次没有做恶意特征匹配",
            "重新安装或更新 skill-sentry 规则包。",
            source="coverage", confidence="high", snippet="",
        ))
    elif status.get("errors"):
        names = "、".join(sorted({str(item.get("rule") or item.get("file"))
                                  for item in status["errors"]})[:5])
        coverage_findings.append(make_finding(
            "SR-COV", "yara_rules_failed_to_compile", "info", "scan_coverage",
            "(signature-pack)", None,
            f"有 {len(status['errors'])} 条 YARA 规则未能编译：{names}",
            "修正规则语法后重新生成签名包；未编译的规则不会参与匹配。",
            source="coverage", confidence="high", snippet="",
        ))
    if skipped_large:
        coverage_findings.append(make_finding(
            "SR-COV", "yara_files_skipped", "info", "scan_coverage",
            "(signature-scan)", None,
            f"有 {skipped_large} 个超过 {MAX_FILE_BYTES // 1_000_000}MB 的文件未参与签名匹配",
            "如需覆盖大文件，请在安装前单独做人工复核。",
            source="coverage", confidence="high", snippet="",
        ))
    if truncated:
        coverage_findings.append(make_finding(
            "SR-COV", "yara_scan_truncated", "info", "scan_coverage",
            "(signature-scan)", None,
            "签名匹配达到文件/字节/发现项上限，部分文件未参与匹配",
            "拆分 Skill 或减少体积后重新扫描。",
            source="coverage", confidence="high", snippet="",
        ))

    return {
        "findings": findings,
        "coverage_findings": coverage_findings,
        "status": {
            "status": status.get("status"),
            "reason": status.get("reason", ""),
            "rules": status.get("rules", 0),
            "pack_files": status.get("files", 0),
            "errors": status.get("errors", []),
            "files_seen": files_seen,
            "files_scanned": files_scanned,
            "bytes_scanned": bytes_scanned,
            "skipped_large": skipped_large,
            "findings": len(findings),
            "truncated": truncated,
        },
    }
