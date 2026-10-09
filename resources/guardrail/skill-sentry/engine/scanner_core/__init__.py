"""
scanner_core — Skill Sentry 检测引擎
=======================================

对外公开 API：scan()。CLI 用 `python3 -m engine.scanner_core.report`。

注意：避免在这里 eager import report 模块的符号（会与 `python3 -m` 的
模块执行方式产生 RuntimeWarning: found in sys.modules 冲突）。改用
__getattr__ 懒加载，保持 `from engine.scanner_core import scan` 可用。
"""

__version__ = "2.1.0"

_LAZY = {"scan", "scan_one_skill", "SCANNER_VERSION"}


def __getattr__(name):
    if name in _LAZY:
        from . import report as _report
        return getattr(_report, name)
    if name == "DEFAULT_RULESET_VERSION":
        from . import rule_loader as _rule_loader
        return _rule_loader.DEFAULT_RULESET_VERSION
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["scan", "scan_one_skill", "SCANNER_VERSION", "DEFAULT_RULESET_VERSION"]
