"""pytest 根 conftest：让 engine / runtime_trust 在任意工作目录下都可导入。

为什么需要它：本套件既在 skill-sentry 目录内被直接运行
（``python3 -m pytest tests/unit runtime_trust/tests``），也从仓库根被
``npm run test:resources`` 调用。后者的 cwd 是仓库根，``runtime_trust``
不在 ``sys.path`` 上——而 pytest 只会把**测试文件所在目录**加进去
（``runtime_trust/tests``），不会加它的父目录。

没有这个文件时，从仓库根运行会以 ``ModuleNotFoundError: No module named
'runtime_trust'`` 整体中断，而单元测试在本地永远是绿的——一套只在
CI 之外通过的测试等于没有测试。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
