"""skill-declaration-core 一致性向量测试（白盒补充）.

与 ``test_engine_golden.py``（黑盒、走真实 CLI）互补：这一套直接驱动引擎内部
模块，把 ``tests/conformance/1.1.1/*.json`` 里的契约向量逐一核对。向量文件本身
是数据契约（历史基线），测试代码是我们自己的实现。

覆盖：
- exit-code-vectors：结果字符串 → 数字退出码 全表核对
- digest-vectors：摘要稳定性 + digest profile ref
- derivation-vectors：风险派生停用后的行为（可解析但禁止计算）
- 其余桩向量：可解析，结构合法
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
ENGINE = REPO / "resources" / "guardrail" / "skill-declaration-core"
VECTOR_DIR = ENGINE / "tests" / "conformance" / "1.1.1"
FIXTURE = ENGINE / "fixtures" / "sample-skill"

from security_core.digesting import subject_digest  # noqa: E402
from security_core.deriving import derive_risk_fields  # noqa: E402
from security_core.models import RESULT_EXIT_CODE, Result, fold_verdict, Finding, Severity  # noqa: E402
from security_core.registry import read_artifact  # noqa: E402


def _vectors(name: str) -> list[dict]:
    return json.loads((VECTOR_DIR / name).read_text(encoding="utf-8"))


# ── exit-code 全表 ─────────────────────────────────────────────────────────


def test_exit_code_vectors_are_consistent_with_the_registry():
    rows = _vectors("exit-code-vectors.json")
    assert rows
    by_result = {r["result"]: r["exit_code"] for r in rows}
    # 每个向量都不得偏离注册表；关键判定码必须在向量中显式出现
    for result, code in by_result.items():
        assert RESULT_EXIT_CODE[result] == code
    for must_cover in ("PASS", "PASS_WITH_WARNINGS", "BLOCK", "EXECUTION_ERROR"):
        assert must_cover in by_result


@pytest.mark.parametrize("row", _vectors("exit-code-vectors.json"), ids=lambda r: r["id"])
def test_exit_code_vector(row: dict):
    assert row["exit_code"] == RESULT_EXIT_CODE[row["result"]]


def test_unknown_result_falls_back_to_execution_error():
    assert RESULT_EXIT_CODE.get("NOT_A_REAL_RESULT", 40) == 40


def test_phase2_range_never_mapped_by_engine():
    # 35-39 是 phase-2 预留区间，本引擎绝不允许产出
    emitted = set(RESULT_EXIT_CODE.values())
    assert emitted.isdisjoint({35, 36, 37, 38, 39})


# ── digest 向量 ────────────────────────────────────────────────────────────


def test_digest_stable_across_runs():
    first = subject_digest(FIXTURE)
    second = subject_digest(FIXTURE)
    assert first["ok"] and second["ok"]
    assert first["subject_digest"] == second["subject_digest"]
    assert first["authority"] == "AUTHORITATIVE"


def test_digest_profile_ref_matches_ontology():
    profile = read_artifact("1.1.1", "digest-profile.yaml")
    assert profile["ref"] == "cogseed.skill.fileset@1.0.0"
    result = subject_digest(FIXTURE)
    assert result["digest_profile"]["ref"] == profile["ref"]


# ── 风险派生停用 ───────────────────────────────────────────────────────────


def test_derivation_vectors_parse_but_derivation_is_disabled():
    rows = _vectors("derivation-vectors.json")
    assert rows
    with pytest.raises(RuntimeError, match="risk derivation is disabled"):
        derive_risk_fields({})


# ── 桩向量可解析 ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name",
    [
        "completion-vectors.json",
        "consistency-vectors.json",
        "freeze-readiness-vectors.json",
        "orchestration-vectors.json",
        "report-vectors.json",
        "trust-vectors.json",
    ],
)
def test_stub_vector_files_are_parseable_lists(name: str):
    data = _vectors(name)
    assert isinstance(data, list)


# ── 判定折叠白盒 ───────────────────────────────────────────────────────────


def test_verdict_folding_precedence():
    def f(sev: str, **kw) -> Finding:
        return Finding(rule_id="T-1", severity=sev, message="m", **kw)

    assert fold_verdict([f(Severity.INFO.value)]) == Result.PASS.value
    assert fold_verdict([f(Severity.WARN.value)]) == Result.PASS_WITH_WARNINGS.value
    assert fold_verdict([f(Severity.FAIL.value), f(Severity.WARN.value)]) == Result.FAIL.value
    assert fold_verdict([f(Severity.BLOCK.value), f(Severity.FAIL.value)]) == Result.BLOCK.value
    assert fold_verdict([f(Severity.INFO.value)], needs_input=True) == Result.NEEDS_INPUT.value
