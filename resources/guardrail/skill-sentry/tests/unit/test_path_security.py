"""单元测试：path_security.py 的 zip slip 防护和 Skill 边界定位。"""
import zipfile
from pathlib import Path

import pytest

from engine.scanner_core.path_security import (
    collect_evidence,
    locate_skill_roots,
    safe_extract,
)


class TestSafeExtract:
    def test_directory_input_returned_as_is(self, tmp_path):
        d = tmp_path / "skill"
        d.mkdir()
        result = safe_extract(d, tmp_path / "dest")
        assert result == d.resolve()

    def test_non_zip_file_returned_as_is(self, tmp_path):
        f = tmp_path / "notes.txt"
        f.write_text("hello")
        result = safe_extract(f, tmp_path / "dest")
        assert result == f.resolve()

    def test_normal_zip_extracts_successfully(self, tmp_path):
        zip_path = tmp_path / "skill.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("SKILL.md", "---\nname: test\n---\n")
        dest = tmp_path / "dest"
        dest.mkdir()
        result = safe_extract(zip_path, dest)
        assert (result / "SKILL.md").is_file()

    def test_zip_slip_path_traversal_rejected(self, tmp_path):
        """恶意 zip 试图写到目标目录外（../../etc/passwd 风格），必须拒绝。"""
        zip_path = tmp_path / "evil.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("../../../tmp/evil_escape.txt", "pwned")
        dest = tmp_path / "dest"
        dest.mkdir()
        with pytest.raises(ValueError, match="unsafe zip path"):
            safe_extract(zip_path, dest)

    def test_single_subdir_zip_unwraps_root(self, tmp_path):
        """zip 里只有一个顶层目录时，返回该目录而不是解压根（常见的 GitHub 打包结构）。"""
        zip_path = tmp_path / "skill.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("my-skill/SKILL.md", "---\nname: test\n---\n")
        dest = tmp_path / "dest"
        dest.mkdir()
        result = safe_extract(zip_path, dest)
        assert result.name == "my-skill"


class TestLocateSkillRoots:
    def test_single_skill_root(self, tmp_path):
        (tmp_path / "SKILL.md").write_text("---\nname: x\n---\n")
        roots = locate_skill_roots(tmp_path)
        assert roots == [tmp_path.resolve()]

    def test_multiple_skill_roots(self, tmp_path):
        (tmp_path / "a").mkdir()
        (tmp_path / "a" / "SKILL.md").write_text("x")
        (tmp_path / "b").mkdir()
        (tmp_path / "b" / "SKILL.md").write_text("x")
        roots = locate_skill_roots(tmp_path)
        assert len(roots) == 2

    def test_ignored_dirs_excluded(self, tmp_path):
        (tmp_path / "real").mkdir()
        (tmp_path / "real" / "SKILL.md").write_text("x")
        (tmp_path / "node_modules" / "pkg").mkdir(parents=True)
        (tmp_path / "node_modules" / "pkg" / "SKILL.md").write_text("x")
        roots = locate_skill_roots(tmp_path)
        assert len(roots) == 1
        assert roots[0].name == "real"

    def test_no_skill_md_falls_back_to_source(self, tmp_path):
        roots = locate_skill_roots(tmp_path)
        assert roots == [tmp_path.resolve()]

    def test_file_input_returns_parent_dir(self, tmp_path):
        f = tmp_path / "SKILL.md"
        f.write_text("x")
        roots = locate_skill_roots(f)
        assert roots == [tmp_path.resolve()]


class TestCollectEvidence:
    def test_collects_text_files(self, tmp_path):
        (tmp_path / "SKILL.md").write_text("hello world")
        (tmp_path / "config.yaml").write_text("key: value")
        files, docs = collect_evidence(tmp_path)
        assert "skill.md" in files
        assert "config.yaml" in files
        assert len(docs) == 2

    def test_binary_files_not_read_as_text(self, tmp_path):
        (tmp_path / "app.bin").write_bytes(b"\x7fELF\x00\x00\x00\x00")
        files, docs = collect_evidence(tmp_path)
        assert "app.bin" in files
        assert len(docs) == 0  # .bin 不在 TEXT_EXT 里，不会被当文本读取

    def test_oversized_file_skipped(self, tmp_path):
        big = tmp_path / "big.txt"
        big.write_bytes(b"a" * 2_000_000)  # 超过 1MB 单文件上限
        files, docs = collect_evidence(tmp_path)
        assert "big.txt" in files
        assert len(docs) == 0
