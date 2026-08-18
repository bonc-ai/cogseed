#!/usr/bin/env python3
"""3.1 Template Provider CLI — design doc §6 operations."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from security_core.template_provider import (  # noqa: E402
    describe_field,
    get_defaults,
    get_rule_index,
    get_template,
    list_fields,
    list_required_fields,
    list_supported_versions,
)


def _print(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ecs-security-template",
        description="ECS 3.1 Template Provider (§6: get-template / describe-field / …)",
    )
    parser.add_argument(
        "--ontology-version",
        default=None,
        help="精确 Ontology 版本，例如 1.1.1（list-supported-versions 可不传）",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # §6 六项正式能力
    sub.add_parser("get-template", help="返回 Security Manifest + Artifact Manifest（§6.3）模板")
    p_desc = sub.add_parser(
        "describe-field",
        help="返回字段含义、类型、是否必填、填写责任、枚举范围和 mode 约束",
    )
    p_desc.add_argument("field", help="字段路径，例如 risk.risk_level")
    sub.add_parser(
        "list-required-fields",
        help="分别返回 PREVALIDATION / FREEZE / FORMAL_TEST 必填字段清单",
    )
    sub.add_parser(
        "list-supported-versions",
        help="返回 current / supported / deprecated-but-supported / unsupported",
    )
    sub.add_parser("get-defaults", help="返回安全默认值（不写入业务事实或派生结论）")
    sub.add_parser(
        "get-rule-index",
        help="返回 derivation/trust/consistency/warning/digest 规则版本与 rule_id 索引",
    )

    # 辅助（非 §6 表内）
    p_list = sub.add_parser("list-fields", help="[辅助] 浏览 manifest-fields.yaml 目录")
    p_list.add_argument("--only-required", action="store_true")
    p_list.add_argument("--filler", choices=["creator", "security_core"], default=None)

    args = parser.parse_args(argv)
    needs_version = args.cmd != "list-supported-versions"
    if needs_version and not args.ontology_version:
        parser.error(f"{args.cmd} 需要 --ontology-version（精确版本匹配）")
    ver = args.ontology_version

    if args.cmd == "get-template":
        out = get_template(ver)
        _print(out)
        return int(out.get("exit_code", 40))
    if args.cmd == "describe-field":
        out = describe_field(ver, args.field)
        _print(out)
        return int(out.get("exit_code", 0 if out.get("ok") else 11))
    if args.cmd == "list-required-fields":
        out = list_required_fields(ver)
        _print(out)
        return int(out.get("exit_code", 0 if out.get("ok") else 40))
    if args.cmd == "list-supported-versions":
        out = list_supported_versions()
        _print(out)
        return int(out.get("exit_code", 0))
    if args.cmd == "get-defaults":
        out = get_defaults(ver)
        _print(out)
        return int(out.get("exit_code", 0 if out.get("ok") else 40))
    if args.cmd == "get-rule-index":
        out = get_rule_index(ver)
        _print(out)
        return int(out.get("exit_code", 0 if out.get("ok") else 40))
    if args.cmd == "list-fields":
        out = list_fields(
            ver,
            only_required=True if args.only_required else None,
            filler=args.filler,
        )
        _print(out)
        return 0 if out.get("ok") else 11
    return 40


if __name__ == "__main__":
    raise SystemExit(main())
