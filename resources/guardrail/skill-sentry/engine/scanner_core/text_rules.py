"""
text_rules.py — 文本规则匹配、语义画像、SR-01~08 判定
=========================================================

从原 skill_security_scanner.py 中拆出的核心检测逻辑：正则规则匹配、
禁止文件检查、语义画像构建（权限/审计/HITL 声明）、SR 项判定。
不含打分（见 scoring.py）、不含规则加载（见 rule_loader.py）。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .context import (
    CONTEXT_DOC,
    block_comment_lines,
    context_for_line,
    fenced_code_lines,
    file_context,
    rule_applies_to,
    severity_for,
)
from .result_models import make_finding

PERMISSION_TOKENS = ["allowed_tools", "permissions", "permission", "scope", "least privilege", "最小权限", "只读", "read-only"]
AUDIT_TOKENS = ["audit", "logging", "trace", "csoc", "审计", "日志", "留痕"]
HITL_TOKENS = ["hitl", "approval", "approve_required", "human", "人工", "审批", "确认"]
SIDE_EFFECT_TOKENS = ["delete", "remove", "send_email", "forward", "trash", "删除", "发送", "归档", "write_file"]
INJECTION_DEFENSE_TOKENS = ["prompt injection", "untrusted", "do not reveal", "system prompt", "提示注入", "不要泄露", "不信任"]


def scan_regex_rules(docs: list[tuple[str, str]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    fp_markers = [m.lower() for m in rules.get("false_positive_markers", [])]
    group_sr = rules.get("group_sr", {})
    group_remediation = rules.get("group_remediation", {})

    # 文件级上下文只算一次（vendor/test/doc 判定含压缩产物探测，有成本）。
    ctx_of = {rel: file_context(rel, text) for rel, text in docs}
    # docstring / 块注释行号集合，同样只算一次。
    block_of = {rel: block_comment_lines(rel, text) for rel, text in docs}
    # 文档的围栏代码块行号：区分「可照抄执行的命令」与「散文提及」。
    fenced_of = {
        rel: (fenced_code_lines(text) if ctx_of[rel] == CONTEXT_DOC else set())
        for rel, text in docs
    }

    def _ctx(rel: str, line: str, lineno: int) -> str:
        return context_for_line(rel, line, ctx_of[rel], lineno, block_of[rel], fenced_of[rel])

    # 密钥（SR-01）
    for spec in rules["secret_patterns"]:
        try:
            rx = re.compile(spec["pattern"])
        except re.error:
            continue
        for rel, text in docs:
            for lineno, line in enumerate(text.splitlines(), 1):
                if rx.search(line) and not any(m in line.lower() for m in fp_markers):
                    ctx = _ctx(rel, line, lineno)
                    declared = spec.get("severity", "high")
                    findings.append(make_finding("SR-01", spec["id"],
                                                  severity_for(declared, ctx),
                                                  "secret", rel, lineno, "疑似硬编码密钥/凭据",
                                                  "移除硬编码密钥，改用环境变量或密钥托管",
                                                  context=ctx, original_severity=declared))

    # 分类规则
    for group, specs in rules["rule_groups"].items():
        for spec in specs:
            try:
                rx = re.compile(spec["pattern"], re.IGNORECASE)
            except re.error:
                continue
            for rel, text in docs:
                # 语言分派：Python 专属规则不施加于 JS/TS，反之亦然。
                if not rule_applies_to(spec["id"], rel):
                    continue
                for lineno, line in enumerate(text.splitlines(), 1):
                    if rx.search(line):
                        ctx = _ctx(rel, line, lineno)
                        declared = spec.get("severity", "medium")
                        findings.append(make_finding(
                            group_sr.get(group, "SR-03"), spec["id"],
                            severity_for(declared, ctx),
                            spec.get("category", group), rel, lineno,
                            f"命中规则 {spec['id']}（{group}）",
                            group_remediation.get(group, "复核该模式是否必要"),
                            context=ctx, original_severity=declared,
                        ))

    # 一票否决（不降权：测试目录同样可以藏真实外传代码）
    for spec in rules["hard_block"]:
        try:
            rx = re.compile(spec["pattern"], re.IGNORECASE)
        except re.error:
            continue
        for rel, text in docs:
            for lineno, line in enumerate(text.splitlines(), 1):
                if rx.search(line):
                    findings.append(make_finding("SR-HB", spec["id"], "critical",
                                                  spec.get("category", "hard_block"), rel, lineno,
                                                  spec.get("reason", "命中一票否决黑名单"),
                                                  "禁止在核心环境安装/运行；需安全团队专项评估",
                                                  hard_block=True,
                                                  context=ctx_of[rel]))
    return findings


def scan_forbidden_files(files: set[str], rules: dict[str, Any]) -> list[dict[str, Any]]:
    findings = []
    for token in rules.get("forbidden_files", []):
        tl = token.lower().lstrip("*")
        for name in files:
            if name.endswith(tl) or Path(name).name == token.lower():
                findings.append(make_finding("SR-01", "forbidden_file", "high", "secret_file",
                                              name, None, f"存在敏感文件 {name}",
                                              "从 Skill 包中移除敏感文件，不要随包分发凭据"))
    return findings


def _contains(text: str, tokens: list[str]) -> bool:
    return any(tok.lower() in text for tok in tokens)


def build_profile(files: set[str], docs: list[tuple[str, str]], rules: dict[str, Any]) -> dict[str, Any]:
    text = "\n".join(t for _, t in docs).lower()
    has_lock = any(any(lf.lower() in name for name in files) for lf in rules.get("lockfiles", []))
    has_pin = any(m in text for m in ("==", ">=", "~=", "@sha256", "@v"))
    latest_hits = [p for p in rules.get("supply_chain_latest", []) if p.lower() in text]
    return {
        "has_permissions": _contains(text, PERMISSION_TOKENS),
        "has_audit": _contains(text, AUDIT_TOKENS),
        "has_hitl": _contains(text, HITL_TOKENS),
        "has_side_effects": _contains(text, SIDE_EFFECT_TOKENS),
        "has_injection_defense": _contains(text, INJECTION_DEFENSE_TOKENS),
        "network_used": _contains(text, ["http://", "https://", "requests.", "fetch(", "axios", "webhook", "socket"]),
        "supply_pinned": bool(has_lock or has_pin or not latest_hits),
        "latest_hits": latest_hits,
    }


def evaluate_sr_items(profile: dict[str, Any], findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """基于画像 + findings 汇总 SR-01~08 的判定（required 项影响阻断）。

    ``required`` 的语义边界（这是裁决层最容易被误用的地方）
    ----------------------------------------------------------
    ``required=True`` 的项一旦失败会直接把部署建议拉到 CAUTION。因此它只能
    用于**有证据的安全缺陷**，不能用于「作者没写声明」这类成熟度问题：

    - SR-01/03/04 有证据（命中密钥、危险命令、外联行为）→ required=True。
    - SR-02/05/08 是**声明缺失**。缺少 allowed_tools 声明不等于越权，缺少
      HITL 声明不等于会乱删文件。实测把它们当 required 会让 43 个官方 skill
      里 29 个被判 CAUTION——一个对自家全部官方内容都告警的门是没有信息量的，
      只会训练用户无脑点「继续安装」。它们改为 advisory：仍出现在
      required_mitigations 里供作者改进，但不左右部署建议。

    SR-04 的证据门槛
    ----------------
    原实现把任何 ``category in (data_egress, ssrf, network)`` 的 finding 都算
    外联证据，而 ``http_url`` 规则是 info 级、任何写了 URL 的文档都会命中。
    结果是「提到一个网址」== 「有数据外发风险」。这里要求证据至少 medium 级
    （即真实的 requests.post / 元数据地址 / 可疑 TLD），info 级仅作参考。
    """
    by_cat: dict[str, list[dict[str, Any]]] = {}
    for f in findings:
        by_cat.setdefault(f["category"], []).append(f)
    danger_cats = {"destructive", "privilege", "unauthorized_download", "obfuscation",
                   "dynamic_exec", "deserialization", "sql_injection"}

    def _significant(f: dict[str, Any]) -> bool:
        """生效 severity 达到 medium 以上才算「证据」。

        注意用的是**生效** severity：经过上下文降权后，测试目录/注释里的命中
        自然退出证据集，这正是降权机制要达到的效果。
        """
        return f["severity"] in ("medium", "high", "critical")

    has_danger = any(any(_significant(f) for f in by_cat.get(c, [])) for c in danger_cats)
    has_secret = any(f["sr"] == "SR-01" and _significant(f) for f in findings)
    has_egress = any(
        f["category"] in ("data_egress", "ssrf", "network") and _significant(f)
        for f in findings
    )
    has_injection_payload = any(f["sr"] == "SR-07" and _significant(f) for f in findings)

    items = [
        {"id": "SR-01", "name": "密钥与敏感信息", "passed": not has_secret, "required": True,
         "detail": "未发现硬编码密钥" if not has_secret else "发现疑似密钥/敏感文件",
         "recommendation": "移除硬编码密钥，改用环境变量或密钥托管"},
        {"id": "SR-02", "name": "权限最小化", "passed": profile["has_permissions"], "required": False,
         "detail": "发现权限边界声明" if profile["has_permissions"] else "未发现 allowed_tools/scope/权限声明（声明缺失，非越权证据）",
         "recommendation": "在 SKILL.md/manifest 声明 allowed_tools、数据范围、网络范围、读写权限"},
        {"id": "SR-03", "name": "危险命令 / 注入 / 破坏性动作", "passed": not has_danger, "required": True,
         "detail": "未发现危险命令" if not has_danger else "发现危险命令/注入/动态执行模式",
         "recommendation": "移除危险命令；如必需请用 allowlist + 容器隔离 + 人工确认"},
        {"id": "SR-04", "name": "外部网络与数据外发", "passed": (not has_egress) or (profile["has_audit"] and profile["has_permissions"]),
         "required": True,
         "detail": "无外联或外联受权限/审计约束" if (not has_egress) or profile["has_audit"] else "发现外联/外传但缺少权限或审计",
         "recommendation": "外联行为增加 allowlist、审计日志和数据脱敏"},
        {"id": "SR-05", "name": "写操作与人工确认", "passed": (not profile["has_side_effects"]) or profile["has_hitl"],
         "required": False,
         "detail": "无副作用或已声明 HITL" if (not profile["has_side_effects"]) or profile["has_hitl"] else "发现写/删/发送等副作用但缺少人工确认声明",
         "recommendation": "对高风险写操作添加 approve_required/HITL 机制"},
        {"id": "SR-06", "name": "供应链可复现性", "passed": profile["supply_pinned"], "required": False,
         "detail": "依赖已 pin 或未发现 latest/main" if profile["supply_pinned"] else "发现非固定依赖: " + ", ".join(profile["latest_hits"][:6]),
         "recommendation": "固定 tag/commit/digest，提交 lockfile，避免运行时拉 latest"},
        {"id": "SR-07", "name": "提示注入与系统信息保护", "passed": not has_injection_payload, "required": False,
         "detail": "未发现提示注入载荷" if not has_injection_payload else "发现提示注入/系统提示抽取载荷",
         "recommendation": "移除注入载荷；补充提示注入防护与工具输出隔离策略"},
        {"id": "SR-08", "name": "审计与可追踪", "passed": profile["has_audit"], "required": False,
         "detail": "发现审计/日志证据" if profile["has_audit"] else "缺少审计/日志/留痕证据",
         "recommendation": "记录工具调用、输入输出摘要、审批人、策略版本和报告路径"},
    ]
    return items
