"""
result_models.py — 统一的 Finding / 严重级别数据模型
======================================================

所有检测模块（text_rules / binary_rules / 外部工具增强）产出的发现项
都应通过 make_finding() 构造，保证字段一致，便于 scoring.py 和
report-schema.json 做统一处理与校验。
"""
from __future__ import annotations

from typing import Any, Literal

Severity = Literal["critical", "high", "medium", "low", "info"]

SEVERITY_WEIGHT: dict[str, int] = {"critical": 40, "high": 20, "medium": 8, "low": 3, "info": 0}
SEVERITY_ORDER: dict[str, int] = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}


def make_finding(
    sr: str,
    rule_id: str,
    severity: str,
    category: str,
    file: str,
    line: Any,
    description: str,
    remediation: str,
    hard_block: bool = False,
    source: str = "text-rules",
    context: str = "source",
    original_severity: str | None = None,
) -> dict[str, Any]:
    """构造一个标准化的 Finding 字典。所有检测模块统一用这个函数产出发现项。

    ``severity`` 是**生效**严重级（可能已被上下文降权）；``original_severity``
    保留规则声明的原始级别，便于审计「为什么这条只算 info」。``context``
    记录降权依据（source/test/vendor/doc/comment），见 context.py。
    """
    sev = severity.lower()
    orig = (original_severity or severity).lower()
    return {
        "sr": sr,
        "rule_id": rule_id,
        "severity": sev,
        "category": category,
        "file": file,
        "line": line,
        "description": description,
        "remediation": remediation,
        "hard_block": hard_block,
        "source": source,
        "context": context,
        "original_severity": orig,
        "demoted": sev != orig,
    }
