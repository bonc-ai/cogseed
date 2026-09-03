#!/usr/bin/env python3
"""
agent_gate.py — Agent 编排层（合规检测入口）
============================================================

架构核心原则
------------
把这个模块给 Agent 调用，而**不要**让 Agent 直接读被测 Skill 的原始内容。

    ┌─────────┐   调用    ┌──────────────┐   起一次性容器   ┌─────────────┐
    │  Agent  │─────────▶│  agent_gate  │───────────────▶│   沙箱容器   │
    │ (决策)  │◀─────────│ (编排/裁决)  │◀───────────────│ (接触不可信) │
    └─────────┘  JSON裁决  └──────────────┘   JSON报告      └─────────────┘

- Agent 只看到 verdict（allow/deny/review）+ 结构化摘要，不接触原始 Skill 文本，
  从而规避“被测 Skill 内含提示注入直接攻击 Agent”的风险。
- 真正接触不可信内容的是断网、只读、非 root、用完即焚的沙箱容器。
- 无 Docker 时可降级到本地直跑（degraded 模式），但会在结果里显式标注
  “未隔离”，让上层知道这次裁决的可信度较低。

对外只暴露一个函数：evaluate_skill(skill_path) -> dict
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

GATE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = GATE_DIR.parent
SANDBOX_SCRIPT = GATE_DIR / "run_sandboxed_scan.sh"

# 部署建议 → Agent 裁决
RECOMMENDATION_TO_VERDICT = {
    "ALLOW": "allow",
    "CAUTION": "review",       # 需人工复核，不自动放行也不直接拒绝
    "DO_NOT_INSTALL": "deny",
}


def _summarize(report: dict[str, Any], isolated: bool, mode: str) -> dict[str, Any]:
    """把完整扫描报告压成 Agent 需要的最小裁决面（不含被测原始内容）。"""
    if report.get("skill_count") is not None:
        # 多 Skill 聚合
        rec = report.get("aggregate_recommendation", "CAUTION")
        summaries = [
            {
                "skill": r.get("skill"),
                "security_score": r.get("security_score"),
                "risk_classification": r.get("risk_classification"),
                "deployment_recommendation": r.get("deployment_recommendation"),
                "hard_blocked": r.get("hard_blocked"),
                "required_mitigations": [m["id"] for m in r.get("required_mitigations", [])],
            }
            for r in report.get("reports", [])
        ]
        return {
            "verdict": RECOMMENDATION_TO_VERDICT.get(rec, "review"),
            "isolated": isolated,
            "scan_mode": mode,
            "skill_count": report.get("skill_count"),
            "aggregate_recommendation": rec,
            "min_security_score": report.get("min_security_score"),
            "per_skill": summaries,
        }
    rec = report.get("deployment_recommendation", "CAUTION")
    return {
        "verdict": RECOMMENDATION_TO_VERDICT.get(rec, "review"),
        "isolated": isolated,
        "scan_mode": mode,
        "skill": report.get("skill"),
        "security_score": report.get("security_score"),
        "risk_classification": report.get("risk_classification"),
        "deployment_recommendation": rec,
        "hard_blocked": report.get("hard_blocked"),
        "attack_surface_summary": {
            "has_binaries": report.get("attack_surface", {}).get("has_binaries"),
            "binary_files": report.get("attack_surface", {}).get("binary_files"),
            "egress_points": len(report.get("attack_surface", {}).get("network_egress_points", [])),
            "dynamic_exec_points": len(report.get("attack_surface", {}).get("dynamic_execution_points", [])),
            "persistence_points": len(report.get("attack_surface", {}).get("persistence_points", [])),
        },
        "required_mitigations": [
            {"id": m["id"], "name": m["name"]} for m in report.get("required_mitigations", [])
        ],
        "vulnerability_count": len(report.get("vulnerability_findings", [])),
    }


def _run_sandboxed(skill_path: Path) -> dict[str, Any] | None:
    """在隔离容器中扫描。成功返回报告 dict，不可用返回 None。"""
    image = "skill-security-scanner:local"
    if not shutil.which("docker"):
        return None
    if subprocess.run(["docker", "image", "inspect", image],
                      capture_output=True).returncode != 0:
        return None
    with tempfile.TemporaryDirectory(prefix="gate-report-") as tmp:
        proc = subprocess.run(
            ["bash", str(SANDBOX_SCRIPT), str(skill_path), tmp],
            text=True, capture_output=True, timeout=300, check=False,
        )
        report_file = Path(tmp) / "report.json"
        if not report_file.is_file():
            return {"status": "ERROR",
                    "error": "沙箱扫描未产出报告",
                    "stderr": (proc.stderr or proc.stdout)[-800:]}
        try:
            return json.loads(report_file.read_text("utf-8"))
        except Exception as exc:
            return {"status": "ERROR", "error": f"报告解析失败: {exc}"}


def _run_degraded(skill_path: Path) -> dict[str, Any]:
    """无 Docker 时的降级：本地直跑扫描器（未隔离）。

    引擎自身已做 fail-closed 兜底（scan 内部异常返回 status=ERROR），
    这里再包一层，覆盖 import 失败等极端情况，绝不让异常向上冒泡。
    """
    try:
        import sys
        sys.path.insert(0, str(PROJECT_ROOT))
        from engine.scanner_core import scan  # type: ignore
        return scan(str(skill_path))
    except Exception as exc:
        return {"status": "ERROR",
                "error": f"降级扫描器加载/执行异常: {type(exc).__name__}: {exc}",
                "deployment_recommendation": "DO_NOT_INSTALL", "security_score": 0}


def evaluate_skill(skill_path: str, require_isolation: bool = False) -> dict[str, Any]:
    """
    Agent 调用的唯一入口。返回精简裁决面（不含被测 Skill 原始内容）。

    参数:
      skill_path        被测 Skill 目录 / 含 SKILL.md 的目录 / zip 包
      require_isolation True 时若无法隔离直接拒绝（fail-closed），
                        适合核心环境；False 时降级本地扫描并标注 isolated=False。
    """
    path = Path(skill_path).resolve()
    if not path.exists():
        return {"verdict": "deny", "isolated": False, "error": f"path not found: {path}"}

    report = _run_sandboxed(path)
    if report is not None:
        if report.get("status") == "ERROR":
            # 沙箱内出错：fail-closed，交人工复核而非放行
            return {"verdict": "review", "isolated": True, "scan_mode": "sandbox-error",
                    "error": report.get("error"), "detail": report.get("stderr")}
        return _summarize(report, isolated=True, mode="sandbox")

    # 无法隔离
    if require_isolation:
        return {"verdict": "deny", "isolated": False, "scan_mode": "no-sandbox",
                "reason": "要求隔离但沙箱不可用（未安装 Docker 或镜像未构建），fail-closed 拒绝"}
    degraded = _run_degraded(path)
    if degraded.get("status") == "ERROR":
        # 降级扫描内部异常：fail-closed，交人工复核，绝不放行
        return {"verdict": "review", "isolated": False, "scan_mode": "degraded-error",
                "error": degraded.get("error"),
                "warning": "降级扫描执行异常，无法给出安全裁决，已转人工复核（fail-closed）"}
    result = _summarize(degraded, isolated=False, mode="degraded-local")
    result["warning"] = "未隔离运行，裁决可信度较低；核心环境请构建沙箱镜像后重试"
    return result


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Agent 合规裁决入口")
    ap.add_argument("--skill", required=True)
    ap.add_argument("--require-isolation", action="store_true",
                    help="无法隔离时直接拒绝（核心环境推荐）")
    args = ap.parse_args()
    print(json.dumps(evaluate_skill(args.skill, args.require_isolation),
                     ensure_ascii=False, indent=2))
