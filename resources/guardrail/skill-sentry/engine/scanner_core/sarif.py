"""
sarif.py — SARIF 2.1.0 导出
=============================

为什么值得单独做一个导出器
--------------------------
在 SARIF 之前，本引擎的产出只有自家 JSON。这意味着扫描结果**只能留在本产品里**：
安全团队无法把它并进 DefectDojo / GitHub code scanning / Azure DevOps 的既有
告警流程，也无法与其它扫描器的结果按 CWE 归并——没有标准缺陷编号的告警在
聚合平台里排不进任何视图。

SARIF 是这条通道的通用语：GitHub code scanning 原生吃它，DefectDojo、Semgrep、
Trivy、CodeQL 都产出它。有了它，「Skill 安全扫描」才第一次能进入组织的
安全运营流程，而不是一个孤立的分数。

实现取舍
--------
- **不引入 jsonschema / sarif 依赖**。SARIF 的对象结构是固定的，手工拼装
  比引入依赖更可控，也符合本引擎「零第三方依赖」的既有约束（vendored PyYAML 除外）。
- **``partialFingerprints`` 用我们自己的稳定指纹**。GitHub 用它做「同一告警
  跨提交追踪」；传行号会让每次插入一行都变成新告警。
- **``artifactLocation.uri`` 是 Skill 内相对路径**，不是绝对路径。绝对路径会
  把用户的目录结构带进任何接收这份 SARIF 的系统。
- **等级映射是单向的**：SARIF 只有 note/warning/error 三级，我们把
  low→note、medium→warning、high/critical→error。原始级别保留在
  ``properties.originalSeverity`` 里，不丢信息。
"""
from __future__ import annotations

from typing import Any

from .mappings import OWASP_AGENTIC, OWASP_LLM, mapping_for

SARIF_VERSION = "2.1.0"
SARIF_SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json"

_LEVEL = {
    "critical": "error",
    "high": "error",
    "medium": "warning",
    "low": "note",
    "info": "note",
}

#: 工具信息。``informationUri`` 指向仓库内的说明文档而不是外部网址——
#: 这个组件可能被部署在没有公网的环境里。
_INFORMATION_URI = "https://github.com/bonc-ai/cogseed"


