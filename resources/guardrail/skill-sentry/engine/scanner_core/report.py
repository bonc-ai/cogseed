"""
report.py — 报告组装（9 字段契约）+ 对外调用入口
====================================================

组装最终报告的 9 个核心字段（对应需求 3.3），并提供 scan() 作为
可编程调用入口（供上层 Agent / CI 集成）。
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from typing import Any

from . import binary_rules, external_tools, text_rules
from .path_security import collect_evidence, locate_skill_roots, safe_extract
from .result_models import make_finding
from .rule_loader import DEFAULT_RULESET_VERSION, load_rules
from .scoring import classify_risk, compute_score, deployment_recommendation, worst_recommendation

SCANNER_VERSION = "2.1.0"


def build_report(skill_dir: Path, rel_name: str, rules: dict[str, Any],
                  findings: list[dict[str, Any]], sr_items: list[dict[str, Any]],
                  profile: dict[str, Any], binary_result: dict[str, Any],
                  tool_status: dict[str, Any]) -> dict[str, Any]:
    hard_blocked = any(f.get("hard_block") for f in findings)
    has_critical = any(f["severity"] == "critical" for f in findings)
    # 未被上下文降权的 critical：真实源码里的破坏性命令，单条即足以拒装。
    confirmed_critical = any(
        f["severity"] == "critical" and not f.get("demoted") for f in findings
    )
    score = compute_score(findings)
    risk = classify_risk(score, hard_blocked, has_critical)
    required_failed = any(not it["passed"] and it["required"] for it in sr_items)
    recommendation = deployment_recommendation(
        risk, hard_blocked, required_failed, confirmed_critical=confirmed_critical,
    )

    attack_surface = {
        "network_egress_points": [f for f in findings if f["category"] in ("data_egress", "network", "ssrf")][:20],
        "dynamic_execution_points": [f for f in findings if f["category"] in ("dynamic_exec", "deserialization", "obfuscation")][:20],
        "persistence_points": [f for f in findings if f["category"] == "persistence"][:20],
        "binary_files": binary_result.get("binary_count", 0),
        "has_binaries": binary_result.get("binary_count", 0) > 0,
    }
    permission_summary = {
        "declares_permissions": profile["has_permissions"],
        "has_hitl": profile["has_hitl"],
        "has_side_effects": profile["has_side_effects"],
        "note": "基于文本声明的启发式判断，非运行时实际权限",
    }
    data_access_summary = {
        "network_used": profile["network_used"],
        "egress_findings": len(attack_surface["network_egress_points"]),
        "has_audit": profile["has_audit"],
        "binary_network_indicators": [b for b in binary_result.get("findings", []) if b.get("category", "").startswith("network")][:20],
    }
    dangerous_action_list = [
        {"rule_id": f["rule_id"], "category": f["category"], "severity": f["severity"],
         "file": f["file"], "line": f["line"], "description": f["description"]}
        for f in findings if f["category"] in
        ("destructive", "privilege", "unauthorized_download", "dynamic_exec",
         "deserialization", "obfuscation", "sql_injection", "persistence", "cognitive_asset_exfil")
    ][:50]
    vulnerability_findings = [f for f in findings if f["category"] == "dependency_vuln"]
    required_mitigations = [
        {"id": it["id"], "name": it["name"], "recommendation": it["recommendation"]}
        for it in sr_items if not it["passed"]
    ]

    return {
        "scanner": "skill-sentry",
        "scanner_version": SCANNER_VERSION,
        "ruleset_version": rules.get("ruleset_version", DEFAULT_RULESET_VERSION),
        "skill": rel_name,
        "skill_path": str(skill_dir),
        # ---- 3.3 要求的 9 个输出字段 ----
        "security_score": score,
        "risk_classification": risk,
        "attack_surface": attack_surface,
        "permission_summary": permission_summary,
        "data_access_summary": data_access_summary,
        "dangerous_action_list": dangerous_action_list,
        "vulnerability_findings": vulnerability_findings,
        "required_mitigations": required_mitigations,
        "deployment_recommendation": recommendation,
        # ---- 支撑信息 ----
        "sr_items": sr_items,
        "findings": findings,
        "hard_blocked": hard_blocked,
        "binary_scan": binary_result,
        "tool_status": tool_status,
        "rules_source": rules.get("_rules_source"),
        "ruleset_resolved": rules.get("_ruleset_resolved", True),
        "limitations": [
            "文本检测以正则/关键词为主，存在误报与漏报，分数为启发式而非绝对度量",
            "上下文降权基于静态启发式（路径命名 + 轻量注释解析）：test/vendor 目录里的命中会被压低严重级，"
            "强制拦截场景应同时消费 finding 的 original_severity 字段",
            "二进制扫描当前仅静态层（strings+指标），未接入动态沙箱，无法确认真实运行时行为",
            "依赖漏洞(CVE)、密钥扫描依赖外部工具（osv-scanner/gitleaks），未安装时能力降级",
            "误报率基线仅在单一语料（43 个 Skill，以 Markdown/Python/TypeScript 为主）上验证",
        ],
    }


def scan_one_skill(skill_dir: Path, rel_name: str, ruleset_version: str = DEFAULT_RULESET_VERSION) -> dict[str, Any]:
    rules = load_rules(ruleset_version)
    files, docs = collect_evidence(skill_dir)
    findings = text_rules.scan_regex_rules(docs, rules)
    findings += text_rules.scan_forbidden_files(files, rules)

    tool_status: dict[str, Any] = {}
    gl = external_tools.enhance_with_gitleaks(skill_dir)
    tool_status["gitleaks"] = gl["status"]
    findings += gl.get("findings", [])
    dep = external_tools.enhance_with_dependency_audit(skill_dir)
    tool_status["osv_scanner"] = dep["status"]
    findings += dep.get("findings", [])

    binary_result = binary_rules.scan_binaries(skill_dir)
    for bf in binary_result.get("findings", []):
        findings.append(make_finding("SR-BIN", "binary_indicator", bf.get("severity", "low"),
                                      bf.get("category", "binary"), bf.get("file", ""), None,
                                      f"二进制字符串指标: {bf.get('indicator', '')}",
                                      "对二进制组件做动态沙箱行为分析确认读写/外发", source="binary-strings"))
    tool_status["binary_scan"] = "static-only"

    profile = text_rules.build_profile(files, docs, rules)
    sr_items = text_rules.evaluate_sr_items(profile, findings)
    return build_report(skill_dir, rel_name, rules, findings, sr_items, profile, binary_result, tool_status)


def scan(artifact_path: str, ruleset_version: str = DEFAULT_RULESET_VERSION) -> dict[str, Any]:
    """
    可编程调用入口（供 Skill Factory / Agent Factory 等系统集成）。
    输入：Skill 目录、含 SKILL.md 的目录、或 Skill zip 包路径。
    输出：单 Skill 时返回单份报告；多 Skill 时返回聚合报告。
    """
    artifact = Path(artifact_path).resolve()
    if not artifact.exists():
        return {"status": "ERROR", "error": f"artifact not found: {artifact}",
                "deployment_recommendation": "DO_NOT_INSTALL", "security_score": 0,
                "risk_classification": "CRITICAL"}

    try:
        return _scan_impl(artifact, ruleset_version)
    except Exception as exc:
        # fail-closed 顶层兜底：解压/定位/临时目录等任何环节崩溃，一律
        # 判为不可安装，绝不因异常而静默放行。
        return {"status": "ERROR",
                "error": f"扫描流程异常: {type(exc).__name__}: {exc}",
                "deployment_recommendation": "DO_NOT_INSTALL", "security_score": 0,
                "risk_classification": "CRITICAL", "hard_blocked": True}


def _scan_impl(artifact: Path, ruleset_version: str) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="skill-sentry-") as tmp:
        source = safe_extract(artifact, Path(tmp) / "artifact") if artifact.is_file() else artifact
        roots = locate_skill_roots(source)
        reports = []
        for root in roots:
            try:
                rel = "." if root == source else root.relative_to(source).as_posix()
            except ValueError:
                rel = root.name
            try:
                reports.append(scan_one_skill(root, rel, ruleset_version))
            except Exception as exc:
                # fail-closed：任何单 Skill 扫描崩溃 → 记为 ERROR 且给出最严
                # 部署建议，绝不因「扫描没跑完」而放行（对齐调研文档要求：
                # 扫描出错或无法完成，视为不通过）。
                reports.append({
                    "status": "ERROR",
                    "skill": rel,
                    "skill_path": str(root),
                    "error": f"扫描执行异常: {type(exc).__name__}: {exc}",
                    "security_score": 0,
                    "risk_classification": "CRITICAL",
                    "deployment_recommendation": "DO_NOT_INSTALL",
                    "hard_blocked": True,
                })

    if len(reports) == 1:
        result = reports[0]
        # 不要覆盖已标记的 ERROR（fail-closed）：单 Skill 扫描崩溃时保留 ERROR
        if result.get("status") != "ERROR":
            result["status"] = "OK"
        return result

    worst = worst_recommendation([r["deployment_recommendation"] for r in reports])
    return {
        "status": "OK",
        "scanner": "skill-sentry",
        "skill_count": len(reports),
        "aggregate_recommendation": worst,
        "min_security_score": min((r["security_score"] for r in reports), default=100),
        "reports": reports,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Skill Sentry — Skill 安全静态扫描 + 信任网关引擎")
    parser.add_argument("--artifact", required=True, help="Skill 目录 / 含 SKILL.md 的目录 / Skill zip 包")
    parser.add_argument("--output", help="报告输出路径（JSON）；不填则打印到 stdout")
    parser.add_argument("--ruleset-version", default=DEFAULT_RULESET_VERSION, help="使用的规则包版本")
    parser.add_argument("--fail-on", default="DO_NOT_INSTALL",
                         choices=["DO_NOT_INSTALL", "CAUTION", "ALLOW", "never"],
                         help="达到该部署建议等级时以非 0 退出码返回（用于 CI 强制拦截）")
    args = parser.parse_args()

    result = scan(args.artifact, args.ruleset_version)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, "utf-8")
        print(out)
    else:
        print(payload)

    if result.get("status") == "ERROR":
        return 2
    rec = result.get("deployment_recommendation") or result.get("aggregate_recommendation") or "ALLOW"
    if args.fail_on == "never":
        return 0
    order = {"ALLOW": 0, "CAUTION": 1, "DO_NOT_INSTALL": 2}
    return 1 if order.get(rec, 0) >= order.get(args.fail_on, 2) else 0


if __name__ == "__main__":
    raise SystemExit(main())
