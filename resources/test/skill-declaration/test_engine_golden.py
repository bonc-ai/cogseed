"""skill-declaration-core 黑盒行为金丝雀（Golden Tests）.

定位：引擎重写前的行为冻结器。全部断言只通过「真实 CLI 子进程」的
stdout JSON 与退出码完成，绝不 import 引擎内部模块 —— 这样引擎内部
如何重组都不影响本套测试，重写前重写后都必须全绿。

契约来源（引擎内部实现不得改变以下外部行为）：
- scripts/validator_cli.py / template_cli.py / orchestrator_cli.py 的参数与退出码
- stdout 单行 JSON 报告的字段结构（TS 适配器 skill-declaration-adapter.ts 解析）
- exit-code-registry.yaml 的语义码
- fixture 技能的 worktree digest（摘要算法结果必须逐字节稳定）
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENGINE = REPO / "resources" / "guardrail" / "skill-declaration-core"
FIXTURE = ENGINE / "fixtures" / "sample-skill"

# ── 黄金值（2026-08-19 由当前引擎实测捕获；重写后必须不变）──────────────
GOLDEN_WORKTREE_DIGEST = (
    "sha256:dd119053551ab30464d5a169bb38bf9c50e2627309f3c32a71f9eb0de08a3573"
)
GOLDEN_REPORT_ID = "val-skill.sample.local_format-1.0.0-prevalidation"
GOLDEN_FILESET_COUNT = 9
GOLDEN_PROFILE_REF = "cogseed.skill.fileset@1.0.0"
GOLDEN_PREVALIDATION_FINDING_RULES = {
    "SEC-PROVENANCE-CHECKSUM-DEFERRED-001": "INFO",
    "SEC-OPTIONAL-TECHNICAL-OWNER-001": "INFO",
}
GOLDEN_FORMAL_BLOCK_RULES = {
    # freeze-id/subject-digest 正确，但 fixture 的 provenance.checksum 未填真值
    "SEC-DIGEST-002": "BLOCK",
    "SEC-OPTIONAL-TECHNICAL-OWNER-001": "INFO",
}


def run_cli(
    script: str,
    *args: str,
    stdin: str | None = None,
) -> subprocess.CompletedProcess:
    """以与 TS 适配器一致的子进程环境运行引擎 CLI（绝不写字节码进引擎树）。"""
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = os.pathsep.join(
        [str(ENGINE / "vendor"), str(ENGINE)]
        + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])
    )
    return subprocess.run(
        [sys.executable, str(ENGINE / "scripts" / script), *args],
        cwd=str(ENGINE),
        env=env,
        input=stdin,
        capture_output=True,
        text=True,
        timeout=60,
    )


def validator_report(*args: str) -> tuple[int, dict]:
    proc = run_cli("validator_cli.py", *args)
    assert proc.stderr.strip() == "", f"validator stderr 应为空: {proc.stderr[:200]}"
    return proc.returncode, json.loads(proc.stdout)


# ── validator_cli 主链路 ────────────────────────────────────────────────


def test_validator_prevalidation_golden():
    code, report = validator_report(
        "--skill-root", str(FIXTURE), "--mode", "PREVALIDATION"
    )
    assert code == 0
    assert report["report_id"] == GOLDEN_REPORT_ID
    assert report["mode"] == "PREVALIDATION"
    v = report["validation"]
    assert v["result"] == "PASS"
    assert v["ontology_version"] == "1.1.1"
    assert v["engine_version"] == (ENGINE / "VERSION").read_text().strip()
    assert v["warnings"] == []
    by_rule = {f["rule_id"]: f["severity"] for f in v["findings"]}
    assert by_rule == GOLDEN_PREVALIDATION_FINDING_RULES
    s = report["subject"]
    assert s["skill_id"] == "skill.sample.local_format"
    assert s["skill_version"] == "1.0.0"
    assert s["state"] == "MUTABLE"
    assert s["subject_digest"] is None
    assert s["worktree_digest"] == GOLDEN_WORKTREE_DIGEST
    assert s["worktree_digest_authority"] == "NON_AUTHORITATIVE"
    assert s["worktree_profile_ref"] == GOLDEN_PROFILE_REF
    assert s["fileset_count"] == GOLDEN_FILESET_COUNT
    assert report["validator"] == {"id": "skill-security-validator", "version": "1.3.0"}
    assert report["report_integrity"]["storage"] == "VALIDATOR_CONTROLLED"
    assert report["report_integrity"]["creator_writable"] is False
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", report["validated_at"])


def test_validator_formal_without_freeze():
    code, report = validator_report(
        "--skill-root", str(FIXTURE), "--mode", "FORMAL_TEST"
    )
    assert code == 33
    assert report["validation"]["result"] == "DIGEST_MISMATCH"
    assert report["subject"]["state"] == "FROZEN"


def test_validator_formal_correct_digest():
    code, report = validator_report(
        "--skill-root",
        str(FIXTURE),
        "--mode",
        "FORMAL_TEST",
        "--freeze-id",
        "test-fid",
        "--subject-digest",
        GOLDEN_WORKTREE_DIGEST,
    )
    assert code == 31
    assert report["validation"]["result"] == "BLOCK"
    by_rule = {f["rule_id"]: f["severity"] for f in report["validation"]["findings"]}
    assert by_rule == GOLDEN_FORMAL_BLOCK_RULES
    s = report["subject"]
    assert s["freeze_id"] == "test-fid"
    assert s["subject_digest"] == GOLDEN_WORKTREE_DIGEST
    assert s["freeze_manifest_ref"] == "orchestrator://freezes/test-fid/freeze-manifest.json"


def test_validator_formal_wrong_digest():
    code, report = validator_report(
        "--skill-root",
        str(FIXTURE),
        "--mode",
        "FORMAL_TEST",
        "--freeze-id",
        "test-fid",
        "--subject-digest",
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    )
    assert code == 33
    assert report["validation"]["result"] == "DIGEST_MISMATCH"


def test_validator_missing_skill_root_is_unknown_not_block():
    code, report = validator_report(
        "--skill-root", "/tmp/cogseed-nonexistent-skill", "--mode", "PREVALIDATION"
    )
    assert code == 40
    assert report["validation"]["result"] == "EXECUTION_ERROR"
    assert any(
        f["rule_id"] == "SEC-EXEC-001" and f["severity"] == "BLOCK"
        for f in report["validation"]["findings"]
    )


def test_validator_report_out_writes_file():
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "report.json"
        code, _ = validator_report(
            "--skill-root",
            str(FIXTURE),
            "--mode",
            "PREVALIDATION",
            "--report-out",
            str(out),
        )
        assert code == 0
        written = json.loads(out.read_text(encoding="utf-8"))
        assert written["report_id"] == GOLDEN_REPORT_ID


def test_engine_tree_stays_bytecode_free():
    """运行过 CLI 后引擎树不得出现 __pycache__（否则 INTEGRITY 引脚失配）。"""
    validator_report("--skill-root", str(FIXTURE), "--mode", "PREVALIDATION")
    run_cli("template_cli.py", "--ontology-version", "1.1.1", "get-rule-index")
    pycache = sorted(ENGINE.rglob("__pycache__"))
    assert pycache == [], f"引擎树出现字节码目录: {pycache}"


# ── template_cli 契约 ────────────────────────────────────────────────────


def test_template_cli_surface():
    code, data = (lambda p: (p.returncode, json.loads(p.stdout)))(
        run_cli("template_cli.py", "list-supported-versions")
    )
    assert code == 0
    assert data["ok"] is True
    assert data["supported"] == ["1.1.1"]
    assert data["current"] == ["1.1.1"]

    code, data = (lambda p: (p.returncode, json.loads(p.stdout)))(
        run_cli(
            "template_cli.py",
            "--ontology-version",
            "1.1.1",
            "list-required-fields",
        )
    )
    assert code == 0
    assert data["ok"] is True
    for mode_key in ("PREVALIDATION", "FREEZE", "FORMAL_TEST"):
        assert mode_key in data

    code, data = (lambda p: (p.returncode, json.loads(p.stdout)))(
        run_cli(
            "template_cli.py",
            "--ontology-version",
            "1.1.1",
            "describe-field",
            "risk.risk_level",
        )
    )
    assert code == 0
    assert data["ok"] is True

    code, data = (lambda p: (p.returncode, json.loads(p.stdout)))(
        run_cli("template_cli.py", "--ontology-version", "1.1.1", "get-rule-index")
    )
    assert code == 0
    for section in ("digest", "trust", "consistency", "warning", "derivation"):
        assert section in data

    code, data = (lambda p: (p.returncode, json.loads(p.stdout)))(
        run_cli("template_cli.py", "--ontology-version", "1.1.1", "get-defaults")
    )
    assert code == 0
    assert data["ok"] is True
    assert "do_not_write" in data


def test_template_cli_bad_version_is_not_success():
    proc = run_cli(
        "template_cli.py", "--ontology-version", "9.9.9", "list-required-fields"
    )
    assert proc.returncode != 0


# ── orchestrator_cli 面 ──────────────────────────────────────────────────


def test_orchestrator_cli_surface():
    proc = run_cli("orchestrator_cli.py", "--help")
    assert proc.returncode == 0
    for sub in ("freeze", "formal-test", "check-digests", "run-pipeline"):
        assert sub in proc.stdout

    for sub in ("freeze", "formal-test", "check-digests", "run-pipeline"):
        proc = run_cli("orchestrator_cli.py", sub, "--help")
        assert proc.returncode == 0, f"{sub} --help 应成功"
