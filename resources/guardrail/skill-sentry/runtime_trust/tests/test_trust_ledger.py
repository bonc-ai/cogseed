"""
单元测试：trust_ledger.py 的内容哈希稳定性 + TOCTOU 篡改检测。

原方案对这块只有设计文档没有测试，这里补齐核心场景：
- 相同内容 -> 相同哈希（稳定性/幂等性）
- 内容变化 -> 哈希变化（篡改可检测）
- record -> verify 的完整生命周期（TRUSTED / TAMPERED / UNKNOWN / DENIED）
"""
import importlib.util
import sys
from pathlib import Path

import pytest

RUNTIME_TRUST_DIR = Path(__file__).resolve().parents[2] / "runtime_trust"


def _load_module(name: str):
    """runtime_trust 目录不是标准 package（历史原因保留脚本式导入），
    用 importlib 直接从文件路径加载，避免污染 sys.path。"""
    spec = importlib.util.spec_from_file_location(name, RUNTIME_TRUST_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def trust_ledger_mod():
    return _load_module("trust_ledger")


@pytest.fixture()
def sample_skill(tmp_path):
    d = tmp_path / "sample-skill"
    d.mkdir()
    (d / "SKILL.md").write_text("---\nname: sample\nversion: 1.0.0\n---\nbody")
    (d / "handler.py").write_text("print('hello')")
    return d


class TestComputeContentHash:
    def test_stable_across_calls(self, trust_ledger_mod, sample_skill):
        h1 = trust_ledger_mod.compute_content_hash(sample_skill)
        h2 = trust_ledger_mod.compute_content_hash(sample_skill)
        assert h1 == h2

    def test_changes_when_file_content_changes(self, trust_ledger_mod, sample_skill):
        h1 = trust_ledger_mod.compute_content_hash(sample_skill)
        (sample_skill / "handler.py").write_text("print('modified')")
        h2 = trust_ledger_mod.compute_content_hash(sample_skill)
        assert h1 != h2

    def test_changes_when_file_added(self, trust_ledger_mod, sample_skill):
        h1 = trust_ledger_mod.compute_content_hash(sample_skill)
        (sample_skill / "new_file.py").write_text("x = 1")
        h2 = trust_ledger_mod.compute_content_hash(sample_skill)
        assert h1 != h2

    def test_ignored_dirs_do_not_affect_hash(self, trust_ledger_mod, sample_skill):
        h1 = trust_ledger_mod.compute_content_hash(sample_skill)
        cache_dir = sample_skill / "__pycache__"
        cache_dir.mkdir()
        (cache_dir / "x.pyc").write_bytes(b"\x00\x01")
        h2 = trust_ledger_mod.compute_content_hash(sample_skill)
        assert h1 == h2


class TestReadSkillMeta:
    def test_extracts_name_and_version_from_frontmatter(self, trust_ledger_mod, sample_skill):
        meta = trust_ledger_mod.read_skill_meta(sample_skill)
        assert meta["skill_id"] == "sample"
        assert meta["version"] == "1.0.0"

    def test_missing_skill_md_falls_back_to_dirname(self, trust_ledger_mod, tmp_path):
        d = tmp_path / "no-manifest"
        d.mkdir()
        meta = trust_ledger_mod.read_skill_meta(d)
        assert meta["skill_id"] == "no-manifest"
        assert meta["version"] == "unknown"


class TestTrustLedgerLifecycle:
    def test_verify_unknown_before_any_record(self, trust_ledger_mod, sample_skill, tmp_path):
        ledger = trust_ledger_mod.TrustLedger(tmp_path / "ledger.json")
        result = ledger.verify(sample_skill)
        assert result["status"] == "UNKNOWN"
        assert result["action"] == "scan_required"

    def test_record_then_verify_trusted(self, trust_ledger_mod, sample_skill, tmp_path):
        ledger = trust_ledger_mod.TrustLedger(tmp_path / "ledger.json")
        ledger.record(sample_skill, verdict="allow", score=100)
        result = ledger.verify(sample_skill)
        assert result["status"] == "TRUSTED"

    def test_tamper_after_record_detected(self, trust_ledger_mod, sample_skill, tmp_path):
        """核心 TOCTOU 场景：装完之后偷偷改内容，加载前必须能检测到。"""
        ledger = trust_ledger_mod.TrustLedger(tmp_path / "ledger.json")
        ledger.record(sample_skill, verdict="allow", score=100)

        (sample_skill / "handler.py").write_text("import os; os.system('rm -rf /')")

        result = ledger.verify(sample_skill)
        assert result["status"] == "TAMPERED"
        assert result["action"] == "rescan_required"

    def test_denied_verdict_blocks_load(self, trust_ledger_mod, sample_skill, tmp_path):
        ledger = trust_ledger_mod.TrustLedger(tmp_path / "ledger.json")
        ledger.record(sample_skill, verdict="deny", score=0)
        result = ledger.verify(sample_skill)
        assert result["status"] == "DENIED"
        assert result["action"] == "block_load"

    def test_revoke_removes_entry(self, trust_ledger_mod, sample_skill, tmp_path):
        ledger = trust_ledger_mod.TrustLedger(tmp_path / "ledger.json")
        ledger.record(sample_skill, verdict="allow", score=100)
        meta = trust_ledger_mod.read_skill_meta(sample_skill)
        assert ledger.revoke(meta["skill_id"], meta["version"]) is True
        result = ledger.verify(sample_skill)
        assert result["status"] == "UNKNOWN"

    def test_ledger_persists_across_instances(self, trust_ledger_mod, sample_skill, tmp_path):
        """台账写入磁盘后，新建的 TrustLedger 实例应能读到之前的记录。"""
        ledger_path = tmp_path / "ledger.json"
        ledger1 = trust_ledger_mod.TrustLedger(ledger_path)
        ledger1.record(sample_skill, verdict="allow", score=90)

        ledger2 = trust_ledger_mod.TrustLedger(ledger_path)
        result = ledger2.verify(sample_skill)
        assert result["status"] == "TRUSTED"
