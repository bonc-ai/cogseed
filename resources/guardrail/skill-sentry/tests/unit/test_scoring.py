"""单元测试：scoring.py 打分/分级/部署建议逻辑的边界值覆盖。"""
from engine.scanner_core.scoring import (
    classify_risk,
    compute_score,
    deployment_recommendation,
    worst_recommendation,
)


def _f(severity):
    return {"severity": severity}


class TestComputeScore:
    def test_no_findings_full_score(self):
        assert compute_score([]) == 100

    def test_single_critical(self):
        assert compute_score([_f("critical")]) == 60

    def test_score_floor_at_zero(self):
        findings = [_f("critical")] * 5  # 5 * 40 = 200，远超 100
        assert compute_score(findings) == 0

    def test_mixed_severities(self):
        findings = [_f("high"), _f("medium"), _f("low")]  # 20+8+3=31
        assert compute_score(findings) == 69

    def test_info_severity_no_penalty(self):
        assert compute_score([_f("info"), _f("info")]) == 100

    def test_unknown_severity_no_penalty(self):
        assert compute_score([_f("unknown")]) == 100


class TestClassifyRisk:
    def test_hard_blocked_always_critical(self):
        assert classify_risk(score=100, hard_blocked=True, has_critical=False) == "CRITICAL"

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


class TestConfirmedCritical:
    """未经上下文降权的 critical 命中：单条即拒装，不被加权平均稀释。

    背景：一条 critical 扣 40 分 → score 60 → HIGH → 原实现只给 CAUTION，
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
