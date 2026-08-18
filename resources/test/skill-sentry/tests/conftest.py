"""
conftest.py — pytest 路径配置

把项目根加入 sys.path，使 `from engine.scanner_core import ...`
和 `import runtime_trust.xxx` 在测试中可直接导入。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