def _rule_descriptors(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按 rule_id 汇总规则元数据。SARIF 要求 rules 先去重再被 results 引用。"""
    seen: dict[str, dict[str, Any]] = {}
    for f in findings:
        rid = str(f.get("rule_id") or "unknown")
        if rid in seen:
            # 同一规则命中不同类别时不覆盖元数据，只把标签并起来。
            tags = seen[rid]["properties"]["tags"]
            for extra in _tags_for(f):
                if extra not in tags:
                    tags.append(extra)
            continue
        seen[rid] = {
            "id": rid,
            "name": rid,
            "shortDescription": {"text": str(f.get("description") or rid)[:200]},
            "fullDescription": {"text": _full_description(f)},
            "helpUri": (f.get("references") or [""])[0],
            "help": {
                "text": str(f.get("remediation") or ""),
                "markdown": f"**修复建议**\n\n{f.get('remediation') or ''}",
            },
            "defaultConfiguration": {"level": _LEVEL.get(str(f.get("severity")), "warning")},
            "properties": {
                "tags": _tags_for(f),
                "category": str(f.get("category") or ""),
                "confidence": str(f.get("confidence") or ""),
            },
        }
    return [seen[k] for k in sorted(seen)]


def _tags_for(f: dict[str, Any]) -> list[str]:
    tags = ["security"]
    for cwe in f.get("cwe") or []:
        tags.append(cwe)
    for key in f.get("owasp_llm") or []:
        tags.append(f"OWASP-LLM-{key}")
    for key in f.get("owasp_agentic") or []:
        tags.append(f"OWASP-{key}")
    cat = str(f.get("category") or "")
    if cat:
        tags.append(f"category:{cat}")
    return tags


def _full_description(f: dict[str, Any]) -> str:
    cat = str(f.get("category") or "")
    m = mapping_for(cat)
    parts = [str(f.get("description") or "")]
    if m.owasp_llm:
        parts.append("OWASP LLM: " + ", ".join(f"{k} {OWASP_LLM.get(k, '')}".strip()
                                               for k in m.owasp_llm))
    if m.owasp_agentic:
        parts.append("OWASP Agentic: " + ", ".join(f"{k} {OWASP_AGENTIC.get(k, '')}".strip()
                                                   for k in m.owasp_agentic))
    return "\n".join(p for p in parts if p)


def to_sarif(report: dict[str, Any]) -> dict[str, Any]:
    """把一份（单 Skill 或聚合）报告转成 SARIF 2.1.0 文档。

    聚合报告（多 Skill）会展开每份子报告，``artifactLocation.uri`` 带上
    子 Skill 的相对前缀，使告警在接收端仍可定位到具体文件。
    """
    reports = report.get("reports") if isinstance(report.get("reports"), list) else None
    units: list[tuple[str, dict[str, Any]]] = []
    if reports:
        for sub in reports:
            units.append((str(sub.get("skill") or ""), sub))
    else:
        units.append(("", report))

    all_findings: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    for prefix, unit in units:
        for f in unit.get("findings") or []:
            all_findings.append(f)
            path = str(f.get("file") or "")
            uri = f"{prefix}/{path}" if prefix and prefix != "." else path
            result: dict[str, Any] = {
                "ruleId": str(f.get("rule_id") or "unknown"),
                "level": _LEVEL.get(str(f.get("severity")), "warning"),
                "message": {"text": str(f.get("description") or "")},
                "locations": [{
                    "physicalLocation": {
                        "artifactLocation": {"uri": uri.replace("\\", "/")},
                        **({"region": {"startLine": int(f["line"])}}
                           if isinstance(f.get("line"), int) else {}),
                    },
                }],
                "partialFingerprints": {
                    "skillSentryFingerprint/v1": str(f.get("fingerprint") or ""),
                },
                "properties": {
                    "category": str(f.get("category") or ""),
                    "confidence": str(f.get("confidence") or ""),
                    "severity": str(f.get("severity") or ""),
                    "originalSeverity": str(f.get("original_severity") or ""),
                    "context": str(f.get("context") or ""),
                    "demoted": bool(f.get("demoted")),
                    "hardBlock": bool(f.get("hard_block")),
                    "cwe": list(f.get("cwe") or []),
                    "owaspLlm": list(f.get("owasp_llm") or []),
                    "owaspAgentic": list(f.get("owasp_agentic") or []),
                    "remediation": str(f.get("remediation") or ""),
                },
            }
            if prefix and prefix != ".":
                result["properties"]["skill"] = prefix
            results.append(result)

    score = report.get("security_score", report.get("min_security_score"))
    recommendation = report.get("deployment_recommendation") or report.get("aggregate_recommendation")
    run: dict[str, Any] = {
        "tool": {
            "driver": {
                "name": "skill-sentry",
                "version": str(report.get("scanner_version") or ""),
                "informationUri": _INFORMATION_URI,
                "rules": _rule_descriptors(all_findings),
            },
        },
        "results": results,
        "invocations": [{
            "executionSuccessful": report.get("status") != "ERROR",
            **({"toolExecutionNotifications": [{
                "level": "error",
                "message": {"text": str(report.get("error"))},
            }]} if report.get("error") else {}),
        }],
        "properties": {
            "rulesetVersion": str(report.get("ruleset_version") or ""),
            **({"securityScore": score} if score is not None else {}),
            **({"recommendation": recommendation} if recommendation else {}),
            **({"riskClassification": report.get("risk_classification")}
               if report.get("risk_classification") else {}),
        },
    }
    return {
        "$schema": SARIF_SCHEMA,
        "version": SARIF_VERSION,
        "runs": [run],
    }
