#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SKILL_ID = "ontology-analysis-skill"
SKILL_VERSION = "0.1.0"


def run(cmd: list[Any], allow=(0,)) -> int:
    """Run a command and fail loudly if its return code is not allowed."""
    print("\n$", " ".join(map(str, cmd)), flush=True)
    cp = subprocess.run([str(x) for x in cmd], check=False)
    allowed = allow if isinstance(allow, (tuple, list, set)) else (allow,)
    if cp.returncode not in allowed:
        raise RuntimeError(f"command failed ({cp.returncode}): {cmd}")
    return cp.returncode


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def page_count(render_dir: Path | None) -> int | None:
    if not render_dir:
        return None
    return len(list(render_dir.glob("page-*.png")))


def validate_output_contract(skill_output: dict[str, Any], outdir: Path) -> Path:
    output_contract_report = outdir / "output-contract-validation.json"
    skill_output["audit_refs"].append(str(output_contract_report))
    output_schema = load_json(ROOT / "schemas/schemas.json")["output_schema"]
    output_errors = sorted(
        Draft202012Validator(output_schema).iter_errors(skill_output),
        key=lambda e: list(e.path),
    )
    output_contract = {
        "status": "passed" if not output_errors else "failed",
        "schema": str(ROOT / "schemas/schemas.json") + "#/output_schema",
        "errors": [error.message for error in output_errors],
    }
    write_json(output_contract_report, output_contract)
    if output_errors:
        raise RuntimeError("skill output contract validation failed")
    return output_contract_report


