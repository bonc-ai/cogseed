"""
scoring.py — 打分 / 风险分级 / 部署建议
==========================================

从原 skill_security_scanner.py 中独立出来，使打分逻辑可单独测试、
单独做回归向量校验，不与规则匹配逻辑耦合。
"""
from __future__ import annotations

from typing import Any

from .result_models import SEVERITY_WEIGHT


def compute_score(findings: list[dict[str, Any]]) -> int:
    """从 100 分起扣，按 severity 加权。最低 0 分。"""
    penalty = sum(SEVERITY_WEIGHT.get(f["severity"], 0) for f in findings)
    return max(0, 100 - penalty)


def classify_risk(score: int, hard_blocked: bool, has_critical: bool) -> str:
    if hard_blocked:
        return "CRITICAL"
    if has_critical or score < 40:
        return "CRITICAL" if score < 20 else "HIGH"
    if score < 70:
        return "MEDIUM"
    return "LOW"


def deployment_recommendation(risk: str, hard_blocked: bool, required_failed: bool,
                               confirmed_critical: bool = False) -> str:
    """把风险分级映射为部署建议。

    ``confirmed_critical`` 表示存在**未经上下文降权**的 critical 命中
    （即出现在真实源码里的 ``rm -rf /`` / ``curl|bash`` / base64+exec 之类）。
    这类命中单条就足以拒绝安装，不应被加权平均稀释：原实现下一条 critical
    只扣 40 分 → score 60 → HIGH → CAUTION，等于「明确的破坏性命令只是提醒」。

    之所以现在才敢这样收紧：上下文降权落地前，一条 critical 很可能来自
    vendor/测试目录的误报，直接拒装会造成大量假阻断（实测官方语料曾有 1 例
    误判 DO_NOT_INSTALL）。现在 vendor/test/注释里的命中已被降级，
    「仍是 critical」这件事本身就具备了足够置信度。实测 43 个官方 skill
    的生效 critical 命中数为 0，因此该收紧不引入新的误阻断。
    """
    if hard_blocked or risk == "CRITICAL" or confirmed_critical:
        return "DO_NOT_INSTALL"
    if risk == "HIGH" or required_failed:
        return "CAUTION"
    return "ALLOW"


def worst_recommendation(recs: list[str]) -> str:
    order = {"DO_NOT_INSTALL": 2, "CAUTION": 1, "ALLOW": 0}
    return max(recs, key=lambda r: order.get(r, 0)) if recs else "ALLOW"
