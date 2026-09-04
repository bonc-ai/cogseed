"""Text / path / JSON canonicalization used by the digest pipeline.

The rules here are part of the frozen digest contract: two file trees that are
"the same" must always canonicalize to the same bytes, otherwise historical
digests stop verifying. Changing any rule in this module is a digest-format
breaking change and must never happen silently.
"""

from __future__ import annotations

import json
import unicodedata
from typing import Any


def to_nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value)


def fold_path(path: str) -> str:
    """Normalize a relative path: NFC, forward slashes, no ./ and no dup slashes."""
    p = to_nfc(path.replace("\\", "/"))
    while "//" in p:
        p = p.replace("//", "/")
    if p.startswith("./"):
        p = p[2:]
    return p.strip("/")


def deep_normalize(value: Any) -> Any:
    if isinstance(value, str):
        return to_nfc(value)
    if isinstance(value, list):
        return [deep_normalize(v) for v in value]
    if isinstance(value, dict):
        return {to_nfc(str(k)): deep_normalize(value[k]) for k in sorted(value.keys(), key=lambda x: to_nfc(str(x)))}
    return value


def sorted_rule_ids(rule_ids: list[str] | None) -> list[str]:
    return sorted({to_nfc(r) for r in (rule_ids or [])})


def normalized_factors(factors: dict[str, Any] | None) -> dict[str, Any]:
    return {} if not factors else deep_normalize(factors)


def normalized_derived_risk(risk: dict[str, Any]) -> dict[str, Any]:
    out = dict(risk)
    if "triggered_rule_ids" in out:
        out["triggered_rule_ids"] = sorted_rule_ids(out.get("triggered_rule_ids"))
    if "calculation_factors" in out:
        out["calculation_factors"] = normalized_factors(out.get("calculation_factors"))
    return deep_normalize(out)


def canonical_json_bytes(obj: Any) -> bytes:
    return json.dumps(
        deep_normalize(obj),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def derived_risk_equal(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return normalized_derived_risk(a) == normalized_derived_risk(b)
