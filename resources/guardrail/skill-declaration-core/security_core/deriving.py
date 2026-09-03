"""Risk derivation — DISABLED.

Phase-1 process adjustment: five-dimension risk calculation and assignment of
derived fields (calculated_risk_level / effective_risk_level / …) are cancelled.
Do not call this module from the pipeline or from the Creator precheck.
"""

from __future__ import annotations

from typing import Any

RISK_DERIVATION_ENABLED = False


def derive_risk_fields(
    manifest: dict[str, Any],
    skill_root: str | None = None,
    ontology_version: str = "1.1.1",
) -> dict[str, Any]:
    """Deprecated: risk derivation is disabled. Raises if invoked."""
    _ = (manifest, skill_root, ontology_version)
    raise RuntimeError(
        "risk derivation is disabled (derive_risk_fields); "
        "do not calculate or assign risk.calculated_risk_level / "
        "effective_risk_level / calculation_* / triggered_rule_ids"
    )
