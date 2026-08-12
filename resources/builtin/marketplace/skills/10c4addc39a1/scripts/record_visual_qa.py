#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any


def page_num(path: Path) -> int:
    match = re.search(r"(\d+)", path.stem)
    return int(match.group(1)) if match else 999999


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="Record mandatory page-by-page visual QA and update governed run receipts.")
    ap.add_argument("--render-dir", required=True)
    ap.add_argument("--reviewer", required=True)
    ap.add_argument("--status", choices=["passed", "failed"], required=True)
    ap.add_argument("--notes", default="")
    ap.add_argument("--out")
    args = ap.parse_args()

    render_dir = Path(args.render_dir).resolve()
    pages = sorted(render_dir.glob("page-*.png"), key=page_num)
    if not pages:
        raise SystemExit("No page-*.png files found")

    receipt = {
        "review_type": "page_by_page_visual_qa",
        "status": args.status,
        "reviewer": args.reviewer,
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "render_dir": str(render_dir),
        "page_count": len(pages),
        "pages_reviewed": [p.name for p in pages],
        "review_statement": (
            "Every rendered page was inspected at 100% zoom."
            if args.status == "passed"
            else "Visual defects remain."
        ),
        "notes": args.notes,
    }
    out = Path(args.out).resolve() if args.out else render_dir / "visual-qa.json"
    write_json(out, receipt)

    run_dir = render_dir.parent
    manifest_path = run_dir / "run-manifest.json"
    if manifest_path.exists():
        manifest = load_json(manifest_path)
        manifest["visual_qa"] = {"status": args.status, "receipt": str(out), "page_count": len(pages)}
        manifest["status"] = "staged" if args.status == "passed" else "blocked"
        manifest["note"] = (
            "Automated checks and mandatory visual QA passed; artifact remains staged and is not production-released."
            if args.status == "passed"
            else "Visual QA failed; artifact is blocked pending layout correction and rerendering."
        )
        write_json(manifest_path, manifest)

    output_path = run_dir / "skill-output.json"
    if output_path.exists():
        skill_output = load_json(output_path)
        result = skill_output.setdefault("result", {})
        result["visual_qa"] = {"status": args.status, "receipt": str(out), "page_count": len(pages)}
        result["status"] = "staged" if args.status == "passed" else "blocked"
        result["completion_note"] = (
            "Automated validation, DOCX verification, accessibility audit, and page-by-page visual QA passed. The artifact remains staged; production release is prohibited."
            if args.status == "passed"
            else "Visual QA failed. Correct the document, regenerate, rerender, and inspect all pages again."
        )
        skill_output.setdefault("actions", []).append("record_page_by_page_visual_qa")
        skill_output.setdefault("trace", []).append(f"visual_qa:{args.status}:{len(pages)}_pages")
        refs = skill_output.setdefault("audit_refs", [])
        if str(out) not in refs:
            refs.append(str(out))
        write_json(output_path, skill_output)

    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
