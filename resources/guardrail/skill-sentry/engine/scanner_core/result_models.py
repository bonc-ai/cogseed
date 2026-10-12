"""
result_models.py — 统一的 Finding / 严重级别数据模型
=====================================================

所有检测模块（text_rules / hidden_content / obfuscation / agentic_rules /
supply_chain / structural / binary_rules / 外部工具增强）产出的发现项
都应通过 make_finding() 构造，保证字段一致，便于 scoring.py 和
report-schema.json 做统一处理与校验。

2.2.0 起 finding 增加了四个字段，全部是为了让下游能做出**可复核**的判断：

- ``confidence``：规则本身的确定性。正则匹配到 ``requests.post(`` 是确定的
  （high）；「长随机字符串可能是密钥」是不确定的（low）。打分按
  severity × confidence 加权，避免一条低置信度启发式与一条确定的高危命中
  等价地扣分。
- ``cwe`` / ``owasp_llm`` / ``owasp_agentic``：标准编号，来自 mappings.py。
  没有编号的 finding 在 SARIF/DefectDojo 一类平台里排不进任何视图。
- ``fingerprint``：``sha1(rule_id|file|规范化匹配片段)``。用于
  baseline 抑制与「同一问题在多份报告里是同一问题」的去重。**不含行号**，
  这样在文件中插入一行不会让已接受的抑制失效。

**绝不放原始匹配文本**。``fingerprint`` 是单向摘要；``match_sha1`` 同理。
规则命中的那一行可能就是正在泄漏的凭据本身——把它写进报告等于把泄漏
扩大了一次。
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, Literal

Severity = Literal["critical", "high", "medium", "low", "info"]
Confidence = Literal["high", "medium", "low"]

# 打分权重（生效 severity）。``info`` 为 0：它表示「值得知道的线索」，
# 例如文档里出现了一个外部地址，不构成扣分理由。
SEVERITY_WEIGHT: dict[str, int] = {"critical": 40, "high": 20, "medium": 8, "low": 3, "info": 0}
SEVERITY_ORDER: dict[str, int] = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}

# 置信度折扣。high=1.0 表示「规则描述的即是事实」；low=0.25 表示
# 「这是一条值得人看一眼的启发式」。取值不设 0：即便低置信，finding 也
# 应留下痕迹，只是不主导分数。
CONFIDENCE_MULT: dict[str, float] = {"high": 1.0, "medium": 0.6, "low": 0.25}
CONFIDENCE_ORDER: dict[str, int] = {"high": 2, "medium": 1, "low": 0}

#: 规范化匹配片段时丢弃的字符。空白与引号差异不改变「这是同一个问题」的判断。
_WS_RE = re.compile(r"\s+")


def fingerprint_for(rule_id: str, file: str, snippet: str) -> str:
    """跨行号稳定的 finding 指纹。

    ``snippet`` 是命中行（或命中片段）的原文，只在本地参与哈希，**不会**
    出现在返回值或报告里。归一化只做空白折叠与大小写统一，因为
    「把 shell=True 换成 shell = True」在语义上仍是同一个问题。
    """
    norm = _WS_RE.sub(" ", (snippet or "").strip()).lower()
    payload = f"{rule_id}\x00{file.replace(chr(92), '/')}\x00{norm}"
    return hashlib.sha1(payload.encode("utf-8", "replace")).hexdigest()[:20]


def digest_of(text: str) -> str:
    """文本摘要，供「不泄漏原文但要能比对」的场景使用。"""
    return hashlib.sha1((text or "").encode("utf-8", "replace")).hexdigest()[:16]


def make_finding(
    sr: str,
    rule_id: str,
    severity: str,
    category: str,
    file: str,
    line: Any,
    description: str,
    remediation: str = "",
    hard_block: bool = False,
    source: str = "text-rules",
    context: str = "source",
    original_severity: str | None = None,
    confidence: str = "high",
    snippet: str = "",
    references: list[str] | None = None,
) -> dict[str, Any]:
    """构造一个标准化的 Finding 字典。所有检测模块统一用这个函数产出发现项。

    ``severity`` 是**生效**严重级（可能已被上下文降权）；``original_severity``
    保留规则声明的原始级别，便于审计「为什么这条只算 info」。``context``
    记录降权依据（source/test/vendor/doc/comment/prose），见 context.py。

    ``remediation`` 留空时由 ``mappings.py`` 按类别补齐——这样「怎么办」的措辞
    只有一份，不会因为规则文件与代码默认值各写一套而漂移。规则自带
    remediation 时优先采用（它更具体）。
    """
    # 延迟导入：mappings 不依赖 result_models，但把导入放在函数内可以让
    # 本模块保持「零依赖」，方便被 conformance 脚本单独加载。
    from .mappings import mapping_for, references_for

    sev = str(severity).lower()
    orig = str(original_severity or severity).lower()
    conf = str(confidence).lower()
    if conf not in CONFIDENCE_MULT:
        conf = "medium"
    m = mapping_for(category)
    return {
        "sr": sr,
        "rule_id": rule_id,
        "severity": sev,
        "category": category,
        "file": file.replace("\\", "/"),
        "line": line,
        "description": description,
        "remediation": remediation or m.remediation,
        "hard_block": bool(hard_block),
        "source": source,
        "context": context,
        "original_severity": orig,
        "demoted": sev != orig,
        "confidence": conf,
        "cwe": list(m.cwe),
        "owasp_llm": list(m.owasp_llm),
        "owasp_agentic": list(m.owasp_agentic),
        "owasp_ast": list(m.owasp_ast),
        "references": list(references if references is not None else references_for(category)),
        "fingerprint": fingerprint_for(rule_id, file, snippet or f"{file}:{line}"),
    }
