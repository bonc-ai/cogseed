"""
scoring.py — 打分 / 风险分级 / 部署建议
==========================================

从原 skill_security_scanner.py 中独立出来，使打分逻辑可单独测试、
单独做回归向量校验，不与规则匹配逻辑耦合。

2.2.0 的打分模型（为什么不再用「100 - Σ权重」）
-----------------------------------------------
旧模型 ``score = max(0, 100 - Σ SEVERITY_WEIGHT)`` 有三个可测量的缺陷：

1. **线性无饱和**：5 条 medium 扣 40 分，等价于 1 条 critical。真实的
   风险不是这样叠加的——第 6 条同类 medium 带来的新增信息远小于第 1 条。
   实测：一份写了 7 个 ``requests.post(`` 的正常遥测型 Skill 与一份真的
   外传会话内容的 Skill 得分相同。
2. **规则计数即风险**：同一条规则命中 20 次（例如一个循环里 20 处
   ``os.system``）会线性扣到 0 分，掩盖了「其余类别是否干净」这一更有
   价值的信息。
3. **置信度不可见**：``jwt_token`` 正则是确定性命中，``raw_ip_url`` 是
   启发式；旧模型让两者按同一系数扣分。

新模型：

    penalty_cat = min(CATEGORY_CAP[cat], Σ_finding (SEVERITY_WEIGHT × CONFIDENCE_MULT))
    penalty     = Σ penalty_cat
    score       = round(100 × exp(-penalty / SCALE))

- **按类别封顶**：一个类别再糟也不会把分数压到 0，除非它本身就是红线。
  这让「某个类别很糟但其余干净」与「到处都有问题」在分数上可区分。
- **指数衰减**：新增 finding 的边际影响递减，但永不归零。
- **置信度加权**：低置信度启发式只贡献 25% 的扣分。

两条**硬下限**保留，因为它们是红线而不是度量：

- ``hard_blocked``（持续外传认知资产等）→ 0 分。一票否决项不做加权平均。
- ``confirmed_critical``（未经降权的 critical）→ 不超过 25 分。
  一条出现在真实源码里的 ``rm -rf /`` 不应该被平均成 60 分。

``compute_score_details`` 同时返回可审计的拆解，UI 因此能回答
「为什么是 42 分」而不是只给一个数字。
"""
from __future__ import annotations

import math
from typing import Any

from .result_models import CONFIDENCE_MULT, SEVERITY_WEIGHT

#: 指数衰减尺度。SCALE 越大越宽容。55 的标定依据见 tests/unit/test_scoring.py
#: 的 calibration 用例：单条 critical(40) → 48 分；单条 high(20) → 70 分；
#: 单条 medium(8) → 86 分。
SCALE = 55

#: 每个类别的扣分上限。数值不是统一的——`credential_access` 与 `data_egress`
#: 的上限高，因为这两类的真阳性代价不可逆（数据已经离开机器）；`network`
#: 上限低，因为「文档里出现一个 URL」在正常 Skill 里极其常见。
#:
#: 标定口径：**上限应高于单条 critical 的权重（40）**，否则一条命中就把该
#: 类别顶满，「同类再多也一样」会在第一条就成立——封顶于是失去意义。
#: 高风险类别取 1.5–1.75 倍（两三条 critical 顶满），低价值类别取
#: 1.1–1.4 倍。
CATEGORY_CAP: dict[str, int] = {
    # 凭据与认知资产：真阳性代价不可逆（数据已经离开机器），上限最高。
    "credential_access": 70,
    "cognitive_asset_exfil": 70,
    "data_egress": 65,
    "reverse_shell": 70,
    "crypto_miner": 70,
    # 破坏性与持久化：代价可逆但影响面大。
    "destructive": 65,
    "destructive_fs": 65,
    "persistence": 60,
    "privilege": 60,
    "surveillance": 60,
    "secret": 60,
    "unauthorized_download": 60,
    "hidden_content": 60,
    "agent_instruction": 60,
    # 其余按「两到三条 critical 才顶满」标定。
    "secret_file": 55,
    "mcp_config": 55,
    "deserialization": 55,
    "dynamic_exec": 55,
    "obfuscation": 55,
    "command_exec": 55,
    "prompt_injection": 55,
    "system_prompt_extraction": 50,
    "install_hook": 50,
    "sql_injection": 45,
    "ssrf": 45,
    "supply_chain": 45,
    "dependency_vuln": 45,
    "structural": 45,
    "path_traversal": 45,
    "typosquat": 45,
    "permission": 45,
    "binary_indicator": 45,
    # 「文档里出现一个外部地址」在正常 Skill 里极其常见，因此这一类
    # 天然是低价值的线索，不该主导分数。
    "network": 20,
}
DEFAULT_CAP = 25

#: 未经降权的 critical 命中时的分数上限。见模块文档。
CONFIRMED_CRITICAL_CEILING = 25


def _weight(finding: dict[str, Any]) -> float:
    sev = str(finding.get("severity") or "info").lower()
    conf = str(finding.get("confidence") or "high").lower()
    return float(SEVERITY_WEIGHT.get(sev, 0)) * float(CONFIDENCE_MULT.get(conf, 1.0))


