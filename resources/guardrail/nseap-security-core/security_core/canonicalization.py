"""UTF-8 NFC / path / JSON / derived-field canonicalization."""

from __future__ import annotations

import json
import unicodedata
from typing import Any


def nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value)


def normalize_path(path: str) -> str:
    p = nfc(path.replace("\\", "/"))
    while "//" in p:
        p = p.replace("//", "/")
    if p.startswith("./"):
        p = p[2:]
    return p.strip("/")


def canonicalize_value(value: Any) -> Any:
    if isinstance(value, str):
        return nfc(value)
    if isinstance(value, list):
        return [canonicalize_value(v) for v in value]
    if isinstance(value, dict):
        return {nfc(str(k)): canonicalize_value(value[k]) for k in sorted(value.keys(), key=lambda x: nfc(str(x)))}
    return value


def canonicalize_triggered_rule_ids(rule_ids: list[str] | None) -> list[str]:
    return sorted({nfc(r) for r in (rule_ids or [])})


def canonicalize_calculation_factors(factors: dict[str, Any] | None) -> dict[str, Any]:
    if not factors:
        return {}
    return canonicalize_value(factors)


def canonicalize_derived_risk(risk: dict[str, Any]) -> dict[str, Any]:
    out = dict(risk)
    if "triggered_rule_ids" in out:
        out["triggered_rule_ids"] = canonicalize_triggered_rule_ids(out.get("triggered_rule_ids"))
    if "calculation_factors" in out:
        out["calculation_factors"] = canonicalize_calculation_factors(out.get("calculation_factors"))
    return canonicalize_value(out)


def stable_json_bytes(obj: Any) -> bytes:
    return json.dumps(
        canonicalize_value(obj),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def derived_equal(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return canonicalize_derived_risk(a) == canonicalize_derived_risk(b)
