"""单元测试：scoring.py 打分 / 分级 / 部署建议。

2.2.0 起打分模型从「100 - Σ权重」改为「按类别封顶 + 指数衰减 + 置信度加权」，
因此本文件的用例分两部分：

1. **不变量**（不随参数调整而变）：空集合满分、info 不计分、类别封顶生效、
   红线触发分数下限、分数恒在 [0,100]。
2. **标定值**（会随 SCALE / CATEGORY_CAP 调整而变，改动时必须显式更新）：
   它们锁定「单条 critical 大约扣多少分」这类可感知的行为，防止一次
   「顺手调一下常数」悄悄改变产品对风险的表达。
"""
import math

from engine.scanner_core.scoring import (
    CATEGORY_CAP,
    SCALE,
    classify_risk,
    compute_score,
    compute_score_details,
    deployment_recommendation,
    is_confirmed_critical,
    worst_recommendation,
)


def _f(severity, category="dynamic_exec", confidence="high", **extra):
    return {"severity": severity, "category": category, "confidence": confidence, **extra}


class TestInvariants:
    def test_no_findings_full_score(self):
        assert compute_score([]) == 100

    def test_info_severity_no_penalty(self):
        assert compute_score([_f("info"), _f("info"), _f("info")]) == 100

    def test_unknown_severity_no_penalty(self):
        assert compute_score([_f("unknown")]) == 100

    def test_score_always_in_range(self):
        findings = [_f("critical", "credential_access")] * 200
        assert 0 <= compute_score(findings) <= 100

    def test_category_cap_bounds_damage(self):
        """单一类别命中再多，也不能把分数压到与该类别上限不符的水平。"""
        one = compute_score([_f("high", "dynamic_exec")])
        two = compute_score([_f("high", "dynamic_exec")] * 2)
        three = compute_score([_f("high", "dynamic_exec")] * 3)
        many = compute_score([_f("high", "dynamic_exec")] * 50)
        assert many <= three < two < one, "更多同类命中仍应更低，直到顶满上限"
        # 封顶生效：50 条与 100 条同分（上限已顶满）。
        assert many == compute_score([_f("high", "dynamic_exec")] * 100)

    def test_cap_exceeds_one_critical(self):
        """上限必须高于单条 critical 权重，否则封顶在第一条就生效。

        ``network`` 是唯一例外：该类别下最严重的内置规则也只有 medium，
        因此它拿不到 40 分的 critical 权重，低上限是刻意的。
        """
        for category, cap in CATEGORY_CAP.items():
            if category == "network":
                continue
            assert cap > 40, f"{category} 上限 {cap} 不高于单条 critical 权重"
        assert compute_score([_f("critical", "dynamic_exec")]) > compute_score(
            [_f("critical", "dynamic_exec")] * 2)

    def test_spread_across_categories_scores_lower_than_one_category(self):
        spread = compute_score([_f("high", c) for c in
                                ("dynamic_exec", "persistence", "network", "obfuscation")])
        single = compute_score([_f("high", "dynamic_exec")] * 4)
        assert spread < single, "跨类别扩散比同类堆叠更严重"

    def test_confidence_reduces_penalty(self):
        high = compute_score([_f("high", confidence="high")])
        medium = compute_score([_f("high", confidence="medium")])
        low = compute_score([_f("high", confidence="low")])
        assert high < medium < low

    def test_independent_of_finding_order(self):
        a = [_f("critical", "secret"), _f("low", "network")]
        assert compute_score(a) == compute_score(list(reversed(a)))

    def test_breakdown_sums_to_penalty(self):
        details = compute_score_details([_f("critical", "secret"), _f("high", "persistence")])
        assert math.isclose(
            details["penalty"], sum(r["penalty"] for r in details["by_category"]), rel_tol=1e-6,
        )

    def test_breakdown_sorted_by_penalty_desc(self):
        details = compute_score_details([
            _f("critical", "secret"), _f("low", "network"), _f("high", "persistence"),
        ])
        penalties = [r["penalty"] for r in details["by_category"]]
        assert penalties == sorted(penalties, reverse=True)


class TestCalibration:
    """标定值。调整 SCALE / CATEGORY_CAP 时必须同步更新这一组。"""

    def test_single_critical(self):
        assert compute_score([_f("critical", "credential_access")]) == 48

    def test_single_high(self):
        assert compute_score([_f("high", "persistence")]) == 70

    def test_single_medium(self):
        assert compute_score([_f("medium", "dynamic_exec")]) == 86

    def test_mixed_severities_across_categories(self):
        assert compute_score([
            _f("high", "persistence"), _f("medium", "dynamic_exec"), _f("low", "network"),
        ]) == 57

    def test_scale_constant_is_documented(self):
        assert SCALE == 55


class TestFloors:
    def test_hard_block_is_zero(self):
        details = compute_score_details([_f("high")], hard_blocked=True)
        assert details["score"] == 0
        assert "hard_block" in details["floors"]

    def test_confirmed_critical_is_capped(self):
        # 单条 critical 未被封顶时是 48 分；confirmed_critical 把它压到 25。
        details = compute_score_details(
            [_f("critical", "credential_access")], confirmed_critical=True,
        )
        assert details["score"] == 25
        assert "confirmed_critical" in details["floors"]

    def test_floor_does_not_raise_a_lower_score(self):
        """下限是「不超过」，不能把已经更低的分数抬上来。"""
        findings = [_f("critical", c) for c in
                    ("credential_access", "data_egress", "persistence", "secret",
                     "destructive", "hidden_content")]
        raw = compute_score_details(findings)
        floored = compute_score_details(findings, confirmed_critical=True)
        assert floored["score"] == min(raw["score"], 25)


