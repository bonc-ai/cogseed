"""
external_tools.py — 外部工具增强（gitleaks / osv-scanner）
=============================================================

可选依赖增强，无对应命令时自动降级并在 tool_status 中标注 SKIPPED，
不影响核心扫描流程可用性。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .result_models import make_finding


def enhance_with_gitleaks(skill_dir: Path) -> dict[str, Any]:
    if not shutil.which("gitleaks"):
        return {"status": "SKIPPED", "reason": "未安装 gitleaks，使用内置正则兜底", "findings": []}
    with tempfile.TemporaryDirectory() as tmp:
        report = Path(tmp) / "gl.json"
        proc = subprocess.run(
            ["gitleaks", "detect", "--source", str(skill_dir), "--no-git",
             "--report-format", "json", "--report-path", str(report),
             "--exit-code", "0", "--no-banner", "--redact"],
            text=True, capture_output=True, timeout=120, check=False,
        )
        if not report.exists():
            return {"status": "ERROR", "reason": (proc.stderr or proc.stdout)[-500:], "findings": []}
        try:
            rows = json.loads(report.read_text("utf-8"))
        except Exception:
            rows = []
        findings = [make_finding("SR-01", row.get("RuleID", "gitleaks"), "critical", "secret",
                                  row.get("File", ""), row.get("StartLine"),
                                  row.get("Description", "Secret detected"),
                                  "移除硬编码密钥，改用密钥托管", source="gitleaks")
                    for row in (rows or [])]
        return {"status": "OK", "findings": findings}


def enhance_with_dependency_audit(skill_dir: Path) -> dict[str, Any]:
    if not shutil.which("osv-scanner"):
        return {"status": "SKIPPED", "reason": "未安装 osv-scanner，跳过 CVE 依赖漏洞扫描", "findings": []}
    proc = subprocess.run(
        ["osv-scanner", "--format", "json", "-r", str(skill_dir)],
        text=True, capture_output=True, timeout=180, check=False,
    )
    findings: list[dict[str, Any]] = []
    try:
        data = json.loads(proc.stdout or "{}")
        for res in data.get("results", []):
            for pkg in res.get("packages", []):
                for vuln in pkg.get("vulnerabilities", []):
                    findings.append(make_finding(
                        "SR-06", vuln.get("id", "CVE"), "high", "dependency_vuln",
                        res.get("source", {}).get("path", ""), None,
                        f"{pkg.get('package', {}).get('name', '?')}: {vuln.get('summary', '')[:120]}",
                        "升级到已修复版本", source="osv-scanner"))
    except Exception:
        pass
    return {"status": "OK", "findings": findings}
