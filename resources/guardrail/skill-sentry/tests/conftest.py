"""
conftest.py — pytest 路径配置

把项目根加入 sys.path，使 `from engine.scanner_core import ...`
和 `import runtime_trust.xxx` 在测试中可直接导入。
"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="session")
def symlinks_supported() -> bool:
    """本账号能否创建符号链接。

    Windows 上 `os.symlink` 需要开发者模式或提权令牌，否则抛 WinError 1314
    (`EPERM`)。以符号链接为夹具的用例应据此跳过，而不是把它报成产品缺陷。
    """
    with tempfile.TemporaryDirectory(prefix="sentry-symlink-probe-") as root:
        target = Path(root) / "target.txt"
        target.write_text("probe", "utf-8")
        try:
            os.symlink(target, Path(root) / "link")
        except OSError:
            return False
    return True
