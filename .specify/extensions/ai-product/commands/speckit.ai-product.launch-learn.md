---
description: "Observe authorized real outcomes and create reviewable learning change candidates"
---

# Launch & Learn｜Real Outcomes and Governed Evolution

## User input

```text
$ARGUMENTS
```

## Entry conditions

Require a separate human release/data-access decision for the exact product version and observation
scope. Without it, stop as `blocked`; this command never releases a product.

## Procedure

1. Verify release decision, data boundary, product version and source freshness.
2. Read only approved real sources; do not replace them with synthetic or stale snapshots.
3. Record KSTAR: Situation, Task, predicted Action/Result, actual Action/Result, delta Action/Result.
4. Attribute failures only when evidence supports product, model, prompt, data, tool, permission,
   workflow, schema, governance or evidence; otherwise keep `unknown`.
5. Create a `proposed` Change Candidate. Never directly update a running Skill, prompt, threshold,
   authority grant or method rule.
6. Prepare a Learning & Evolution Gate for the human Owner.

## Stable output

- actual outcomes and source refs
- KSTAR episode with predicted vs actual
- failure attribution or unknown
- proposed Change Candidate
- unique next action and Learning & Evolution Gate
- allowed/prohibited claims

## Guardrails

Synthetic tests are not real learning. Delta is an analysis signal, not a self-modification instruction.
A Change Candidate without human decision remains unapplied.
