"""门禁严格性不变量 —— 隔离层可以加强结论，不能削弱结论。

为什么单独立一条用例
--------------------
前面那 9 条向量测的是**引擎**能检出什么；这一条测的是**门禁**会不会被更弱的
一层拉低。两件事独立：引擎再准，只要门禁优先采用一个落后引擎的裁决，真实安装
路径就是弱的。

背景实测：`skill-security-scanner:local` 镜像内是 1.0.0 引擎，对
`os.system('rm -rf /')` 只给 CAUTION/HIGH，而当前引擎给 DO_NOT_INSTALL。
`sandbox/agent_gate.py::evaluate_skill` 原先「沙箱优先」，于是装了 Docker 的机器
门禁比没装的更弱。现在两层都算、取更严的那个，本用例把这个不变量钉住。

第一条用**合成报告**模拟落后引擎，所以在没有 Docker 的机器上也成立——不变量不该
只在恰好装了 Docker 的机器上被验证。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

import run_adversarial as ra
import vectors

SKILL_ROOT = Path(__file__).resolve().parents[3]
if str(SKILL_ROOT / "sandbox") not in sys.path:
    sys.path.insert(0, str(SKILL_ROOT / "sandbox"))

import agent_gate  # noqa: E402

#: 模拟落后引擎给出的沙箱报告：与镜像里 1.0.0 的真实输出同形
#: （`rm_rf_root` 命中 critical，但总分 40 / HIGH / CAUTION）。
STALE_SANDBOX_REPORT = {
    "scanner": "skill-security-scanner",
    "scanner_version": "1.0.0",
    "deployment_recommendation": "CAUTION",
    "security_score": 40,
    "risk_classification": "HIGH",
    "hard_blocked": False,
    "attack_surface": {},
    "required_mitigations": [],
    "vulnerability_findings": [],
}


def _build(vector_name: str, tmp_path: Path) -> Path:
    return ra.build_skill(vectors.BY_NAME[vector_name], tmp_path)


def test_stale_sandbox_cannot_weaken_the_gate(tmp_path: Path, monkeypatch) -> None:
    """落后引擎判 CAUTION 时，门禁仍必须按当前引擎判 DO_NOT_INSTALL。"""
    skill = _build("control-source-plain", tmp_path)
    monkeypatch.setattr(agent_gate, "_run_sandboxed", lambda p: dict(STALE_SANDBOX_REPORT))

    result = agent_gate.evaluate_skill(str(skill))

    assert result["deployment_recommendation"] == "DO_NOT_INSTALL", (
        "隔离层给出 CAUTION 就把门禁拉低成 CAUTION："
        "一个更旧的引擎覆盖了更旧的结论，装了 Docker 的机器反而更不安全"
    )
    assert result["strictest_tier"] == "degraded-local"
    tiers = {t["tier"]: t for t in result["tier_evidence"]}
    assert tiers["sandbox"]["recommendation"] == "CAUTION"
    assert tiers["sandbox"]["scanner_version"] == "1.0.0"
    assert tiers["degraded-local"]["recommendation"] == "DO_NOT_INSTALL"
    assert tiers["degraded-local"]["scanner_version"] != "1.0.0", (
        "本地层应当带上当前引擎版本：tier_evidence 要能回答「这个结论是谁给的」"
    )


def test_stricter_sandbox_verdict_is_still_adopted(tmp_path: Path, monkeypatch) -> None:
    """反方向：隔离层更严时必须采用隔离层的结论（别修成「只信本地」）。"""
    skill = _build("control-source-plain", tmp_path)
    strict_report = dict(STALE_SANDBOX_REPORT, deployment_recommendation="DO_NOT_INSTALL",
                         security_score=0, risk_classification="CRITICAL")
    monkeypatch.setattr(agent_gate, "_run_sandboxed", lambda p: strict_report)

    result = agent_gate.evaluate_skill(str(skill))

    assert result["deployment_recommendation"] == "DO_NOT_INSTALL"
    assert result["strictest_tier"] == "sandbox"
    assert result["isolated"] is True


@pytest.mark.parametrize("vector", vectors.VECTORS, ids=[v.name for v in vectors.VECTORS])
def test_gate_is_never_weaker_than_the_engine(vector: vectors.Vector, tmp_path: Path) -> None:
    """真实环境下：门禁结论不得弱于当前引擎的结论。"""
    skill = ra.build_skill(vector, tmp_path)
    engine_report = ra.scan(str(skill))
    gate = agent_gate.evaluate_skill(str(skill))

    engine_rec = engine_report["deployment_recommendation"]
    gate_rec = gate.get("deployment_recommendation") or gate.get("aggregate_recommendation")
    assert gate_rec is not None, f"{vector.name}: 门禁没有给出部署建议：{gate}"
    assert ra._RANK[gate_rec] >= ra._RANK[engine_rec], (
        f"{vector.name}: 门禁 {gate_rec} 弱于引擎 {engine_rec}"
        f"（strictest_tier={gate.get('strictest_tier')}, "
        f"tiers={[(t['tier'], t['recommendation'], t['scanner_version']) for t in gate.get('tier_evidence', [])]}）"
    )
