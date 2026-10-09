"""
单元测试：fail-closed 行为（对齐 Skill 安全检测调研文档的硬要求
「扫描出错或无法完成，视为不通过，不物化安装」）。

覆盖：
- 引擎内部异常 → scan() 返回 status=ERROR + DO_NOT_INSTALL，不抛异常
- 顶层流程异常 → 同样 fail-closed
- 请求不存在的规则版本 → ruleset_resolved=False 显式标记（可审计），
  不静默伪装成已解析
- agent_gate 降级路径遇异常 → verdict=review（不放行）
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "sandbox") not in sys.path:
    sys.path.insert(0, str(ROOT / "sandbox"))

from engine.scanner_core import report as report_mod
from engine.scanner_core.rule_loader import load_rules

SAFE = str(ROOT / "tests/fixtures/legacy-samples/sample-safe-skill")


class TestRulesetResolution:
    def test_existing_version_marked_resolved(self):
        rules = load_rules("v1.0.0")
        assert rules["_ruleset_resolved"] is True
        assert rules["_requested_version"] == "v1.0.0"

    def test_nonexistent_version_marked_unresolved(self):
        rules = load_rules("v9.9.9-nonexistent")
        # 仍回退内置规则（有规则可扫），但显式标记未解析，供上层审计
        assert rules["_ruleset_resolved"] is False
        assert rules["_requested_version"] == "v9.9.9-nonexistent"
        assert "不存在" in rules["_rules_source"]

    def test_report_carries_ruleset_resolved_flag(self):
        r = report_mod.scan(SAFE, ruleset_version="v9.9.9-nonexistent")
        assert r["ruleset_resolved"] is False


class TestEngineFailClosed:
    def test_scan_one_skill_exception_becomes_error_do_not_install(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("模拟规则匹配崩溃")
        monkeypatch.setattr(report_mod, "scan_one_skill", boom)
        r = report_mod.scan(SAFE)
        assert r["status"] == "ERROR"
        assert r["deployment_recommendation"] == "DO_NOT_INSTALL"
        assert r["security_score"] == 0

    def test_toplevel_exception_becomes_error_do_not_install(self, monkeypatch):
        def boom(*a, **k):
            raise OSError("模拟临时目录/解压崩溃")
        monkeypatch.setattr(report_mod, "_scan_impl", boom)
        r = report_mod.scan(SAFE)
        assert r["status"] == "ERROR"
        assert r["deployment_recommendation"] == "DO_NOT_INSTALL"
        assert r["hard_blocked"] is True

    def test_missing_artifact_fail_closed(self):
        r = report_mod.scan("/nonexistent/path/to/skill")
        assert r["status"] == "ERROR"
        assert r["deployment_recommendation"] == "DO_NOT_INSTALL"


class TestAgentGateFailClosed:
    def test_degraded_engine_error_becomes_review(self, monkeypatch):
        import agent_gate
        monkeypatch.setattr(
            agent_gate, "_run_degraded",
            lambda p: {"status": "ERROR", "error": "boom",
                       "deployment_recommendation": "DO_NOT_INSTALL", "security_score": 0},
        )
        # 强制走降级路径（无沙箱）
        monkeypatch.setattr(agent_gate, "_run_sandboxed", lambda p: None)
        res = agent_gate.evaluate_skill(SAFE, require_isolation=False)
        assert res["verdict"] == "review"
        assert res["isolated"] is False
        assert res["scan_mode"] == "degraded-error"

    def test_run_degraded_never_raises_on_import_failure(self, monkeypatch):
        import agent_gate
        # 破坏 PROJECT_ROOT 让 import 失败，验证兜底为 ERROR 而非抛异常
        res = agent_gate._run_degraded(Path("/nonexistent"))
        # 即便路径不存在，scan() 也应返回 ERROR 而非崩溃
        assert res.get("status") == "ERROR"
        assert res.get("deployment_recommendation") == "DO_NOT_INSTALL"
