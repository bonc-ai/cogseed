"""沙箱层一致性 —— 隔离路径必须与当前引擎同版本。

为什么这算对抗门禁的一部分
--------------------------
`sandbox/agent_gate.py::evaluate_skill` 原先「沙箱优先」：`_run_sandboxed` 拿到
报告就直接返回，沙箱不可用才降级，于是镜像里那份引擎就是安装门禁的裁决者。
如果它不是当前引擎，「装了 Docker 的机器」拿到的裁决比「没装 Docker 的机器」
更旧、更弱，安全姿态被环境反转。

该行为已改为**两层取更严**（隔离层可以加强结论、不能削弱结论，见
`test_gate_strictness.py`），所以落后镜像不再拉低门禁。但镜像本身仍然落后，
本用例继续把这一状态钉住：镜像一旦重建、或版本关系发生变化，都必须有人重新
核对「隔离层现在到底是什么版本、它的结论还值不值得单独采信」。

本机没有 docker 或没有镜像时跳过。**跳过不等于通过**：报告里写明这一层没被测，
而不是让一次未测的沙箱层看起来像一次成功的隔离扫描。
"""
from __future__ import annotations

import pytest

import run_adversarial as ra


@pytest.fixture(scope="module")
def probe() -> dict:
    result = ra.sandbox_tier_probe()
    if result is None or "error" in result:
        pytest.skip(
            "没有 docker 或没有 skill-security-scanner:local 镜像："
            "沙箱层本次未测（不是通过）"
        )
    return result


def test_sandbox_tier_matches_frozen_record(probe: dict) -> None:
    baseline = ra.load_baseline()
    assert baseline is not None, "缺少 baseline.json"
    frozen = baseline.get("sandbox_tier")
    assert frozen is not None, (
        "基线里没有 sandbox_tier 段：跑 "
        "`python3 tests/conformance/adversarial/run_adversarial.py --record-sandbox-tier`"
    )
    for key in (
        "image",
        "observed_scanner_version",
        "observed_recommendation_for_control",
        "observed_score_for_control",
        "expected_scanner_version",
    ):
        assert probe[key] == frozen[key], (
            f"沙箱层 {key} 变了：{frozen[key]!r} -> {probe[key]!r}。"
            "换了镜像或改了引擎都要重新记录，并核对安装门禁的裁决来自哪份引擎"
        )


def test_sandbox_tier_status_matches_reality(probe: dict) -> None:
    """`status` 必须与观察到的版本关系一致：修好要翻状态，没修不许标 fixed。"""
    frozen = ra.load_baseline()["sandbox_tier"]
    same_version = probe["observed_scanner_version"] == probe["expected_scanner_version"]
    if frozen["status"] == "known_gap":
        assert not same_version, (
            "沙箱层已经与当前引擎同版本：把 baseline.json 的 sandbox_tier.status "
            "改成 fixed，并确认安装门禁真的走这份引擎"
        )
    else:
        assert same_version, (
            f"沙箱层标为 fixed，但镜像里是 {probe['observed_scanner_version']}、"
            f"当前引擎是 {probe['expected_scanner_version']}"
        )