def compute_score_details(
    findings: list[dict[str, Any]],
    *,
    hard_blocked: bool = False,
    confirmed_critical: bool = False,
) -> dict[str, Any]:
    """计算分数并返回可审计的拆解。

    返回 ``{"score", "raw_penalty", "penalty", "scale", "by_category",
    "floors"}``。``by_category`` 每项含 ``category/count/raw/cap/penalty``，
    已按 ``penalty`` 降序排列——UI 直接按这个顺序展示风险分布。
    """
    buckets: dict[str, dict[str, Any]] = {}
    for f in findings:
        w = _weight(f)
        if w <= 0:
            # info 级不参与打分，但仍进入计数，好让 UI 能区分
            # 「扫过但只是线索」与「完全没扫到」。
            cat = str(f.get("category") or "unknown")
            row = buckets.setdefault(cat, {"category": cat, "count": 0, "raw": 0.0, "cap": _cap(cat)})
            row["count"] += 1
            continue
        cat = str(f.get("category") or "unknown")
        row = buckets.setdefault(cat, {"category": cat, "count": 0, "raw": 0.0, "cap": _cap(cat)})
        row["count"] += 1
        row["raw"] += w

    by_category: list[dict[str, Any]] = []
    penalty = 0.0
    for row in buckets.values():
        capped = min(float(row["cap"]), row["raw"])
        penalty += capped
        by_category.append({
            "category": row["category"],
            "count": row["count"],
            "raw": round(row["raw"], 2),
            "cap": row["cap"],
            "penalty": round(capped, 2),
            # ``capped`` 为真说明该类别已顶到上限——继续加同类命中不会
            # 再降分。这个信号对「再多报几条有没有用」很关键。
            "capped": row["raw"] > float(row["cap"]),
        })
    by_category.sort(key=lambda r: (-r["penalty"], r["category"]))

    score = int(round(100 * math.exp(-penalty / SCALE))) if penalty > 0 else 100

    floors: list[str] = []
    if confirmed_critical and score > CONFIRMED_CRITICAL_CEILING:
        score = CONFIRMED_CRITICAL_CEILING
        floors.append("confirmed_critical")
    if hard_blocked:
        score = 0
        floors.append("hard_block")

    return {
        "score": max(0, min(100, score)),
        "raw_penalty": round(sum(r["raw"] for r in by_category), 2),
        "penalty": round(penalty, 2),
        "scale": SCALE,
        "by_category": by_category,
        "floors": floors,
    }


def _cap(category: str) -> int:
    return CATEGORY_CAP.get(category, DEFAULT_CAP)


def compute_score(findings: list[dict[str, Any]]) -> int:
    """只要分数时的便捷入口。"""
    return int(compute_score_details(findings)["score"])


def classify_risk(
    score: int,
    hard_blocked: bool,
    has_critical: bool,
    confirmed_critical: bool = False,
) -> str:
    """风险分级。

    2.2.0 起按分数分带，并把 ``confirmed_critical`` 单列——此前它靠
    ``has_critical`` 间接进入，导致「测试目录里有一条被降权的 critical」与
    「真实源码里有一条 critical」走同一条分支。
    """
    if hard_blocked or confirmed_critical:
        return "CRITICAL"
    if score < 20:
        return "CRITICAL"
    if score < 40 or has_critical:
        return "HIGH"
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
    误判 DO_NOT_INSTALL）。现在 vendor/test/注释/散文里的命中已被降级，
    「仍是 critical」这件事本身就具备了足够置信度。

    2.2.0 补的一处：``low`` 置信度的 critical 不再触发本分支。降权解决的是
    「上下文」，没有解决「规则本身有多确定」；两者独立，因此这里要求
    ``confidence != 'low'``。
    """
    if hard_blocked or risk == "CRITICAL" or confirmed_critical:
        return "DO_NOT_INSTALL"
    if risk == "HIGH" or required_failed:
        return "CAUTION"
    return "ALLOW"


def is_confirmed_critical(findings: list[dict[str, Any]]) -> bool:
    """是否存在**未经降权**且**高置信**的 critical 命中。

    单一判定点。此前 report.py 内联了这个表达式，而 scan_gate 又有自己的
    一份；两处对 confidence 的处理不一致时，同一个 Skill 会在
    「导入被拦、安装放行」之间摇摆。

    要求 ``confidence == 'high'`` 是 2.2.0 的一处收紧，方向是**减少假拒装**：
    规则库里有一批「形态上确定、语义上模糊」的模式（三段式 token、
    `key` + 14 位、纯数字冒号分隔），它们的 severity 是 critical 但
    confidence 是 medium/low。旧口径下这些命中会直接触发 DO_NOT_INSTALL，
    等于用一个启发式拒装。现在它们仍然计入分数、仍然把风险拉到 HIGH/CAUTION、
    仍然出现在风险卡上，只是不再**单独**构成拒装理由。
    """
    for f in findings:
        if str(f.get("severity")) != "critical":
            continue
        if f.get("demoted"):
            continue
        if str(f.get("confidence") or "high") != "high":
            continue
        return True
    return False


def worst_recommendation(recs: list[str]) -> str:
    order = {"DO_NOT_INSTALL": 2, "CAUTION": 1, "ALLOW": 0}
    return max(recs, key=lambda r: order.get(r, 0)) if recs else "ALLOW"
