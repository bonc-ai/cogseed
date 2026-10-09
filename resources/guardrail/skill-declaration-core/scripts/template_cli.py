#!/usr/bin/env python3
"""3.1 Template Provider CLI (§6: get-template / describe-field / …).

Subcommand surface and per-subcommand exit codes are the cross-process
contract; the backing implementation lives in ``security_core.templates``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from security_core import templates  # noqa: E402


def _print(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cogseed-security-template",
        description="Security 3.1 Template Provider (§6: get-template / describe-field / …)",
    )
    parser.add_argument(
        "--ontology-version",
        default=None,
        help="精确 Ontology 版本，例如 1.1.1（list-supported-versions 可不传）",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("get-template", help="返回 Security Manifest + Artifact Manifest（§6.3）模板")
    p_desc = sub.add_parser(
        "describe-field",
        help="返回字段含义、类型、是否必填、填写责任、枚举范围和 mode 约束",
    )
    p_desc.add_argument("field", help="字段路径，例如 risk.risk_level")
    sub.add_parser("list-required-fields", help="分别返回 PREVALIDATION / FREEZE / FORMAL_TEST 必填字段清单")
    sub.add_parser("list-supported-versions", help="返回 current / supported / deprecated-but-supported / unsupported")
    sub.add_parser("get-defaults", help="返回安全默认值（不写入业务事实或派生结论）")
    sub.add_parser("get-rule-index", help="返回 derivation/trust/consistency/warning/digest 规则版本与 rule_id 索引")
    p_list = sub.add_parser("list-fields", help="[辅助] 浏览 manifest-fields.yaml 目录")
    p_list.add_argument("--only-required", action="store_true")
    p_list.add_argument("--filler", choices=["creator", "security_core"], default=None)

    args = parser.parse_args(argv)
    needs_version = args.cmd != "list-supported-versions"
    if needs_version and not args.ontology_version:
        parser.error(f"{args.cmd} 需要 --ontology-version（精确版本匹配）")
    ver = args.ontology_version

    dispatch = {
        "get-template": lambda: templates.build_template(ver),
        "describe-field": lambda: templates.describe(ver, args.field),
        "list-required-fields": lambda: templates.required_fields_by_mode(ver),
        "list-supported-versions": lambda: templates.supported_versions(),
        "get-defaults": lambda: templates.safe_defaults(ver),
        "get-rule-index": lambda: templates.rule_index(ver),
        "list-fields": lambda: templates.browse_fields(
            ver,
            only_required=True if args.only_required else None,
            filler=args.filler,
        ),
    }
    out = dispatch[args.cmd]()
    _print(out)

    fallback_codes = {
        "describe-field": 0 if out.get("ok") else 11,
        "list-required-fields": 0 if out.get("ok") else 40,
        "list-supported-versions": 0,
        "get-defaults": 0 if out.get("ok") else 40,
        "get-rule-index": 0 if out.get("ok") else 40,
        "list-fields": 0 if out.get("ok") else 11,
    }
    if args.cmd == "get-template":
        return int(out.get("exit_code", 40))
    return int(out.get("exit_code", fallback_codes.get(args.cmd, 40)))


if __name__ == "__main__":
    raise SystemExit(main())
