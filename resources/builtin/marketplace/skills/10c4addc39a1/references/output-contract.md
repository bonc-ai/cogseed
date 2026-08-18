# Output Contract · v0.1 Candidate

Required top-level fields: `actions`, `result`, `trace`, `audit_refs`.

`result.status` is `staged`, `blocked`, or `rejected`.

A successful result provides:

- computed research gate and research-validation report;
- DOCX and validated report data;
- report validation and structural verification;
- render directory/page count;
- accessibility report;
- visual-QA status;
- production-release prohibition.

A research-gate failure returns `status=blocked`, `failure_code=RESEARCH_GATE_FAILURE`, research audit references, and no DOCX. Automatic output never exceeds staged.
