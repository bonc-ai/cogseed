# Input Contract · v0.1 Candidate

Top-level required fields are `task_id`, `owner_context`, and `domain_payload`.

`owner_context.required` is exactly `[owner_id, role, authorization_scope]`; values are injected by the Agent layer.

`domain_payload` identifies the volume/domain, research date, official-policy links, supplied materials, `research_bundle_dir`, and output basename. The skill never accepts or stores real credentials.

A complete run requires:

```text
report-data.json
<research_bundle_dir>/research-plan.json
<research_bundle_dir>/web-research-ledger.json
```

The validator computes `research-gate.json`; caller-supplied pass status is not accepted. Report generation is blocked until the gate passes.
