"""对抗门禁的 pytest 包装 —— 让它成为 `npm run test:resources` 的一部分。

为什么必须有这层包装
--------------------
`tools/evasion_check.py` 与 `tests/conformance/v1.1.0/run_conformance.py` 都是
**手工脚本**：没有任何测试调用它们，而 `npm run test:resources` 只收 `tests/` 与
`runtime_trust/tests` 下的 `test_*.py`。结果是对抗语料只在有人想起来的时候才跑，
而安全回归恰恰发生在没人想起来的时候。

基线的语义是棘轮：新逃脱立即失败；缺口收窄同样失败，并提示收紧基线——修复必须
留下记录，不允许悄悄发生（同 `test/renderer/shared-ui-adoption-guard.test.ts`
对基线只许收紧、不许提高的思路）。
"""
from __future__ import annotations

import pytest

import run_adversarial as ra
import vectors

_VECTOR_IDS = [v.name for v in vectors.VECTORS]
_CONTROL_IDS = [v.name for v in vectors.CONTROLS]


def _frozen_vectors() -> dict:
    baseline = ra.load_baseline()
    assert baseline is not None, (
        "缺少 tests/conformance/adversarial/baseline.json：先跑 "
        "`python3 tests/conformance/adversarial/run_adversarial.py --update-baseline` "
        "并人工确认每条缺口，再提交"
    )
    return baseline["vectors"]


@pytest.mark.parametrize("vector", vectors.VECTORS, ids=_VECTOR_IDS)
def test_vector_matches_frozen_baseline(vector: vectors.Vector) -> None:
    """每条向量的裁决/分数/逃逸来源必须与冻结基线一致。"""
    frozen = _frozen_vectors()
    assert vector.name in frozen, (
        f"{vector.name} 不在基线里：新增向量后跑 --update-baseline 并说明这条通道"
    )
    actual = ra.evaluate(vector)
    ok, note = ra.compare(actual, frozen[vector.name])
    assert ok, f"{vector.name}: {note}"


@pytest.mark.parametrize("vector", vectors.CONTROLS, ids=_CONTROL_IDS)
def test_controls_are_denied_for_every_source(vector: vectors.Vector) -> None:
    """对照必须被**所有**来源策略拒绝。

    判据的零点：只要对照能逃脱，基线里那些攻击缺口就没有解释力——分不清是
    「引擎拦不住」还是「判据根本没在工作」。
    """
    actual = ra.evaluate(vector)
    assert actual["recommendation"] == "DO_NOT_INSTALL", (
        f"{vector.name} 只是 {actual['recommendation']}："
        f"官方来源（fail_on=DO_NOT_INSTALL）会放行这份最露骨的载荷"
    )
    assert actual["escape_sources"] == [], f"{vector.name}: {actual['escape_sources']}"


def test_baseline_has_no_orphan_entries() -> None:
    """基线里不允许有已不存在的向量，否则删除向量会静默减少对抗覆盖。"""
    frozen = _frozen_vectors()
    current = {v.name for v in vectors.VECTORS}
    assert set(frozen) == current, (
        f"基线多出 {sorted(set(frozen) - current)}，缺少 {sorted(current - set(frozen))}"
    )


class TestMeasurementPrecondition:
    """对抗结论的前提：必须跑在完整规则集上。

    规则集读不到时引擎静默退回内置规则（64 条 vs 完整 181 条），那种状态下量出来
    的「逃脱率」属于另一个产品。所以这条前提既打印、也断言，而且守卫本身要被测试
    ——不会失败的守卫不是守卫。
    """

    def test_full_ruleset_precondition_holds(self) -> None:
        health = ra.engine_rules_health()
        problem = ra.full_ruleset_problem(health)
        assert problem is None, problem
        assert health["rule_count"] >= 150, health

    def test_degraded_ruleset_is_rejected(self, monkeypatch) -> None:
        from engine.scanner_core import rule_loader

        monkeypatch.setattr(rule_loader, "yaml", None)
        health = ra.engine_rules_health()
        assert ra.full_ruleset_problem(health) is not None, (
            "规则集退回内置规则时门禁仍认为测量有效："
            f"{health['rules_source']}（{health['rule_count']} 条）"
        )
