"""
report.py — 报告组装（契约字段）+ 对外调用入口
==================================================

组装最终报告，并提供 scan() 作为可编程调用入口（供上层 Agent / CI 集成）。

2.2.0 的报告新增了四组字段，都是为了让下游能**回答具体问题**而不是只看到一个分数：

- ``score_breakdown``：分数怎么来的（每个类别的扣分、封顶、触发的下限）。
  UI 因此能回答「为什么是 42 分」，而不是让用户面对一个不可解释的数字。
- ``framework_summary``：命中映射到 OWASP LLM Top 10 / Agentic Top 10 的哪几条。
- ``coverage``：这次扫描**实际覆盖了什么**——加载了多少条规则、哪些外部工具
  可用、扫了多少文件、走的哪条扫描路径。没有这一节，「100 分」无法区分
  「全量规则扫过且干净」与「规则没加载但也没报错」。
- ``severity_counts`` / ``structural_summary`` / ``dependency_manifests``：
  事实性统计，供 UI 展示「这个 Skill 里到底有什么」。
"""
from __future__ import annotations

import argparse
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import (agentic_rules, baseline as baseline_mod, binary_rules, derived_views,
               external_tools, hidden_content, obfuscation, structural, supply_chain,
               text_rules)
from .mappings import framework_summary
from .path_security import collect_evidence, locate_skill_roots, safe_extract
from .context import build_contexts
from .result_models import SEVERITY_ORDER, fingerprint_for, make_finding
from .rule_loader import DEFAULT_RULESET_VERSION, load_rules
from .scoring import (classify_risk, compute_score_details, deployment_recommendation,
                      is_confirmed_critical, worst_recommendation)

SCANNER_VERSION = "2.2.0"
SCHEMA_VERSION = "2.0.0"

#: 类别 → 是否属于「攻击面」三分类之一（供 UI 的分布图使用）。
_SURFACE_KEYS = {
    "network_egress_points": ("data_egress", "network", "ssrf"),
    "dynamic_execution_points": ("dynamic_exec", "deserialization", "obfuscation",
                                 "reverse_shell", "command_exec"),
    "persistence_points": ("persistence", "mcp_config", "install_hook"),
}


def _severity_counts(findings: list[dict[str, Any]]) -> dict[str, int]:
    counts = {level: 0 for level in ("critical", "high", "medium", "low", "info")}
    for f in findings:
        level = str(f.get("severity") or "info")
        if level in counts:
            counts[level] += 1
    return counts


def _coverage(rules: dict[str, Any], docs: list[tuple[str, str]], files: set[str],
              tool_status: dict[str, Any], contexts: dict[str, Any]) -> dict[str, Any]:
    """本次扫描的覆盖事实。

    ``rules_source`` 已经存在，但那只是一个字符串；这里把「多少条规则、
    哪些类别、哪些外部工具、哪些上下文」一并给出，让「分数高」这件事
    可以被追问。
    """
    groups = rules.get("rule_groups") or {}
    rule_total = sum(len(v) for v in groups.values() if isinstance(v, list))
    rule_total += len(rules.get("secret_patterns") or [])
    rule_total += len(rules.get("hard_block") or [])
    ctx_counts: dict[str, int] = {}
    for fctx in contexts.values():
        level = getattr(fctx, "file_ctx", None)
        if level is None:
            # 兼容直接传字符串上下文的调用方（测试与外部集成）。
            level = str(fctx)
        ctx_counts[level] = ctx_counts.get(level, 0) + 1
    invalid = rules.get("_invalid_rules") or []
    return {
        "files_scanned": len(docs),
        "files_seen": len(files),
        "bytes_scanned": sum(len(t) for _, t in docs),
        "rule_count": rule_total,
        "rule_groups": sorted(groups.keys()),
        "hard_block_rules": len(rules.get("hard_block") or []),
        "contexts": ctx_counts,
        "external_tools": {
            "gitleaks": str(tool_status.get("gitleaks", "SKIPPED")),
            "osv_scanner": str(tool_status.get("osv_scanner", "SKIPPED")),
            "binary_strings": str(tool_status.get("binary_scan", "static-only")),
        },
        "rules_source": str(rules.get("_rules_source") or ""),
        # 规则包是否按请求的版本解析成功。False 意味着实际跑的是内置最小规则集，
        # 报告的「全绿」并不代表完整规则集覆盖过——UI 必须能说出这一点。
        "ruleset_resolved": bool(rules.get("_ruleset_resolved", True)),
        # 编译失败的规则。一条写错的正则会让那类检测静默失效，因此它必须
        # 出现在覆盖信息里，而不是只留在日志里。
        "invalid_rules": invalid,
        "ruleset_version": str(rules.get("ruleset_version") or ""),
    }


