#!/usr/bin/env python3
"""Validate AI product governance records without network or global writes."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from miniyaml import load as load_yaml


SCHEMA_BY_KIND = {
    "evidence": "evidence.schema.json",
    "gate-decision": "gate-decision.schema.json",
    "authority-grant": "authority-grant.schema.json",
    "spec-handoff": "spec-handoff.schema.json",
    "change-candidate": "change-candidate.schema.json",
}


def load_data(path: Path) -> Any:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return json.loads(text)
    return load_yaml(text)


def type_ok(value: Any, expected: str) -> bool:
    checks = {
        "object": lambda v: isinstance(v, dict),
        "array": lambda v: isinstance(v, list),
        "string": lambda v: isinstance(v, str),
        "null": lambda v: v is None,
        "boolean": lambda v: isinstance(v, bool),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    }
    return expected in checks and checks[expected](value)


def matches_fragment(value: Any, fragment: dict[str, Any]) -> bool:
    if not isinstance(fragment, dict):
        return False
    probe: list[str] = []
    validate_node(value, fragment, "$if", probe)
    return not probe


def validate_node(value: Any, schema: dict[str, Any], at: str, errors: list[str]) -> None:
    expected = schema.get("type")
    if expected is not None:
        allowed = [expected] if isinstance(expected, str) else expected
        if not any(type_ok(value, item) for item in allowed):
            errors.append(f"{at}: expected type {allowed}, got {type(value).__name__}")
            return

    if "const" in schema and value != schema["const"]:
        errors.append(f"{at}: expected constant {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{at}: value {value!r} is not in {schema['enum']!r}")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{at}: string is shorter than minLength")
        pattern = schema.get("pattern")
        if pattern and re.search(pattern, value) is None:
            errors.append(f"{at}: value does not match {pattern!r}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{at}: array is shorter than minItems")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                validate_node(item, item_schema, f"{at}[{index}]", errors)
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{at}: missing required field {key!r}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    errors.append(f"{at}: unexpected field {key!r}")
        for key, child_schema in properties.items():
            if key in value:
                validate_node(value[key], child_schema, f"{at}.{key}", errors)

    for conditional in schema.get("allOf", []):
        if_schema = conditional.get("if")
        then_schema = conditional.get("then")
        if isinstance(if_schema, dict) and isinstance(then_schema, dict):
            if matches_fragment(value, if_schema):
                validate_node(value, then_schema, at, errors)


def protection_checks(record: dict[str, Any], errors: list[str]) -> None:
    kind = record.get("kind")
    if kind == "evidence":
        if record.get("verification") == "Accepted" and record.get("source_type") in {"synthetic", "stub"}:
            errors.append("$: synthetic/stub evidence cannot be Accepted as a real outcome")
        if record.get("verification") == "Accepted" and not record.get("reviewer"):
            errors.append("$: Accepted evidence requires a human reviewer")
    elif kind == "gate-decision":
        if record.get("status") in {"approved", "returned", "rejected"}:
            for field in ("owner", "decided_at", "reason"):
                if not record.get(field):
                    errors.append(f"$: decided gate requires {field}")
            if not record.get("evidence_refs"):
                errors.append("$: decided gate requires at least one evidence reference")
    elif kind == "authority-grant":
        if record.get("level") == "A4" or record.get("a4_enabled") is True:
            errors.append("$: A4 is disabled in the candidate package")
        if record.get("level") == "A3":
            for field in ("owner", "approved_at", "rollback_plan"):
                if not record.get(field):
                    errors.append(f"$: A3 requires {field}")
            if not record.get("confirmation_points") or not record.get("audit_requirements"):
                errors.append("$: A3 requires confirmation points and audit requirements")
    elif kind == "spec-handoff":
        if record.get("ready_for_speckit") and record.get("discovery_gate_status") != "approved":
            errors.append("$: ready_for_speckit requires an approved Discovery Gate")
        if record.get("next_command") != "speckit.specify":
            errors.append("$: handoff must target native speckit.specify")
    elif kind == "change-candidate":
        if record.get("status") in {"accepted", "rejected"} and not record.get("owner_decision_ref"):
            errors.append("$: finalized change candidate requires owner_decision_ref")


def validate_record(path: Path, schema_dir: Path, project_root: Path) -> list[str]:
    errors: list[str] = []
    if path.is_symlink():
        return ["record path is a symlink"]
    resolved = path.resolve()
    try:
        resolved.relative_to(project_root)
    except ValueError:
        return ["record path escapes the project root"]
    try:
        record = load_data(resolved)
    except Exception as exc:  # noqa: BLE001
        return [f"cannot parse record: {exc}"]
    if not isinstance(record, dict):
        return ["record must be a mapping"]
    kind = record.get("kind")
    schema_name = SCHEMA_BY_KIND.get(kind)
    if schema_name is None:
        return [f"unknown kind {kind!r}"]
    try:
        schema = json.loads((schema_dir / schema_name).read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return [f"cannot load schema {schema_name}: {exc}"]
    validate_node(record, schema, "$", errors)
    protection_checks(record, errors)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("records", nargs="+", type=Path)
    parser.add_argument("--schema-dir", type=Path)
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args()

    script_root = Path(__file__).resolve().parent.parent
    schema_dir = (args.schema_dir or script_root / "schemas").resolve()
    project_root = args.project_root.resolve()
    results: dict[str, list[str]] = {}
    for record in args.records:
        path = record if record.is_absolute() else project_root / record
        results[str(record)] = validate_record(path, schema_dir, project_root)

    ok = all(not errors for errors in results.values())
    if args.json_output:
        print(json.dumps({"ok": ok, "results": results}, ensure_ascii=False, indent=2))
    else:
        for name, errors in results.items():
            if errors:
                print(f"FAIL {name}")
                for error in errors:
                    print(f"  - {error}")
            else:
                print(f"PASS {name}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
