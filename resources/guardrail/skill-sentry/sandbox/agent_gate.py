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

#: 严格度排序。与 `engine.scanner_core.scoring.worst_recommendation` 和
#: `skill_guard.install_gate` 的 fail_rank 是同一套语义，不要另立一套。
RECOMMENDATION_RANK = {"ALLOW": 0, "CAUTION": 1, "DO_NOT_INSTALL": 2}


def _recommendation_of(summary: dict[str, Any]) -> str:
    """取一份裁决面的部署建议。多 Skill 聚合时读 aggregate_recommendation。"""
    return (summary.get("deployment_recommendation")
            or summary.get("aggregate_recommendation")
            or "CAUTION")


def _tier_evidence(tier: str, summary: dict[str, Any]) -> dict[str, Any]:
    """记录某一层给出的是什么，供上层审计「这个结论是谁给的」。

    `scanner_version` 是这里最要紧的一个字段：隔离层落版本时，只有把它带进
    裁决面，「结论来自一个更旧的引擎」才是可看见的。
    """
    return {
        "tier": tier,
        "mode": summary.get("scan_mode"),
        "isolated": summary.get("isolated"),
        "recommendation": _recommendation_of(summary),
        "verdict": summary.get("verdict"),
        "security_score": summary.get("security_score"),
        "scanner_version": summary.get("scanner_version"),
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
            "scanner_version": report.get("scanner_version"),
            "per_skill": summaries,
        }
    rec = report.get("deployment_recommendation", "CAUTION")
    return {
        "verdict": RECOMMENDATION_TO_VERDICT.get(rec, "review"),
        "isolated": isolated,
        "scan_mode": mode,
        "skill": report.get("skill"),
        "scanner_version": report.get("scanner_version"),
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

    两层取更严，而不是「沙箱优先」
    ------------------------------
    隔离层只有在**与本地引擎同版本**时才算一次更强的证据。镜像里的引擎落后时，
    它给出的是更弱的裁决——实测 `skill-security-scanner:local` 内是 1.0.0，对
    `os.system('rm -rf /')` 只给 CAUTION/HIGH，而当前引擎给 DO_NOT_INSTALL。
    「沙箱优先」于是等于让一个更旧的引擎覆盖一个更新的引擎：装了 Docker 的机器
    门禁比没装 Docker 的更弱，安全姿态被环境反转。

    现在的规则是：隔离层可以加强结论，不能削弱结论。两层都算，取更严的那个，
    并把两层的结论、隔离状态与 `scanner_version` 一起放进 `tier_evidence`，
    让「这个结论是谁给的」可审计。

    代价是有 Docker 时多跑一次本地静态扫描（`scan()` 只做静态分析，不执行被测
    代码；被测内容在进程内被解析这一点与无 Docker 时的降级路径相同）。沙箱已经
    判 DO_NOT_INSTALL 时直接返回，不再跑本地层——没有更严的结论可拿。

    参数:
      skill_path        被测 Skill 目录 / 含 SKILL.md 的目录 / zip 包
      require_isolation True 时若无法隔离直接拒绝（fail-closed），
                        适合核心环境；False 时降级本地扫描并标注 isolated=False。
    """
    path = Path(skill_path).resolve()
    if not path.exists():
        return {"verdict": "deny", "isolated": False, "error": f"path not found: {path}"}

    report = _run_sandboxed(path)
    if report is None and require_isolation:
        return {"verdict": "deny", "isolated": False, "scan_mode": "no-sandbox",
                "reason": "要求隔离但沙箱不可用（未安装 Docker 或镜像未构建），fail-closed 拒绝"}

    tiers: list[dict[str, Any]] = []
    sandbox_summary: dict[str, Any] | None = None
    if report is not None:
        if report.get("status") == "ERROR":
            # 沙箱内出错：fail-closed，交人工复核而非放行
            sandbox_summary = {"verdict": "review", "isolated": True, "scan_mode": "sandbox-error",
                               "error": report.get("error"), "detail": report.get("stderr"),
                               "scanner_version": report.get("scanner_version")}
        else:
            sandbox_summary = _summarize(report, isolated=True, mode="sandbox")
        tiers.append(_tier_evidence("sandbox", sandbox_summary))
        if _recommendation_of(sandbox_summary) == "DO_NOT_INSTALL":
            sandbox_summary["tier_evidence"] = tiers
            sandbox_summary["strictest_tier"] = "sandbox"
            return sandbox_summary

    degraded = _run_degraded(path)
    if degraded.get("status") == "ERROR":
        # 降级扫描内部异常：fail-closed，交人工复核，绝不放行
        local_summary: dict[str, Any] = {
            "verdict": "review", "isolated": False, "scan_mode": "degraded-error",
            "error": degraded.get("error"),
            "warning": "降级扫描执行异常，无法给出安全裁决，已转人工复核（fail-closed）",
            "scanner_version": degraded.get("scanner_version"),
        }
    else:
        local_summary = _summarize(degraded, isolated=False, mode="degraded-local")
        local_summary["warning"] = "未隔离运行，裁决可信度较低；核心环境请构建沙箱镜像后重试"
    tiers.append(_tier_evidence("degraded-local", local_summary))

    if sandbox_summary is None:
        local_summary["tier_evidence"] = tiers
        local_summary["strictest_tier"] = "degraded-local"
        return local_summary

    if (RECOMMENDATION_RANK[_recommendation_of(local_summary)]
            > RECOMMENDATION_RANK[_recommendation_of(sandbox_summary)]):
        # 本地引擎更严：隔离层落后于当前引擎时就走这里，结论不被拉低
        local_summary["strictest_tier"] = "degraded-local"
        local_summary["note"] = ("本地引擎给出的裁决比隔离层更严，已采用更严的那个："
                                 "隔离层只有在与本地引擎同版本时才是更强的证据")
        local_summary["tier_evidence"] = tiers
        return local_summary

    sandbox_summary["strictest_tier"] = "sandbox"
    sandbox_summary["tier_evidence"] = tiers
    return sandbox_summary


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Agent 合规裁决入口")
    ap.add_argument("--skill", required=True)
    ap.add_argument("--require-isolation", action="store_true",
                    help="无法隔离时直接拒绝（核心环境推荐）")
    args = ap.parse_args()
    print(json.dumps(evaluate_skill(args.skill, args.require_isolation),
                     ensure_ascii=False, indent=2))
