"""单元测试：版本区间判定。

为什么值得单独测
----------------
依赖漏洞扫描的**唯一**决策是「这个已安装版本是否落在受影响区间」。它错了不会
报错，只会给出一个看起来很像样的结论：要么漏掉一条真 CVE，要么让用户去升级
一个本来没问题的包。两类错误都不会有任何信号，只能靠边界用例锁住。

覆盖：
- semver / PEP 440 的常见排序与预发布边界
- OSV 的 ``introduced: 0`` 哨兵值
- 无法解析时返回 ``None``，而不是猜 True/False
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.scanner_core import versions  # noqa: E402


class TestNpmOrdering:
    def test_plain_versions(self):
        assert versions.compare("npm", "4.17.20", "4.17.21") == -1
        assert versions.compare("npm", "4.17.21", "4.17.21") == 0
        assert versions.compare("npm", "2.0.0", "10.0.0") == -1

    def test_short_forms_are_equal(self):
        # npm 把 `1.2` 与 `1.2.0` 视为同一版本。
        assert versions.compare("npm", "1.2", "1.2.0") == 0

    def test_prerelease_precedes_release(self):
        assert versions.compare("npm", "1.0.0-rc.1", "1.0.0") == -1
        assert versions.compare("npm", "1.0.0-alpha", "1.0.0-rc.1") == -1
        assert versions.compare("npm", "1.0.0-alpha", "1.0.0-alpha.1") == -1

    def test_build_metadata_is_ignored(self):
        assert versions.compare("npm", "1.0.0+build.7", "1.0.0") == 0

    def test_range_expressions_are_not_concrete_versions(self):
        assert versions.is_concrete("npm", "^1.2.3") is False
        assert versions.is_concrete("npm", "~1.2") is False
        assert versions.is_concrete("npm", "1.x") is False
        assert versions.is_concrete("npm", "4.17.20") is True


class TestPep440Ordering:
    def test_prerelease_post_and_dev(self):
        assert versions.compare("PyPI", "1.0a1", "1.0b1") == -1
        assert versions.compare("PyPI", "1.0b1", "1.0rc1") == -1
        assert versions.compare("PyPI", "1.0rc1", "1.0") == -1
        assert versions.compare("PyPI", "1.0.post1", "1.0") == 1
        assert versions.compare("PyPI", "1.0.dev1", "1.0a1") == -1
        assert versions.compare("PyPI", "1.0rc1.dev1", "1.0rc1") == -1

    def test_calendar_versions(self):
        assert versions.compare("PyPI", "2024.1", "2024.2") == -1
        assert versions.compare("PyPI", "2024.1", "2024.1.0") == 0

    def test_epoch_wins(self):
        assert versions.compare("PyPI", "1!1.0", "2.0") == 1

    def test_local_version_is_ignored(self):
        assert versions.compare("PyPI", "1.0+local", "1.0") == 0


class TestRanges:
    def test_introduced_and_fixed(self):
        # [4.0.0, 4.17.21)
        assert versions.in_range("npm", "4.17.20", "4.0.0", "4.17.21") is True
        assert versions.in_range("npm", "4.17.21", "4.0.0", "4.17.21") is False
        assert versions.in_range("npm", "3.10.1", "4.0.0", "4.17.21") is False

    def test_zero_sentinel_means_from_the_beginning(self):
        assert versions.in_range("npm", "0.0.1", "0", "1.0.0") is True

    def test_last_affected_is_inclusive(self):
        assert versions.in_range("PyPI", "5.1", "0", None, "5.1") is True
        assert versions.in_range("PyPI", "5.2", "0", None, "5.1") is False

    def test_unparseable_is_unknown_not_false(self):
        # 返回 None 而不是 False：调用方必须把「无法判定」与「确定不受影响」
        # 分开统计，否则覆盖信息会撒谎。
        assert versions.in_range("npm", "not-a-version", "0", "1.0.0") is None
        assert versions.in_range("npm", "1.0.0", "garbage", "2.0.0") is None


def test_pypi_names_are_normalized():
    # PEP 503：小写折叠，并把 `-`/`_`/`.` 的连续串归一为单个 `-`。
    assert versions.normalize_name("PyPI", "PyYAML") == "pyyaml"
    assert versions.normalize_name("PyPI", "py_yaml") == "py-yaml"
    assert versions.normalize_name("PyPI", "zope.interface") == "zope-interface"
    assert versions.normalize_name("npm", "Lodash") == "lodash"