def _scan_derived_views(docs: list[tuple[str, str]],
                        rules: dict[str, Any],
                        original: list[dict[str, Any]] | None = None
                        ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """对每个文件的派生视图再跑一遍检测，并把命中标记为派生。

    为什么降置信度而不是直接采信：派生视图的命中经过了一次文本变换，
    「原文里到底是不是这么写的」需要人回去确认。降级保留可审计性，
    直接采信会把归一化引入的误报变成扣分。

    行号只在**归一化视图**上保留——那三类变换不触碰换行。解码视图不给
    行号：解码结果的第 N 行在原文里不存在。
    """
    out: list[dict[str, Any]] = []
    views_by_kind: dict[str, int] = {}
    seen: set[str] = set()
    # 归一化视图里「本来就命中过」的项要去掉。
    #
    # 归一化是逐字符变换，绝大多数行不受影响；不过滤的话每个 finding 都会
    # 在派生 pass 里原样出现第二遍（描述带上了「经 normalized 后检出」，
    # 所以按描述去重挡不住它）。派生 pass 的价值**只在于新增的检出**，
    # 重复项只会让发现项列表变长一倍、让用户以为问题翻倍。
    already: set[tuple[str, str, Any]] = {
        (str(f.get("rule_id")), str(f.get("file")), f.get("line"))
        for f in (original or [])
    }
    for rel, text in docs:
        if not text:
            continue
        for view_name, view_text in derived_views.derived_views(rel, text):
            views_by_kind[view_name] = views_by_kind.get(view_name, 0) + 1
            vdocs = [(rel, view_text)]
            vctx = build_contexts(vdocs)
            line_ok = view_name == "normalized"
            produced = (
                text_rules.scan_regex_rules(vdocs, rules)
                + hidden_content.scan_hidden_content(vdocs, vctx)
                + obfuscation.scan_obfuscation(vdocs, vctx)
                + agentic_rules.scan_agentic(vdocs, vctx)
            )
            for f in produced:
                if view_name == "normalized" and (
                        str(f.get("rule_id")), str(f.get("file")), f.get("line")) in already:
                    continue
                # 同一个问题可能在多个视图里各命中一次；按
                # (规则, 文件, 描述) 去重，避免同一载荷算三份。
                key = f"{f['rule_id']}\x00{f['file']}\x00{f['description']}"
                if key in seen:
                    continue
                seen.add(key)
                out.append(_as_derived(f, view_name, line_ok))
    stats = {
        "views": views_by_kind,
        "findings": len(out),
    }
    return out, stats


#: 派生视图命中的置信度上限。见 _scan_derived_views 的说明。
_DERIVED_CONFIDENCE_CAP = {"high": "medium", "medium": "low", "low": "low"}


def _as_derived(finding: dict[str, Any], view_name: str, line_ok: bool) -> dict[str, Any]:
    note = derived_views.VIEW_NOTES.get(view_name, view_name)
    out = {
        **finding,
        "derived": view_name,
        "derived_note": note,
        "confidence": _DERIVED_CONFIDENCE_CAP.get(str(finding.get("confidence")), "low"),
        "description": finding["description"] + f"（经{note}后检出）",
    }
    if not line_ok:
        # 解码视图的行号在原文里没有对应位置。给 null 而不是猜测。
        out["line"] = None
        out["original_line"] = finding.get("line")
    # 指纹里带上视图名：同一段文本的原始命中与解码命中是两个不同的事实。
    out["fingerprint"] = fingerprint_for(
        str(finding.get("rule_id") or ""), str(finding.get("file") or ""),
        f"{view_name}:{finding.get('line')}:{finding.get('description')}",
    )
    return out


def coverage_findings(rules: dict[str, Any], docs: list[tuple[str, str]],
                      files: set[str], tool_status: dict[str, Any]) -> list[dict[str, Any]]:
    """把「这次没扫到什么」也报成 finding。

    理由（来自 Ramparts 的 `ScanCoverageIncomplete`）：**一个部分扫描得到的
    干净结果，不是「这个包是干净的」的证据**。此前覆盖信息只出现在报告的
    `coverage` 字段里，而那是个统计区——用户读的是发现项列表。把缺口放进
    发现项列表，它才会被读到。

    严重级固定为 ``info``，因此**不参与打分**：覆盖不足是关于「这次检查」的
    陈述，不是关于「这个技能」的陈述。

    这个取值是实测调出来的。第一版用 ``low``，结果是：在没装
    gitleaks / osv-scanner 的机器上**每一个技能的上限都变成 95 分**——
    「100 分 = 没发现问题」这个信号当场失效，而用户无法通过任何操作把分数
    拿回来。一条永远存在的扣分项与一条永远存在的提示，前者的代价大得多。
    ``info`` 仍然会出现在发现项列表里（这正是把它做成 finding 的目的），
    只是不再影响分数。
    """
    out: list[dict[str, Any]] = []
    skipped = len(files) - len(docs)
    if skipped > 0:
        out.append(make_finding(
            "SR-COV", "scan_coverage_incomplete", "info", "scan_coverage",
            "(skill)", None,
            f"有 {skipped} 个文件未做文本分析（二进制或超限），本次结论未覆盖它们",
            "对未覆盖的文件做人工复核，或提供可读源码版本。",
            source="coverage", context="source", confidence="high",
            snippet=f"skipped:{skipped}",
        ))
    invalid = rules.get("_invalid_rules") or []
    if invalid:
        out.append(make_finding(
            "SR-COV", "scan_rules_failed_to_compile", "info", "scan_coverage",
            "(ruleset)", None,
            f"有 {len(invalid)} 条规则编译失败，对应检测本次未生效",
            "修正规则包中的正则语法后重新扫描。",
            source="coverage", context="source", confidence="high",
            snippet=",".join(str(r.get("id")) for r in invalid[:5]),
        ))
    tools = {k: str(v) for k, v in (tool_status or {}).items()}
    missing_tools = [k for k, v in tools.items() if v == "SKIPPED"]
    if missing_tools:
        out.append(make_finding(
            "SR-COV", "scan_external_tools_missing", "info", "scan_coverage",
            "(tooling)", None,
            "外部增强工具不可用：" + "、".join(sorted(missing_tools))
            + "。其中 osv-scanner 缺失会让依赖漏洞(CVE)查询整个不启用；"
            "gitleaks 缺失只是密钥检测少一层增强，内置规则仍在跑",
            "装 osv-scanner 可启用依赖漏洞(CVE)查询；装 gitleaks 可扩大密钥检测覆盖。"
            "两者都不影响其余检查。",
            source="coverage", context="source", confidence="high",
            snippet=",".join(sorted(missing_tools)),
        ))
    return out


def build_report(skill_dir: Path, rel_name: str, rules: dict[str, Any],
                  findings: list[dict[str, Any]], sr_items: list[dict[str, Any]],
                  profile: dict[str, Any], binary_result: dict[str, Any],
                  tool_status: dict[str, Any], *,
                  structural_result: dict[str, Any] | None = None,
                  manifests: dict[str, Any] | None = None,
                  baseline_stats: dict[str, Any] | None = None) -> dict[str, Any]:
    structural_result = structural_result or {"findings": [], "summary": {}}
    manifests = manifests or {}
    baseline_stats = baseline_stats or {}

    # 抑制项仍留在报告里，但不参与打分与裁决——见 baseline.py 的模块文档。
    active = [f for f in findings if not f.get("suppressed")]
    hard_blocked = any(f.get("hard_block") for f in active)
    has_critical = any(f["severity"] == "critical" for f in active)
    # 未被上下文降权、且非低置信的 critical：真实源码里的破坏性命令，
    # 单条即足以拒装。
    confirmed_critical = is_confirmed_critical(active)
    details = compute_score_details(
        active, hard_blocked=hard_blocked, confirmed_critical=confirmed_critical,
    )
    score = details["score"]
    risk = classify_risk(score, hard_blocked, has_critical, confirmed_critical)
    required_failed = any(not it["passed"] and it["required"] for it in sr_items)
    recommendation = deployment_recommendation(
        risk, hard_blocked, required_failed, confirmed_critical=confirmed_critical,
    )

    attack_surface = {
        "network_egress_points": [f for f in active
                                  if f["category"] in _SURFACE_KEYS["network_egress_points"]][:20],
        "dynamic_execution_points": [f for f in active
                                     if f["category"] in _SURFACE_KEYS["dynamic_execution_points"]][:20],
        "persistence_points": [f for f in active
                               if f["category"] in _SURFACE_KEYS["persistence_points"]][:20],
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
        "binary_network_indicators": [b for b in binary_result.get("findings", [])
                                      if b.get("category", "").startswith("network")][:20],
    }
    dangerous_action_list = [
        {"rule_id": f["rule_id"], "category": f["category"], "severity": f["severity"],
         "file": f["file"], "line": f["line"], "description": f["description"]}
        for f in active if f["category"] in
        ("destructive", "privilege", "unauthorized_download", "dynamic_exec",
         "deserialization", "obfuscation", "sql_injection", "persistence",
         "cognitive_asset_exfil", "reverse_shell", "command_exec", "surveillance")
    ][:50]
    vulnerability_findings = [f for f in active if f["category"] == "dependency_vuln"]
    required_mitigations = [
        {"id": it["id"], "name": it["name"], "recommendation": it["recommendation"]}
        for it in sr_items if not it["passed"]
    ]

    # 按严重级 → 类别 → 文件排序，让报告的最前面就是最该看的。
    findings_sorted = sorted(
        findings,
        key=lambda f: (-SEVERITY_ORDER.get(str(f.get("severity")), 0),
                       str(f.get("category") or ""), str(f.get("file") or ""),
                       f.get("line") or 0),
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "scanner": "skill-sentry",
        "scanner_version": SCANNER_VERSION,
        "ruleset_version": rules.get("ruleset_version", DEFAULT_RULESET_VERSION),
        "skill": rel_name,
        "skill_path": str(skill_dir),
        "scanned_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        # ---- 核心结论 ----
        "security_score": score,
        "risk_classification": risk,
        "deployment_recommendation": recommendation,
        "score_breakdown": details,
        "severity_counts": _severity_counts(active),
        "framework_summary": framework_summary(active),
        "attack_surface": attack_surface,
        "permission_summary": permission_summary,
        "data_access_summary": data_access_summary,
        "dangerous_action_list": dangerous_action_list,
        "vulnerability_findings": vulnerability_findings,
        "required_mitigations": required_mitigations,
        # ---- 支撑信息 ----
        "sr_items": sr_items,
        "findings": findings_sorted,
        "hard_blocked": hard_blocked,
        "confirmed_critical": confirmed_critical,
        "binary_scan": binary_result,
        "structural_summary": structural_result.get("summary", {}),
        "dependency_manifests": manifests,
        "baseline": baseline_stats,
        "tool_status": tool_status,
        "rules_source": rules.get("_rules_source"),
        "ruleset_resolved": rules.get("_ruleset_resolved", True),
        "limitations": [
            "文本检测以正则/关键词为主，存在误报与漏报，分数为启发式而非绝对度量",
            "上下文降权基于静态启发式（路径命名 + 轻量注释解析）：test/vendor 目录里的命中会被压低严重级，"
            "强制拦截场景应同时消费 finding 的 original_severity 字段",
            "不可见内容（零宽字符 / Unicode 标签块 / 双向控制符）不做上下文降权——"
            "它们不可见这一事实与所在目录无关",
            "置信度（confidence）反映规则本身的确定性，不反映命中内容是否真的有害",
            "二进制扫描当前仅静态层（strings+指标），未接入动态沙箱，无法确认真实运行时行为",
            "依赖漏洞(CVE)查询没有原生交付：未安装 osv-scanner 时该能力整个不启用"
            "（上层状态为 needs_tool，不是 degraded）",
            "密钥检测以内置 70 条具名规则 + 通用高熵检测为交付物，gitleaks 只是增强；"
            "未安装它不计为能力降级",
            "框架编号（CWE / OWASP LLM / OWASP Agentic）是风险分类提示，不是合规认证结论",
            "误报率基线仅在单一语料（66 个内置 Skill，以 Markdown/Python/TypeScript 为主）上验证",
        ],
    }


def scan_one_skill(skill_dir: Path, rel_name: str,
                   ruleset_version: str = DEFAULT_RULESET_VERSION) -> dict[str, Any]:
    rules = load_rules(ruleset_version)
    files, docs = collect_evidence(skill_dir)

    # 上下文只算一次，供所有模块共享（含压缩产物探测与注释扫描，有成本）。
    # 传 FileContext 而不是裸字符串：模块需要**行级**判定，否则文档里的
    # 「禁止 curl | sh」会和围栏代码块里的真命令得到同一个上下文。
    contexts = build_contexts(docs)

    findings = text_rules.scan_regex_rules(docs, rules)
    findings += text_rules.scan_forbidden_files(files, rules)
    findings += hidden_content.scan_hidden_content(docs, contexts)
    findings += obfuscation.scan_obfuscation(docs, contexts)
    findings += agentic_rules.scan_agentic(docs, contexts)

    # 反规避：归一化 + 迭代解码后重扫。见 derived_views.py 的模块文档。
    derived_findings, derived_stats = _scan_derived_views(docs, rules, findings)
    findings += derived_findings

    supply = supply_chain.scan_supply_chain(skill_dir, docs, contexts)
    findings += supply["findings"]

    structural_result = structural.scan_structure(skill_dir)
    findings += structural_result["findings"]

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
                                      "对二进制组件做动态沙箱行为分析确认读写/外发",
                                      source="binary-strings", confidence="medium",
                                      snippet=bf.get("indicator", "")))
    tool_status["binary_scan"] = "static-only"

    findings += coverage_findings(rules, docs, files, tool_status)

    profile = text_rules.build_profile(files, docs, rules)
    sr_items = text_rules.evaluate_sr_items(profile, findings)

    # 抑制清单：只影响计分与裁决，绝不移除 finding。
    accepted = baseline_mod.load_baseline(skill_dir)
    findings, baseline_stats = baseline_mod.apply_baseline(findings, accepted)

    report = build_report(skill_dir, rel_name, rules, findings, sr_items, profile,
                          binary_result, tool_status,
                          structural_result=structural_result,
                          manifests=supply["manifests"],
                          baseline_stats=baseline_stats)
    coverage = _coverage(rules, docs, files, tool_status, contexts)
    coverage["derived_views"] = derived_stats.get("views", {})
    coverage["derived_findings"] = derived_stats.get("findings", 0)
    # 扫描档位：一次「静态」通过和一次「沙箱」通过不是同一个安全声明，
    # UI 必须能把两者分开呈现，不能让用户把它们看成同一件事。
    coverage["scan_tier"] = "sandboxed" if report.get("isolated") else "static"
    report["coverage"] = coverage
    report["scan_tier"] = coverage["scan_tier"]
    return report


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
    # 聚合报告的 findings 是各子报告的并集：下游（SARIF / UI）需要一处能拿到
    # 全部发现项的地方，否则每个消费者都要自己展开 reports。
    merged = [f for r in reports for f in (r.get("findings") or [])]
    return {
        "status": "OK",
        "schema_version": SCHEMA_VERSION,
        "scanner": "skill-sentry",
        "scanner_version": SCANNER_VERSION,
        "skill_count": len(reports),
        "aggregate_recommendation": worst,
        "min_security_score": min((r["security_score"] for r in reports), default=100),
        "severity_counts": _severity_counts(merged),
        "framework_summary": framework_summary(merged),
        "findings": merged,
        "reports": reports,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Skill Sentry — Skill 安全静态扫描 + 信任网关引擎")
    parser.add_argument("--artifact", required=True, help="Skill 目录 / 含 SKILL.md 的目录 / Skill zip 包")
    parser.add_argument("--output", help="报告输出路径（JSON）；不填则打印到 stdout")
    parser.add_argument("--ruleset-version", default=DEFAULT_RULESET_VERSION, help="使用的规则包版本")
    parser.add_argument("--format", default="json", choices=["json", "sarif", "summary"],
                        help="输出格式：json（默认）/ sarif 2.1.0 / summary（人类可读摘要）")
    parser.add_argument("--fail-on", default="DO_NOT_INSTALL",
                         choices=["DO_NOT_INSTALL", "CAUTION", "ALLOW", "never"],
                         help="达到该部署建议等级时以非 0 退出码返回（用于 CI 强制拦截）")
    args = parser.parse_args()

    result = scan(args.artifact, args.ruleset_version)
    if args.format == "sarif":
        from .sarif import to_sarif
        payload = json.dumps(to_sarif(result), ensure_ascii=False, indent=2)
    elif args.format == "summary":
        payload = _human_summary(result)
    else:
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


def _human_summary(report: dict[str, Any]) -> str:
    """给终端看的一页摘要。

    CI 日志里翻 2000 行 JSON 是不现实的；这一格式把「结论 + 前 N 条最该看的
    发现」直接排版出来，详细数据仍走 --format json。
    """
    if report.get("status") == "ERROR":
        return f"扫描失败：{report.get('error')}"
    units = report.get("reports") if isinstance(report.get("reports"), list) else [report]
    lines: list[str] = []
    for unit in units:
        breakdown = unit.get("score_breakdown") or {}
        lines.append(f"── {unit.get('skill') or '.'} ──")
        lines.append(f"  分数 {unit.get('security_score')}/100 · {unit.get('risk_classification')}"
                     f" · {unit.get('deployment_recommendation')}")
        counts = unit.get("severity_counts") or {}
        lines.append("  发现 " + " ".join(f"{k}={counts.get(k, 0)}"
                                          for k in ("critical", "high", "medium", "low", "info")))
        cats = [c for c in (breakdown.get("by_category") or []) if c.get("penalty")]
        if cats:
            lines.append("  风险分布：" + " · ".join(
                f"{c['category']} -{c['penalty']}" + ("(封顶)" if c.get("capped") else "")
                for c in cats[:8]))
        top = [f for f in (unit.get("findings") or []) if not f.get("suppressed")][:10]
        for f in top:
            loc = f"{f.get('file')}:{f.get('line')}" if f.get("line") else str(f.get("file"))
            lines.append(f"  [{str(f.get('severity')).upper():8}] {f.get('rule_id')}  {loc}"
                         f"  ({f.get('category')}, {f.get('confidence')})")
            if f.get("cwe"):
                lines.append(f"             {' '.join(f['cwe'])}")
        if unit.get("deployment_recommendation") == "DO_NOT_INSTALL":
            lines.append("  → 不要安装。逐条修复上面的问题后重新扫描。")
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(main())
