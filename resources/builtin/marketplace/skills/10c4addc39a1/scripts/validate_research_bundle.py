#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OFFICIAL_STANDARD_TYPES = {
    "official_standard",
    "official_specification",
    "international_organization",
    "official_guidance",
}
VERIFIED = {"verified", "verified_with_caveat"}


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return "sha256:" + h.hexdigest()


def schema_errors(data: Any, schema_path: Path) -> list[str]:
    schema = load_json(schema_path)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    out: list[str] = []
    for error in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path)):
        loc = "/".join(map(str, error.absolute_path)) or "$"
        out.append(f"{loc}: {error.message}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Validate the mandatory web-research plan and ledger, cross-check report sources/standards, and compute the hard research gate."
    )
    ap.add_argument("--plan", required=True)
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--report-data", required=True)
    ap.add_argument("--gate-out", required=True)
    ap.add_argument("--out", required=True, help="Research validation report JSON")
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args()

    plan_path = Path(args.plan).resolve()
    ledger_path = Path(args.ledger).resolve()
    report_path = Path(args.report_data).resolve()
    gate_path = Path(args.gate_out).resolve()
    validation_path = Path(args.out).resolve()

    try:
        plan = load_json(plan_path)
        ledger = load_json(ledger_path)
        report = load_json(report_path)
    except Exception as exc:
        print(f"RESEARCH GATE FAILED: cannot read JSON: {exc}", file=sys.stderr)
        return 2

    checks: list[dict[str, Any]] = []
    blockers: list[str] = []
    warnings: list[str] = []

    def check(check_id: str, condition: bool, message_ok: str, message_fail: str, refs: list[str] | None = None, warning: bool = False) -> bool:
        status = "passed" if condition else ("warning" if warning else "failed")
        message = message_ok if condition else message_fail
        checks.append({"check_id": check_id, "status": status, "message": message, "evidence_refs": refs or []})
        if not condition:
            (warnings if warning else blockers).append(f"{check_id}: {message_fail}")
        return condition

    # JSON Schema validation is the first symbolic gate.
    schema_specs = [
        (plan, ROOT / "schemas/research-plan.schema.json", "RG-SCHEMA-PLAN"),
        (ledger, ROOT / "schemas/web-research-ledger.schema.json", "RG-SCHEMA-LEDGER"),
    ]
    for payload, schema_path, cid in schema_specs:
        errs = schema_errors(payload, schema_path)
        check(cid, not errs, f"{schema_path.name} validation passed", "; ".join(errs[:8]) or "schema validation failed", [str(schema_path)])

    # Cross-artifact identity.
    meta = report.get("meta", {})
    same_identity = (
        plan.get("plan_id") == ledger.get("plan_id")
        and plan.get("task_id") == ledger.get("task_id")
        and str(plan.get("domain", {}).get("volume_number")) == str(meta.get("volume_number"))
        and plan.get("domain", {}).get("domain_name_cn") == meta.get("domain_name_cn")
        and plan.get("domain", {}).get("domain_name_en") == meta.get("domain_name_en")
        and plan.get("research_date") == ledger.get("research_date") == meta.get("research_date")
        and plan.get("research_mode") == ledger.get("research_mode")
    )
    check(
        "RG-IDENTITY",
        same_identity,
        "Research plan, ledger, and report data describe the same task/domain/research date",
        "Plan, ledger, and report identity/date/domain do not match",
        [plan.get("plan_id", ""), ledger.get("ledger_id", ""), str(meta.get("volume_number", ""))],
    )

    mode = plan.get("research_mode")
    minimum = plan.get("minimum_evidence", {})
    questions = plan.get("research_questions", [])
    queries = ledger.get("queries", [])
    sources = ledger.get("sources", [])
    claims = ledger.get("claims", [])
    resolutions = ledger.get("question_resolutions", [])
    standards_ver = ledger.get("standard_verifications", [])
    conflicts = ledger.get("conflicts", [])
    policy = ledger.get("policy_scope_verification", {})

    # Unique IDs and link resolution.
    query_ids = [str(q.get("query_id", "")) for q in queries]
    source_ids = [str(s.get("source_id", "")) for s in sources]
    report_source_ids = [str(s.get("report_source_id", "")) for s in sources]
    claim_ids = [str(c.get("claim_id", "")) for c in claims]
    unique_ids = (
        len(query_ids) == len(set(query_ids))
        and len(source_ids) == len(set(source_ids))
        and len(report_source_ids) == len(set(report_source_ids))
        and len(claim_ids) == len(set(claim_ids))
    )
    check("RG-UNIQUE-IDS", unique_ids, "Query/source/claim identifiers are unique", "Duplicate query, source, report-source, or claim identifiers detected")

    query_set, source_set, claim_set = set(query_ids), set(source_ids), set(claim_ids)
    refs_ok = True
    dangling: list[str] = []
    for q in queries:
        for sid in q.get("selected_source_ids", []):
            if sid not in source_set:
                refs_ok = False
                dangling.append(f"query {q.get('query_id')} -> {sid}")
    for s in sources:
        for qid in s.get("query_ids", []):
            if qid not in query_set:
                refs_ok = False
                dangling.append(f"source {s.get('source_id')} -> query {qid}")
        for cid in s.get("supports_claim_ids", []):
            if cid not in claim_set:
                refs_ok = False
                dangling.append(f"source {s.get('source_id')} -> claim {cid}")
    for c in claims:
        for sid in c.get("source_ids", []):
            if sid not in source_set:
                refs_ok = False
                dangling.append(f"claim {c.get('claim_id')} -> source {sid}")
    for r in resolutions:
        for sid in r.get("source_ids", []):
            if sid not in source_set:
                refs_ok = False
                dangling.append(f"question {r.get('question_id')} -> source {sid}")
    for sv in standards_ver:
        for sid in sv.get("report_source_ids", []):
            if sid not in report_source_ids:
                refs_ok = False
                dangling.append(f"standard {sv.get('standard_name')} -> report source {sid}")
    for sid in policy.get("source_ids", []):
        if sid not in source_set:
            refs_ok = False
            dangling.append(f"policy scope -> source {sid}")
    for bc in policy.get("boundary_conflicts", []):
        for sid in bc.get("source_ids", []):
            if sid not in source_set:
                refs_ok = False
                dangling.append(f"boundary conflict -> source {sid}")
    for cf in conflicts:
        for sid in cf.get("source_ids", []):
            if sid not in source_set:
                refs_ok = False
                dangling.append(f"conflict {cf.get('conflict_id')} -> source {sid}")
    check("RG-LEDGER-REFS", refs_ok, "All research-ledger references resolve", "Dangling research references: " + ", ".join(dangling[:12]))

    # Search execution and minimum evidence.
    if mode == "synthetic_fixture":
        web_executed = len(queries) >= int(minimum.get("min_queries", 1)) and all(q.get("tool") == "synthetic_fixture" for q in queries)
    else:
        web_executed = (
            plan.get("web_research_required") is True
            and len(queries) >= int(minimum.get("min_queries", 1))
            and any(q.get("tool") == "web.search_query" for q in queries)
        )
    check(
        "RG-WEB-EXECUTED",
        web_executed,
        f"Research execution recorded ({len(queries)} queries)",
        "Mandatory web research was not executed or minimum query count was not met",
        query_ids,
    )

    opened_sources = [s for s in sources if s.get("opened_and_read") is True]
    all_selected_opened = len(opened_sources) == len(sources) and len(opened_sources) >= int(minimum.get("min_opened_sources", 1))
    check(
        "RG-OPENED-SOURCES",
        all_selected_opened,
        f"All selected sources were opened/read ({len(opened_sources)})",
        "One or more selected sources were not opened/read or the minimum opened-source count was not met",
        [s.get("source_id", "") for s in opened_sources],
    )

    snippet_free = all(s.get("retrieval_depth") in {"full_page", "relevant_section", "pdf_text", "pdf_screenshot", "synthetic_fixture"} for s in sources)
    check("RG-NO-SNIPPET-EVIDENCE", snippet_free, "Search snippets are not used as evidence", "A search snippet or insufficient retrieval depth was used as evidence")

    # Official-source quality and minimum counts.
    verified_sources = [s for s in sources if s.get("verification_status") in VERIFIED]
    verified_primary = [s for s in verified_sources if s.get("primary_source") is True]
    official_policy_sources = [
        s for s in verified_primary
        if s.get("source_type") == "official_policy" and s.get("official_domain") is True
    ]
    official_standard_sources = [
        s for s in verified_primary
        if s.get("source_type") in OFFICIAL_STANDARD_TYPES and s.get("official_domain") is True
    ]
    official_shape_ok = all(
        (s.get("primary_source") is True and s.get("official_domain") is True)
        for s in sources
        if s.get("source_type") != "secondary_discovery"
    )
    check("RG-OFFICIAL-SOURCE-SHAPE", official_shape_ok, "All official-source records are primary and on official domains", "An official-source record is not marked primary/official-domain")
    check(
        "RG-MIN-PRIMARY",
        len(verified_primary) >= int(minimum.get("min_verified_primary_sources", 1)),
        f"Verified primary-source minimum met ({len(verified_primary)})",
        f"Verified primary sources {len(verified_primary)} below required {minimum.get('min_verified_primary_sources')}",
        [s.get("source_id", "") for s in verified_primary],
    )
    policy_found = len(official_policy_sources) >= int(minimum.get("min_official_policy_sources", 1))
    check(
        "RG-POLICY-SOURCE",
        policy_found,
        f"Official policy-source minimum met ({len(official_policy_sources)})",
        f"Official policy sources {len(official_policy_sources)} below required {minimum.get('min_official_policy_sources')}",
        [s.get("source_id", "") for s in official_policy_sources],
    )
    standards_min_ok = len(official_standard_sources) >= int(minimum.get("min_official_standard_sources", 1))
    check(
        "RG-STANDARD-SOURCE-MIN",
        standards_min_ok,
        f"Official standard/specification-source minimum met ({len(official_standard_sources)})",
        f"Official standard/specification sources {len(official_standard_sources)} below required {minimum.get('min_official_standard_sources')}",
        [s.get("source_id", "") for s in official_standard_sources],
    )

    # Policy scope verification.
    policy_source_records = [s for s in sources if s.get("source_id") in set(policy.get("source_ids", []))]
    policy_scope_verified = (
        policy.get("scope_verified") is True
        and bool(str(policy.get("official_wording", "")).strip())
        and bool(str(policy.get("issuing_body", "")).strip())
        and bool(str(policy.get("current_status", "")).strip())
        and any(s in official_policy_sources for s in policy_source_records)
        and all(b.get("resolution_status") == "resolved" for b in policy.get("boundary_conflicts", []))
    )
    check("RG-POLICY-SCOPE", policy_scope_verified, "Policy wording, issuing body, status, dates, and boundary are verified", "Policy scope is unverified, lacks an official source, or has an unresolved boundary conflict", policy.get("source_ids", []))

    # Claims: current/future facts require primary sources; secondary sources cannot support critical claims.
    source_by_id = {str(s.get("source_id")): s for s in sources}
    critical_claims = [c for c in claims if c.get("critical") is True]
    verified_critical = [c for c in critical_claims if c.get("verification_status") == "verified"]
    current_primary_ok = True
    secondary_critical_violations: list[str] = []
    for c in claims:
        claim_sources = [source_by_id.get(str(sid)) for sid in c.get("source_ids", [])]
        claim_sources = [s for s in claim_sources if s]
        requires_primary = (
            c.get("primary_source_required") is True
            or c.get("temporal_status") in {"current", "future_effective"}
        )
        if requires_primary and not any(s.get("primary_source") is True and s.get("verification_status") in VERIFIED for s in claim_sources):
            current_primary_ok = False
        if c.get("critical") is True and any(s.get("source_type") == "secondary_discovery" for s in claim_sources):
            if not any(s.get("primary_source") is True and s.get("verification_status") == "verified" for s in claim_sources):
                secondary_critical_violations.append(str(c.get("claim_id")))
    check("RG-CURRENT-PRIMARY", current_primary_ok, "All current/future or primary-required claims have verified primary sources", "A current/future or primary-required claim lacks a verified primary source")
    check("RG-SECONDARY-BOUNDARY", not secondary_critical_violations, "Secondary sources remain discovery-only for critical claims", "Critical claims rely only on secondary discovery sources: " + ", ".join(secondary_critical_violations))
    critical_ok = len(critical_claims) > 0 and len(verified_critical) == len(critical_claims)
    check("RG-CRITICAL-CLAIMS", critical_ok, f"All critical claims are verified ({len(verified_critical)})", "One or more critical claims are unresolved, rejected, or only caveated", [c.get("claim_id", "") for c in critical_claims])

    # Critical research questions.
    resolution_by_q = {str(r.get("question_id")): r for r in resolutions}
    critical_questions = [q for q in questions if q.get("critical") is True]
    critical_questions_ok = all(
        resolution_by_q.get(str(q.get("question_id")), {}).get("status") == "resolved"
        and bool(resolution_by_q.get(str(q.get("question_id")), {}).get("source_ids"))
        for q in critical_questions
    )
    check("RG-QUESTIONS", critical_questions_ok, "All critical research questions are resolved with source bindings", "A critical research question is unresolved or lacks sources", [q.get("question_id", "") for q in critical_questions])

    # Standards: every report row must be explicitly verified by name/version and official source.
    report_standards = report.get("standards", [])
    ver_by_name: dict[str, list[dict[str, Any]]] = {}
    for sv in standards_ver:
        ver_by_name.setdefault(str(sv.get("standard_name", "")), []).append(sv)
    standards_ok = True
    standards_fail: list[str] = []
    for standard in report_standards:
        name = str(standard.get("name", ""))
        candidates = ver_by_name.get(name, [])
        match = next((sv for sv in candidates if sv.get("version_match") is True and sv.get("official_source") is True and sv.get("verification_status") == "verified"), None)
        if not match:
            standards_ok = False
            standards_fail.append(name)
            continue
        report_refs = {str(x) for x in standard.get("source_refs", []) if str(x).startswith(("P", "S"))}
        bound_refs = {str(x) for x in match.get("report_source_ids", [])}
        if not report_refs.intersection(bound_refs):
            standards_ok = False
            standards_fail.append(name + " (source binding)")
    check("RG-STANDARD-VERSIONS", standards_ok and len(report_standards) > 0, f"All report standards have official version bindings ({len(report_standards)})", "Unverified/mismatched report standards: " + ", ".join(standards_fail[:12]))

    # Cross-check report source appendix with ledger for all external P/S/R records.
    report_external = [s for s in report.get("sources", []) if re.match(r"^[PSR][0-9]+$", str(s.get("id", "")))]
    ledger_report_map = {str(s.get("report_source_id", "")): s for s in sources}
    report_refs_ok = True
    report_refs_fail: list[str] = []
    for rs in report_external:
        rid = str(rs.get("id", ""))
        ls = ledger_report_map.get(rid)
        if not ls:
            report_refs_ok = False
            report_refs_fail.append(rid + " missing")
            continue
        if ls.get("verification_status") in {"unresolved", "rejected"}:
            report_refs_ok = False
            report_refs_fail.append(rid + " unverified")
        if rid.startswith(("P", "S")) and not (ls.get("primary_source") is True and ls.get("official_domain") is True):
            report_refs_ok = False
            report_refs_fail.append(rid + " not primary/official")
    check("RG-REPORT-SOURCE-CROSSWALK", report_refs_ok, f"All report external-source IDs resolve to verified ledger entries ({len(report_external)})", "Report/ledger source crosswalk failed: " + ", ".join(report_refs_fail[:12]), [s.get("id", "") for s in report_external])

    # Conflicts must be resolved before report generation.
    all_conflicts = list(conflicts)
    for b in policy.get("boundary_conflicts", []):
        all_conflicts.append({"type": "policy_scope", **b})
    unresolved = [c for c in all_conflicts if c.get("resolution_status") != "resolved"]
    unresolved_date = len([c for c in unresolved if c.get("type") == "policy_date"])
    unresolved_version = len([c for c in unresolved if c.get("type") == "standard_version"])
    unresolved_scope = len([c for c in unresolved if c.get("type") == "policy_scope"])
    conflict_ok = not unresolved
    check("RG-CONFLICTS", conflict_ok, f"All recorded conflicts are resolved ({len(all_conflicts)})", "Unresolved source/date/version/scope conflicts remain: " + ", ".join(str(c.get("conflict_id", c.get("description", "conflict"))) for c in unresolved[:12]))

    conditions = {
        "web_research_executed": web_executed,
        "official_policy_source_found": policy_found,
        "policy_scope_verified": policy_scope_verified,
        "selected_sources_opened": all_selected_opened,
        "search_snippets_not_used_as_evidence": snippet_free,
        "all_current_facts_have_primary_sources": current_primary_ok and not secondary_critical_violations,
        "all_standard_versions_verified": standards_ok and len(report_standards) > 0,
        "all_source_refs_resolvable": refs_ok and report_refs_ok,
        "all_critical_questions_resolved": critical_questions_ok,
        "unresolved_date_conflicts": unresolved_date,
        "unresolved_standard_version_conflicts": unresolved_version,
        "unresolved_scope_conflicts": unresolved_scope,
    }

    metrics = {
        "queries_executed": len(queries),
        "opened_sources": len(opened_sources),
        "verified_primary_sources": len(verified_primary),
        "official_policy_sources": len(official_policy_sources),
        "official_standard_sources": len(official_standard_sources),
        "critical_claims": len(critical_claims),
        "verified_critical_claims": len(verified_critical),
        "report_external_sources": len(report_external),
        "resolved_conflicts": len([c for c in all_conflicts if c.get("resolution_status") == "resolved"]),
        "unresolved_conflicts": len(unresolved),
    }

    gate_status = "passed" if not blockers and (not args.strict or not warnings) else "failed"
    gate = {
        "gate_id": "RG-" + re.sub(r"[^A-Za-z0-9_-]+", "-", str(plan.get("task_id", "TASK"))).strip("-"),
        "skill_id": "ontology-analysis-skill",
        "skill_version": "0.1.0",
        "plan_id": str(plan.get("plan_id", "")),
        "ledger_id": str(ledger.get("ledger_id", "")),
        "research_date": str(plan.get("research_date", "")),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "gate_status": gate_status,
        "conditions": conditions,
        "metrics": metrics,
        "checks": checks,
        "blockers": blockers,
        "warnings": warnings,
        "hashes": {
            "plan_sha256": sha256_file(plan_path),
            "ledger_sha256": sha256_file(ledger_path),
            "report_data_sha256": sha256_file(report_path),
        },
        "promotion_ceiling": "staged",
        "production_release_allowed": False,
    }

    # Validate the computed gate itself.
    gate_errors = schema_errors(gate, ROOT / "schemas/research-gate.schema.json")
    if gate_errors:
        gate["gate_status"] = "failed"
        gate["blockers"].append("RG-GATE-SCHEMA: " + "; ".join(gate_errors[:8]))
        gate["checks"].append({
            "check_id": "RG-GATE-SCHEMA",
            "status": "failed",
            "message": "; ".join(gate_errors[:8]),
            "evidence_refs": [str(ROOT / "schemas/research-gate.schema.json")],
        })

    score = max(0.0, 100.0 - 8.0 * len(gate["blockers"]) - 1.5 * len(gate["warnings"]))
    validation = {
        "status": gate["gate_status"],
        "strict": args.strict,
        "research_mode": mode,
        "plan": str(plan_path),
        "ledger": str(ledger_path),
        "report_data": str(report_path),
        "gate": str(gate_path),
        "metrics": metrics,
        "conditions": conditions,
        "errors": gate["blockers"],
        "warnings": gate["warnings"],
        "checks": gate["checks"],
        "score": round(score, 1),
        "non_claim_note": "A passed gate verifies the evidence bundle's structure, cross-references, source classifications, version bindings, and conflict status. It does not independently certify the truth of external webpages or production readiness.",
    }

    write_json(gate_path, gate)
    write_json(validation_path, validation)
    print(json.dumps(validation, ensure_ascii=False, indent=2))

    if gate["gate_status"] != "passed":
        return 1
    if args.strict and warnings:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
