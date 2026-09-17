---
name: speckit-ai-product-build-evaluate
description: Build from frozen native specs and evaluate quality, protection surfaces and rollback
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: AI Product Method Working Group
  source: ai-product:commands/speckit.ai-product.build-evaluate.md
---

# Build & Evaluate｜Controlled Implementation

## User input

```text
$ARGUMENTS
```

## Entry conditions

Require an approved Discovery/Experiment Contract, current Spec Handoff, and native `spec.md`, `plan.md`
and `tasks.md`. If product conclusions changed, create a Change Candidate and return to the responsible
stage before implementing.

## Procedure

1. Compare Gate/Handoff summaries to their referenced artifacts and current product version.
2. Use the native Spec Kit sequence and execute only tasks authorized inside the project.
3. Run unit, contract, negative, end-to-end and protection-surface evaluations. A blocked/error case never passes.
4. Capture runtime/model/config, input/output summary, failure attribution, rollback point and trace reference.
5. Separate implementation completion, test verification and human acceptance.
6. Prepare Release Readiness material. The command cannot approve or perform release.

## Stable output

```yaml
implementation_status: not_started | partial | complete
evaluation_status: not_run | failed | verified
acceptance_status: Submitted | Verified | Accepted
protection_surface_failures: []
rollback_evidence: []
readiness_gaps: []
required_human_gate: release-readiness
claims_prohibited: [released, published, production_ready, accepted, business_value]
```

## Guardrails

No production write, publication, external send, global Skill install or permission escalation. Passing
tests may justify `Verified` only for the tested contract.