"""单元测试：规则集加载不得静默缩水。

为什么这条必须有
----------------
实测（2026-10）：应用自带运行时 `resources/runtime/python/**` 与仓库 venv 都没有
pyyaml，而 skill 自带的 `vendor/yaml` 此前**没有被接进 sys.path**，于是扫描器静默
退回内置规则——`rule_count` 从 181 掉到 64、12 个规则组全部失效——而
`_ruleset_resolved` 仍然报 True，审计面上看不出来。出厂形态走的正是这条路径：
安全扫描适配器用自带运行时跑 skill-sentry（见 src/main/util/bundled-runtime.ts）。

覆盖：
- 完整规则集必须真正加载（而不是 builtin），组数与规则数都要够
- 无可用 YAML 解析器时必须如实标记 `_ruleset_resolved=False`
- `vendor/yaml` 必须随 skill 存在，且报告里的 `coverage.rules_source` 要能看见实情
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.scanner_core import rule_loader, scan  # noqa: E402

SAFE = str(ROOT / "tests/fixtures/legacy-samples/sample-safe-skill")


class TestRulesetIsActuallyLoaded:
    def test_versioned_ruleset_is_loaded_not_builtin(self):
        rules = rule_loader.load_rules()
        assert rules["_rules_source"].startswith("ruleset v"), (
            f"规则集退回了内置规则：{rules['_rules_source']}。"
            "完整规则集读不到，扫描强度会静默缩水一大截"
        )
        assert rules["_ruleset_resolved"] is True
        assert len(rules["rule_groups"]) >= 10, (
            f"只加载到 {len(rules['rule_groups'])} 个规则组，预期 12 个"
        )

    def test_builtin_fallback_is_much_smaller(self, monkeypatch):
        """把「缩水有多大」写成端到端断言。

        量的是报告里的 `coverage.rule_count`——UI 与集成方读的就是这个数。
        实测：完整规则集 181 条，内置兜底 64 条（缩水约 65%）。
        """
        loaded = scan(SAFE)["coverage"]["rule_count"]
        monkeypatch.setattr(rule_loader, "yaml", None)
        builtin = scan(SAFE)["coverage"]["rule_count"]
        assert builtin * 2 <= loaded, (
            f"内置规则 {builtin} 条、完整规则集 {loaded} 条："
            "回退不再显著缩水，这条断言需要重新标定"
        )
        assert loaded >= 150, f"完整规则集只有 {loaded} 条，明显不完整"

    def test_a_yaml_parser_is_always_available(self):
        """环境没有 pyyaml 时，必须能落到 skill 自带的副本上。"""
        assert rule_loader.yaml is not None, (
            "没有任何可用的 YAML 解析器：环境未安装 pyyaml，vendor/yaml 也没被接进来"
        )
        assert (ROOT / "vendor" / "yaml" / "__init__.py").is_file(), (
            "vendor/yaml 缺失：完整规则集的可用性又变成「取决于运行环境」"
        )

    def test_default_ruleset_comes_from_current(self):
        """默认版本必须读 CURRENT，否则新增规则包会「写了但没生效」。"""
        current = (ROOT / "engine" / "rulesets" / "CURRENT").read_text("utf-8").strip()
        assert rule_loader.DEFAULT_RULESET_VERSION == current

    def test_current_ruleset_ships_native_detection_backends(self):
        """当前规则包必须带漏洞快照与 YARA 签名包。

        这两份文件是 2.3.0 两项能力的交付物；升规则包时漏掉它们，能力页会
        重新退化成「需要额外工具 / 部分实现」，而扫描器本身不会报错。
        """
        directory = rule_loader.ruleset_dir(rule_loader.DEFAULT_RULESET_VERSION)
        assert directory is not None
        assert (directory / "vulnerabilities.jsonl").is_file()
        assert list((directory / "yara").glob("*.yar"))

    def test_report_exposes_the_real_rules_source(self):
        """端到端：报告里那行字必须反映真相（UI 与集成方都读它）。"""
        coverage = scan(SAFE)["coverage"]
        assert coverage["rules_source"].startswith("ruleset v"), coverage["rules_source"]
        assert coverage["ruleset_resolved"] is True


class TestMissingYamlIsReported:
    def test_missing_yaml_marks_ruleset_unresolved(self, monkeypatch):
        """解析器不可用 = 请求的版本没解析，不能报 True。"""
        monkeypatch.setattr(rule_loader, "yaml", None)
        rules = rule_loader.load_rules()
        assert rules["_ruleset_resolved"] is False, (
            "回退到内置规则却报 _ruleset_resolved=True："
            "上层无法区分「扫了 v1.1.0」和「扫了 64 条内置规则」"
        )
        assert "内置默认规则" in rules["_rules_source"]