def emit_blocked(
    outdir: Path,
    actions: list[str],
    trace: list[str],
    audit_refs: list[str],
    reason: str,
    failure_code: str,
    research_gate: Path | None = None,
    research_validation: Path | None = None,
) -> None:
    generated_at = dt.datetime.now(dt.timezone.utc).isoformat()
    payload = {
        "actions": actions + ["block_before_word_generation"],
        "result": {
            "status": "blocked",
            "skill_id": SKILL_ID,
            "skill_version": SKILL_VERSION,
            "generated_at": generated_at,
            "failure_code": failure_code,
            "reason": reason,
            "research_gate": str(research_gate) if research_gate else None,
            "research_validation_report": str(research_validation) if research_validation else None,
            "docx": None,
            "production_release_allowed": False,
        },
        "trace": trace + [f"blocked:{failure_code}"],
        "audit_refs": audit_refs,
    }
    validate_output_contract(payload, outdir)
    payload["actions"].append("validate_skill_output_contract")
    payload["trace"].append("output_contract:passed")
    write_json(outdir / "skill-output.json", payload)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=(
            "Run the mandatory web-research gate, validate report data, generate the DOCX, "
            "verify structure, render for QA, and emit a governed skill receipt."
        )
    )
    ap.add_argument("--input", required=True, help="Completed report-data.json")
    ap.add_argument(
        "--research-dir",
        required=True,
        help="Directory containing research-plan.json and web-research-ledger.json",
    )
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--emit-pdf", action=argparse.BooleanOptionalAction, default=True)
    args = ap.parse_args()

    inp = Path(args.input).resolve()
    research_src = Path(args.research_dir).resolve()
    plan_src = research_src / "research-plan.json"
    ledger_src = research_src / "web-research-ledger.json"
    outdir = Path(args.output_dir).resolve()
    outdir.mkdir(parents=True, exist_ok=True)

    actions: list[str] = []
    trace: list[str] = []
    audit_refs: list[str] = []

    if not inp.exists():
        raise FileNotFoundError(f"report-data input not found: {inp}")
    if not plan_src.exists() or not ledger_src.exists():
        missing = [str(p) for p in (plan_src, ledger_src) if not p.exists()]
        emit_blocked(
            outdir,
            actions,
            trace,
            audit_refs,
            "Mandatory research bundle is incomplete: " + ", ".join(missing),
            "RESEARCH_GATE_FAILURE",
        )
        raise RuntimeError("mandatory research bundle missing")

    # 1. Copy and validate the research bundle before any report-data validation or Word generation.
    research_out = outdir / "research"
    research_out.mkdir(parents=True, exist_ok=True)
    plan = research_out / "research-plan.json"
    ledger = research_out / "web-research-ledger.json"
    shutil.copy2(plan_src, plan)
    shutil.copy2(ledger_src, ledger)
    actions.append("copy_mandatory_research_bundle")
    trace.extend([f"research_plan_loaded:{plan_src}", f"research_ledger_loaded:{ledger_src}"])
    audit_refs.extend([str(plan), str(ledger)])

    gate = research_out / "research-gate.json"
    research_validation = research_out / "research-validation-report.json"
    cmd = [
        sys.executable,
        HERE / "validate_research_bundle.py",
        "--plan",
        plan,
        "--ledger",
        ledger,
        "--report-data",
        inp,
        "--gate-out",
        gate,
        "--out",
        research_validation,
    ]
    if args.strict:
        cmd.append("--strict")
    rc = run(cmd, allow=(0, 1, 3))
    actions.append("compute_and_validate_mandatory_research_gate")
    audit_refs.extend([str(gate), str(research_validation)])
    gate_data = load_json(gate) if gate.exists() else {}
    research_result = load_json(research_validation) if research_validation.exists() else {}
    trace.append(
        f"research_gate:{gate_data.get('gate_status')}:{research_result.get('score')}"
    )
    if rc != 0 or gate_data.get("gate_status") != "passed":
        emit_blocked(
            outdir,
            actions,
            trace,
            audit_refs,
            "Mandatory web-research/source-verification gate failed; DOCX generation was not started.",
            "RESEARCH_GATE_FAILURE",
            gate,
            research_validation,
        )
        raise RuntimeError("mandatory research gate failed")

    # 2. Inject the computed research-assurance summary into a copied report-data bundle.
    data = load_json(inp)
    metrics = gate_data.get("metrics", {})
    data["research_assurance"] = {
        "gate_status": "passed",
        "research_plan_id": gate_data.get("plan_id", ""),
        "research_ledger_id": gate_data.get("ledger_id", ""),
        "research_date": gate_data.get("research_date", ""),
        "queries_executed": int(metrics.get("queries_executed", 0)),
        "opened_sources": int(metrics.get("opened_sources", 0)),
        "verified_primary_sources": int(metrics.get("verified_primary_sources", 0)),
        "official_policy_sources": int(metrics.get("official_policy_sources", 0)),
        "official_standard_sources": int(metrics.get("official_standard_sources", 0)),
        "unresolved_conflicts": int(metrics.get("unresolved_conflicts", 0)),
        "gate_report_ref": "research/research-gate.json",
        "notes": (
            "强制研究门禁已通过：已记录检索查询、打开并阅读来源、绑定一手证据、核验政策与标准版本，"
            "并检查跨引用与冲突状态。该结果仅证明研究制品满足本 Skill 的机器门禁，"
            "不构成外部认证、专业定稿或生产发布批准。"
        ),
    }
    copied = outdir / "report-data.validated.json"
    write_json(copied, data)
    actions.append("inject_research_assurance_and_prepare_report_data")
    trace.append(f"report_data_prepared:{copied}")

    # 3. Validate the ontology/report bundle only after research gate pass.
    validation = outdir / "validation-report.json"
    cmd = [
        sys.executable,
        HERE / "validate_report_data.py",
        copied,
        "--schema",
        ROOT / "schemas/report-data.schema.json",
        "--out",
        validation,
    ]
    if args.strict:
        cmd.append("--strict")
    run(cmd, allow=(0, 3))
    val = load_json(validation)
    actions.append("validate_report_data")
    trace.append(f"validation:{val.get('status')}:{val.get('score')}")
    audit_refs.append(str(validation))
    if val.get("status") != "passed":
        raise RuntimeError("report-data validation failed")
    if args.strict and val.get("warnings"):
        raise RuntimeError("strict mode: report-data warnings must be resolved before generation")

    # 4. Generate and structurally verify the full Word report.
    filename = data["meta"].get("output_filename") or (
        f"{data['meta']['volume_number']}_{data['meta']['domain_name_cn']}_Ontology分析与对标.docx"
    )
    docx = outdir / filename
    run([sys.executable, HERE / "build_docx.py", copied, docx])
    actions.append("generate_full_word_report")
    trace.append(f"docx_generated:{docx.name}")

    verification = outdir / "verification-report.json"
    run([sys.executable, HERE / "inspect_docx.py", docx, "--data", copied, "--out", verification])
    ver = load_json(verification)
    actions.append("verify_docx_structure")
    trace.append(f"verification:{ver.get('status')}:{ver.get('score')}")
    audit_refs.append(str(verification))
    if ver.get("status") != "passed":
        raise RuntimeError("DOCX structural verification failed")

    # 5. Render and accessibility-audit when requested. Visual QA remains a separate human/reviewer gate.
    render_dir: Path | None = None
    a11y_path: Path | None = None
    a11y: dict[str, Any] | None = None
    if args.render:
        render_dir = outdir / "render"
        render_dir.mkdir(exist_ok=True)
        cmd = [sys.executable, HERE / "render_docx_local.py", docx, "--output-dir", render_dir]
        if args.emit_pdf:
            cmd.append("--emit-pdf")
        run(cmd)
        actions.append("render_docx_for_page_qa")
        trace.append(f"rendered_pages:{page_count(render_dir)}")
        audit_refs.append(str(render_dir))

        audit = Path("/home/oai/skills/docx/scripts/a11y_audit.py")
        if audit.exists():
            a11y_path = outdir / "a11y-report.json"
            run([sys.executable, audit, docx, "--out_json", a11y_path])
            a11y = load_json(a11y_path)
            actions.append("run_accessibility_audit")
            trace.append(f"a11y:{a11y.get('counts')}")
            audit_refs.append(str(a11y_path))
            counts = a11y.get("counts", {})
            if any(int(counts.get(k, 0)) > 0 for k in ("high", "medium", "low")):
                raise RuntimeError("accessibility audit reported findings")

    generated_at = dt.datetime.now(dt.timezone.utc).isoformat()
    manifest = {
        "skill_id": SKILL_ID,
        "version": SKILL_VERSION,
        "status": "staged",
        "generated_at": generated_at,
        "input": str(inp),
        "research_plan": str(plan),
        "web_research_ledger": str(ledger),
        "research_gate": str(gate),
        "research_validation": str(research_validation),
        "report_data": str(copied),
        "docx": str(docx),
        "validation": str(validation),
        "verification": str(verification),
        "render_dir": str(render_dir) if render_dir else None,
        "page_count": page_count(render_dir),
        "a11y": str(a11y_path) if a11y_path else None,
        "visual_qa": {"status": "required" if render_dir else "not_available", "receipt": None},
        "production_release_allowed": False,
        "note": (
            "Mandatory research gate and automated DOCX toolchain passed. Page-by-page visual review "
            "is a separate mandatory reviewer gate; staged is not production release."
        ),
    }
    manifest_path = outdir / "run-manifest.json"
    write_json(manifest_path, manifest)
    audit_refs.append(str(manifest_path))

    skill_output = {
        "actions": actions,
        "result": {
            "status": "staged",
            "skill_id": SKILL_ID,
            "skill_version": SKILL_VERSION,
            "generated_at": generated_at,
            "research_gate": str(gate),
            "research_gate_status": gate_data.get("gate_status"),
            "research_validation_report": str(research_validation),
            "docx": str(docx),
            "validated_report_data": str(copied),
            "validation_report": str(validation),
            "verification_report": str(verification),
            "render_dir": str(render_dir) if render_dir else None,
            "page_count": page_count(render_dir),
            "accessibility_report": str(a11y_path) if a11y_path else None,
            "accessibility_counts": a11y.get("counts") if a11y else None,
            "visual_qa": {"status": "required" if render_dir else "not_available", "receipt": None},
            "production_release_allowed": False,
            "completion_note": (
                "The mandatory web-research gate and DOCX toolchain completed. The report remains "
                "staged until every rendered page is inspected and a visual-QA receipt is recorded."
            ),
        },
        "trace": trace,
        "audit_refs": audit_refs,
    }
    validate_output_contract(skill_output, outdir)
    skill_output["actions"].append("validate_skill_output_contract")
    skill_output["trace"].append("output_contract:passed")
    write_json(outdir / "skill-output.json", skill_output)

    print(json.dumps(skill_output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"PIPELINE FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
