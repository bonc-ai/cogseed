---
name: speckit-ai-product-gate
description: Prepare or review a human Gate record without inferring approval
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: AI Product Method Working Group
  source: ai-product:commands/speckit.ai-product.gate.md
---

# Human Gate Decision

## User input

```text
$ARGUMENTS
```

## Procedure

1. Identify the exact Gate and product version; do not substitute another decision target.
2. Read referenced Evidence and current Authority Grant from primary artifacts.
3. Present facts, unresolved assumptions, protection-surface failures and available options.
4. If the human has not explicitly decided, create `status: proposed` with null decision fields.
5. Only explicit human wording can set approved, returned or rejected. Record Owner, Reviewer when
   required, timestamp, reason and Evidence refs exactly; do not infer from silence or discussion.
6. State `claims_allowed` and `claims_prohibited`. Release Readiness approval is not release approval.
7. Save only on request under `.ai-product/gates/` and validate the record.

## Guardrails

- Workflow gates pause the sequence; they do not grant external system permission.
- A3/A4 decisions require the independent authority contract in addition to this record.
- Existing approved records are immutable; supersede them with a new referenced Gate record.