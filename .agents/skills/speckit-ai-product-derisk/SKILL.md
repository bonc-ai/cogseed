---
name: speckit-ai-product-derisk
description: Choose and contract the lowest-cost validation for one primary uncertainty
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: AI Product Method Working Group
  source: ai-product:commands/speckit.ai-product.derisk.md
---

# De-risk｜Lowest-Cost Validation

## User input

```text
$ARGUMENTS
```

## Procedure

1. Name one primary uncertainty and the product decision it blocks.
2. Choose exactly one fit-for-purpose validation vehicle:
   - value → research or Wizard of Oz
   - experience → wireframe/clickable prototype plus target-user tasks
   - ai-capability → frozen representative set, thresholds and offline Eval
   - integration → Technical Spike with failure modes and rollback
   - governance → authority/data/audit exercise
   - clear → no extra experiment; prepare native Spec Kit handoff
3. Before execution, freeze input, success threshold, protection surfaces, failure interpretation, cost,
   timebox and stop condition.
4. Execute only authorized, reversible work. Keep real/desensitized/synthetic/stub results distinct.
5. Compare result with the pre-registered threshold. Blocked/error is not pass.
6. Recommend approve/return/block for Discovery Gate; only a human decides it.

## Stable output

```yaml
primary_uncertainty: ""
blocked_decision: ""
validation_vehicle: ""
experiment_contract: {}
result_status: not_run | passed_threshold | failed_threshold | blocked | error
evidence_refs: []
discovery_recommendation: approve | return | block | 状态待确认
unique_next_action: ""
```

## Guardrails

Do not use a high-fidelity prototype for technical uncertainty, an aggregate score to hide a protection-
surface failure, or synthetic results as customer/production proof.