class TestIsConfirmedCritical:
    def test_high_confidence_undemoted_critical(self):
        assert is_confirmed_critical([_f("critical", confidence="high")]) is True

    def test_demoted_critical_is_not_confirmed(self):
        assert is_confirmed_critical(
            [_f("critical", confidence="high", demoted=True)]) is False

    def test_low_confidence_critical_is_not_confirmed(self):
        assert is_confirmed_critical([_f("critical", confidence="low")]) is False

    def test_medium_confidence_critical_is_not_confirmed(self):
        """medium 置信度的 critical 只把风险拉到 CAUTION，不触发拒装。"""
        assert is_confirmed_critical([_f("critical", confidence="medium")]) is False

    def test_high_is_not_critical(self):
        assert is_confirmed_critical([_f("high")]) is False

    def test_missing_confidence_defaults_to_blocking(self):
        """缺 confidence 的老 finding 按 high 处理——保守方向。"""
        assert is_confirmed_critical([{"severity": "critical"}]) is True


class TestClassifyRisk:
    def test_hard_blocked_always_critical(self):
        assert classify_risk(score=100, hard_blocked=True, has_critical=False) == "CRITICAL"

    def test_confirmed_critical_always_critical(self):
        assert classify_risk(score=100, hard_blocked=False, has_critical=False,
                             confirmed_critical=True) == "CRITICAL"

    def test_has_critical_low_score_is_critical(self):
        assert classify_risk(score=10, hard_blocked=False, has_critical=True) == "CRITICAL"

    def test_has_critical_mid_score_is_high(self):
        assert classify_risk(score=30, hard_blocked=False, has_critical=True) == "HIGH"

    def test_low_score_without_critical_flag_still_critical_under_20(self):
        assert classify_risk(score=10, hard_blocked=False, has_critical=False) == "CRITICAL"

    def test_score_between_40_and_70_is_medium(self):
        assert classify_risk(score=55, hard_blocked=False, has_critical=False) == "MEDIUM"

    def test_score_70_or_above_is_low(self):
        assert classify_risk(score=70, hard_blocked=False, has_critical=False) == "LOW"
        assert classify_risk(score=100, hard_blocked=False, has_critical=False) == "LOW"

    def test_boundary_score_exactly_40(self):
        # score < 40 触发 critical/high 分支；恰好 40 应落入下一档
        assert classify_risk(score=40, hard_blocked=False, has_critical=False) == "MEDIUM"


class TestDeploymentRecommendation:
    def test_hard_blocked_always_do_not_install(self):
        assert deployment_recommendation("LOW", hard_blocked=True, required_failed=False) == "DO_NOT_INSTALL"

    def test_critical_risk_do_not_install(self):
        assert deployment_recommendation("CRITICAL", hard_blocked=False, required_failed=False) == "DO_NOT_INSTALL"

    def test_high_risk_caution(self):
        assert deployment_recommendation("HIGH", hard_blocked=False, required_failed=False) == "CAUTION"

    def test_required_failed_forces_caution_even_if_low_risk(self):
        assert deployment_recommendation("LOW", hard_blocked=False, required_failed=True) == "CAUTION"

    def test_low_risk_no_required_failed_allow(self):
        assert deployment_recommendation("LOW", hard_blocked=False, required_failed=False) == "ALLOW"


class TestConfirmedCriticalRecommendation:
    """未经上下文降权的 critical 命中：单条即拒装，不被加权平均稀释。

    背景：一条 critical 扣 40 分 → 旧模型 score 60 → HIGH → 原实现只给 CAUTION，
    等于「源码里明写 rm -rf / 只是提醒」。降权机制落地后，「仍是 critical」
    具备足够置信度，故收紧为直接拒装。
    """

    def test_confirmed_critical_forces_do_not_install(self):
        assert deployment_recommendation(
            "HIGH", hard_blocked=False, required_failed=False, confirmed_critical=True,
        ) == "DO_NOT_INSTALL"

    def test_demoted_critical_does_not_force_block(self):
        # 测试/vendor 目录里的 critical 已降权 → confirmed_critical=False
        assert deployment_recommendation(
            "LOW", hard_blocked=False, required_failed=False, confirmed_critical=False,
        ) == "ALLOW"

    def test_defaults_to_false_for_backward_compat(self):
        assert deployment_recommendation("HIGH", False, False) == "CAUTION"


class TestWorstRecommendation:
    def test_empty_list_defaults_allow(self):
        assert worst_recommendation([]) == "ALLOW"

    def test_picks_most_severe(self):
        assert worst_recommendation(["ALLOW", "CAUTION", "DO_NOT_INSTALL"]) == "DO_NOT_INSTALL"

    def test_all_allow(self):
        assert worst_recommendation(["ALLOW", "ALLOW"]) == "ALLOW"


class TestCategoryCapTable:
    def test_every_cap_is_positive_and_bounded(self):
        for category, cap in CATEGORY_CAP.items():
            assert 0 < cap <= 70, f"{category} 上限异常: {cap}"

    def test_irreversible_categories_outrank_cosmetic_ones(self):
        assert CATEGORY_CAP["credential_access"] > CATEGORY_CAP["network"]
        assert CATEGORY_CAP["data_egress"] > CATEGORY_CAP["permission"]
