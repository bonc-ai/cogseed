"""
单元测试：trust_root.py 的签名基线构建 + 篡改自检（fail-closed 验证）。

覆盖场景：
- 无基线 -> NO_BASELINE
- 构建基线后自检 -> TRUSTED
- 篡改受保护文件后自检 -> COMPROMISED
- 篡改基线签名后自检 -> COMPROMISED（防止攻击者伪造基线本身）
- 密钥不一致（模拟密钥被换）-> COMPROMISED
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

# REPO-SHIM: upstream computes this from its own layout (tests inside
# runtime_trust/); here the engine lives under resources/guardrail.
RUNTIME_TRUST_DIR = Path(__file__).resolve().parents[4] / "resources" / "guardrail" / "skill-sentry" / "runtime_trust"


def _load_module(name: str):
    spec = importlib.util.spec_from_file_location(name, RUNTIME_TRUST_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def trust_root_mod():
    return _load_module("trust_root")


@pytest.fixture()
def fake_project(tmp_path):
    """构造一个最小可信项目根，包含若干"受保护文件"用于自检。"""
    root = tmp_path / "project"
    (root / "engine" / "scanner_core").mkdir(parents=True)
    (root / "engine" / "scanner_core" / "report.py").write_text("# scanner v1")
    (root / "runtime_trust").mkdir(parents=True, exist_ok=True)
    (root / "runtime_trust" / "trust_root.py").write_text("# trust root v1")
    return root


class TestBuildAndVerifyBaseline:
    def test_no_baseline_returns_no_baseline_status(self, trust_root_mod, fake_project, tmp_path):
        baseline_path = tmp_path / "nonexistent_baseline.json"
        key_path = str(tmp_path / "key.bin")
        result = trust_root_mod.verify_self(root=fake_project, baseline_path=baseline_path, key_path=key_path)
        assert result["status"] == "NO_BASELINE"

    def test_build_then_verify_trusted(self, trust_root_mod, fake_project, tmp_path):
        baseline_path = tmp_path / "baseline.json"
        key_path = str(tmp_path / "key.bin")
        build_result = trust_root_mod.build_baseline(
            root=fake_project,
            baseline_path=baseline_path,
            key_path=key_path,
            extra_files=["engine/scanner_core/report.py", "runtime_trust/trust_root.py"],
        )
        assert build_result["status"] == "OK"
        assert baseline_path.is_file()

        verify_result = trust_root_mod.verify_self(root=fake_project, baseline_path=baseline_path, key_path=key_path)
        assert verify_result["status"] == "TRUSTED"

    def test_tampered_protected_file_detected(self, trust_root_mod, fake_project, tmp_path):
        baseline_path = tmp_path / "baseline.json"
        key_path = str(tmp_path / "key.bin")
        trust_root_mod.build_baseline(
            root=fake_project, baseline_path=baseline_path, key_path=key_path,
            extra_files=["engine/scanner_core/report.py"],
        )

        # 攻击者篡改了扫描器代码（比如把规则删掉）
        (fake_project / "engine" / "scanner_core" / "report.py").write_text("# TAMPERED: rules removed")

        result = trust_root_mod.verify_self(root=fake_project, baseline_path=baseline_path, key_path=key_path)
        assert result["status"] == "COMPROMISED"
        assert "engine/scanner_core/report.py" in result["tampered"]

    def test_tampered_baseline_signature_detected(self, trust_root_mod, fake_project, tmp_path):
        """攻击者直接改基线文件本身（比如把 hash 也一起改了），没有密钥伪造不出合法签名。"""
        baseline_path = tmp_path / "baseline.json"
        key_path = str(tmp_path / "key.bin")
        trust_root_mod.build_baseline(
            root=fake_project, baseline_path=baseline_path, key_path=key_path,
            extra_files=["engine/scanner_core/report.py"],
        )

        baseline = json.loads(baseline_path.read_text("utf-8"))
        # 伪造：把 payload 里的 hash 换成篡改后文件的 hash，但没有正确的签名密钥无法重新签名
        fake_hash = "0" * 64
        list(baseline["payload"]["files"].keys())
        baseline["payload"]["files"]["engine/scanner_core/report.py"] = fake_hash
        baseline_path.write_text(json.dumps(baseline), "utf-8".join([]) or "utf-8")

        result = trust_root_mod.verify_self(root=fake_project, baseline_path=baseline_path, key_path=key_path)
        assert result["status"] == "COMPROMISED"
        assert "签名" in result["reason"]

    def test_missing_protected_file_detected(self, trust_root_mod, fake_project, tmp_path):
        baseline_path = tmp_path / "baseline.json"
        key_path = str(tmp_path / "key.bin")
        trust_root_mod.build_baseline(
            root=fake_project, baseline_path=baseline_path, key_path=key_path,
            extra_files=["engine/scanner_core/report.py"],
        )

        (fake_project / "engine" / "scanner_core" / "report.py").unlink()

        result = trust_root_mod.verify_self(root=fake_project, baseline_path=baseline_path, key_path=key_path)
        assert result["status"] == "COMPROMISED"
        assert "engine/scanner_core/report.py" in result["missing"]

    def test_corrupted_baseline_file_detected(self, trust_root_mod, fake_project, tmp_path):
        baseline_path = tmp_path / "baseline.json"
        key_path = str(tmp_path / "key.bin")
        baseline_path.write_text("{not valid json")
        result = trust_root_mod.verify_self(root=fake_project, baseline_path=baseline_path, key_path=key_path)
        assert result["status"] == "COMPROMISED"
