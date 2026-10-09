"""
run_conformance.py — 回归验证脚本
=====================================

替代"人工看 json 报告"的自动化断言：
1. 对 fixtures 下的正例/反例样本运行扫描，比对回归向量（锁定分数/分级/建议）。
2. 对报告结构做轻量 schema 校验（必需字段 + 基本类型），不引入 jsonschema
   依赖，用标准库实现最小可用校验。

用法：
    python3 tests/conformance/v1.0.0/run_conformance.py
退出码：0 = 全部通过；1 = 存在断言失败。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from engine.scanner_core import scan  # noqa: E402

VECTORS_FILE = Path(__file__).resolve().parent / "scoring-vectors.json"
SCHEMA_FILE = ROOT / "engine" / "schemas" / "report-schema.json"


def load_schema_required_fields() -> list[str]:
    schema = json.loads(SCHEMA_FILE.read_text("utf-8"))
    return schema.get("required", [])


def validate_report_shape(report: dict, required_fields: list[str]) -> list[str]:
    """最小 schema 校验：必需字段是否存在 + 枚举值是否合法。不做完整 JSON Schema 校验。"""
    errors = []
    for field in required_fields:
        if field not in report:
            errors.append(f"缺少必需字段: {field}")
    if "security_score" in report:
        score = report["security_score"]
        if not isinstance(score, int) or not (0 <= score <= 100):
            errors.append(f"security_score 不在 [0,100] 范围: {score}")
    if "risk_classification" in report:
        if report["risk_classification"] not in ("LOW", "MEDIUM", "HIGH", "CRITICAL"):
            errors.append(f"risk_classification 非法值: {report['risk_classification']}")
    if "deployment_recommendation" in report:
        if report["deployment_recommendation"] not in ("ALLOW", "CAUTION", "DO_NOT_INSTALL"):
            errors.append(f"deployment_recommendation 非法值: {report['deployment_recommendation']}")
    return errors


def run() -> int:
    vectors = json.loads(VECTORS_FILE.read_text("utf-8"))
    required_fields = load_schema_required_fields()
    failures: list[str] = []
    passed = 0

    for vector in vectors["vectors"]:
        fixture_path = ROOT / vector["fixture"]
        report = scan(str(fixture_path))

        shape_errors = validate_report_shape(report, required_fields)
        if shape_errors:
            failures.append(f"[{vector['name']}] schema 校验失败: {shape_errors}")
            continue

        expect = vector["expect"]
        mismatches = []
        for key, expected_value in expect.items():
            actual_value = report.get(key)
            if actual_value != expected_value:
                mismatches.append(f"{key}: expected={expected_value!r} actual={actual_value!r}")
        if mismatches:
            failures.append(f"[{vector['name']}] 回归向量不匹配: {mismatches}")
        else:
            passed += 1

    total = len(vectors["vectors"])
    print(f"conformance: {passed}/{total} passed")
    if failures:
        for f in failures:
            print(f"  FAIL: {f}")
        return 1
    print("conformance smoke OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
