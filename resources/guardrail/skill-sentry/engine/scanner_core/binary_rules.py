"""
binary_rules.py — 二进制文件静态行为分析
============================================

原 07_agent_runtime/binary_scan.py，迁移至 engine 包内，接口保持不变。

【当前实现范围（静态层）】
  识别二进制格式，抽取字符串，匹配可疑指标（硬编码 URL/IP、危险命令、
  持久化路径等）。

【已知局限（务必知晓）】
  未接入动态沙箱，has_dynamic_sandbox() 恒为 False，无法确认二进制真实
  运行时行为（写了什么/发到哪）。见 capabilities.yaml 中的机器可读声明。
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

MAGIC_SIGNATURES: list[tuple[bytes, str]] = [
    (b"\x7fELF", "ELF"),
    (b"MZ", "PE"),
    (b"\xfe\xed\xfa\xce", "Mach-O"),
    (b"\xfe\xed\xfa\xcf", "Mach-O"),
    (b"\xcf\xfa\xed\xfe", "Mach-O"),
    (b"\xca\xfe\xba\xbe", "Mach-O/Java"),
    (b"\x00\x61\x73\x6d", "WASM"),
    (b"PK\x03\x04", "ZIP/JAR/APK"),
]

SUSPICIOUS_STRING_PATTERNS: list[tuple[str, str, str]] = [
    (r"https?://[a-zA-Z0-9\.\-]+", "medium", "network"),
    (r"\b(\d{1,3})(\.\d{1,3}){3}\b", "low", "network"),
    (r"169\.254\.169\.254", "high", "ssrf"),
    (r"/etc/passwd|/etc/shadow", "high", "credential_access"),
    (r"crontab|LaunchAgents|systemd", "high", "persistence"),
    (r"\brm -rf\b", "high", "destructive"),
    (r"/bin/sh|/bin/bash|cmd\.exe|powershell", "medium", "command_exec"),
    (r"socket|connect|sendto|recv", "low", "network_syscall"),
    (r"ptrace|LD_PRELOAD|dlopen", "medium", "anti_debug_or_inject"),
]

BINARY_EXTENSIONS = {
    ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a",
    ".apk", ".jar", ".class", ".wasm", ".node", ".pyd",
}


def detect_binary_format(path: Path) -> str | None:
    """返回二进制格式名；若判断为文本文件则返回 None。"""
    try:
        with path.open("rb") as fh:
            head = fh.read(8)
    except Exception:
        return None
    if not head:
        return None
    for magic, name in MAGIC_SIGNATURES:
        if head.startswith(magic):
            return name
    if path.suffix.lower() in BINARY_EXTENSIONS:
        return "binary(by-ext)"
    if b"\x00" in head:
        return "binary(unknown)"
    return None


def _extract_strings_native(path: Path, min_len: int = 4, cap: int = 200_000) -> str:
    """纯 Python 兜底：无 `strings` 命令时抽取可打印字符串。"""
    out: list[str] = []
    current: list[str] = []
    total = 0
    try:
        with path.open("rb") as fh:
            while total < cap:
                chunk = fh.read(65536)
                if not chunk:
                    break
                for byte in chunk:
                    if 32 <= byte < 127:
                        current.append(chr(byte))
                    else:
                        if len(current) >= min_len:
                            out.append("".join(current))
                            total += len(current)
                        current = []
            if len(current) >= min_len:
                out.append("".join(current))
    except Exception:
        return ""
    return "\n".join(out)


def extract_strings(path: Path) -> str:
    """优先用系统 `strings` 命令，不可用时回退到纯 Python。"""
    if shutil.which("strings"):
        try:
            proc = subprocess.run(
                ["strings", "-n", "4", str(path)],
                text=True, capture_output=True, timeout=60, check=False,
            )
            if proc.returncode == 0 and proc.stdout:
                return proc.stdout[:200_000]
        except Exception:
            pass
    return _extract_strings_native(path)


def has_dynamic_sandbox() -> bool:
    """动态沙箱能力探测。当前恒为 False（未实现动态层）。"""
    return False


def scan_binary_file(path: Path, rel: str) -> dict[str, Any]:
    fmt = detect_binary_format(path)
    if fmt is None:
        return {"is_binary": False}

    blob = extract_strings(path)
    findings: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for regex, severity, category in SUSPICIOUS_STRING_PATTERNS:
        for match in re.finditer(regex, blob, re.IGNORECASE):
            value = match.group(0)[:120]
            key = (category, value)
            if key in seen:
                continue
            seen.add(key)
            findings.append({
                "severity": severity,
                "category": category,
                "indicator": value,
                "file": rel,
                "source": "binary-strings",
            })
            if len(findings) >= 100:
                break

    try:
        size = path.stat().st_size
    except Exception:
        size = None
    return {
        "is_binary": True,
        "format": fmt,
        "file": rel,
        "size_bytes": size,
        "findings": findings,
        "dynamic_analysis": "not_performed",
        "limitation": "仅静态字符串级启发式；未执行动态沙箱，无法确认真实运行时读写/外发行为",
    }


def scan_binaries(skill_dir: Path) -> dict[str, Any]:
    """遍历 Skill 目录下所有文件，对二进制文件做静态行为分析。"""
    binaries: list[dict[str, Any]] = []
    all_findings: list[dict[str, Any]] = []
    candidates = [skill_dir] if skill_dir.is_file() else sorted(skill_dir.rglob("*"))
    for path in candidates:
        if not path.is_file():
            continue
        try:
            rel = path.name if skill_dir.is_file() else path.relative_to(skill_dir).as_posix()
        except ValueError:
            rel = path.name
        result = scan_binary_file(path, rel)
        if result.get("is_binary"):
            binaries.append(result)
            all_findings.extend(result.get("findings", []))

    return {
        "binary_count": len(binaries),
        "dynamic_sandbox_available": has_dynamic_sandbox(),
        "binaries": binaries,
        "findings": all_findings,
        "note": (
            "二进制扫描当前为静态层实现（strings + 指标匹配）。"
            "运行时行为分析（写了什么/发到哪）需接入动态沙箱，尚未实现。"
        ),
    }
