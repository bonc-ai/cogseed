---
description: "Frame a product opportunity as user, workflow, problem, outcome, constraints and non-goals"
---

# Frame｜Product Opportunity

## User input

```text
$ARGUMENTS
```

## Entry conditions

Use for an unframed zero-to-one opportunity or a material repositioning. If an approved Frame exists
and no new evidence changes it, route to Discover/Qualify instead of rewriting it.

## Procedure

1. Identify the target user and the current workflow trigger, steps, cost and alternative behavior.
2. Separate sourced facts from stakeholder interpretation and hypotheses. An idea without user evidence
   remains a hypothesis; do not assign a fictitious evidence grade.
3. Write a falsifiable problem statement and measurable desired outcome without choosing a UI or model.
4. List non-goals, data/authority constraints, affected stakeholders and the smallest evidence gaps.
5. Prepare a Frame Gate candidate. Missing Owner, date or reason keeps it `proposed`.

## Stable output

- `problem_statement`
- `target_user_and_workflow`
- `target_outcome`
- `constraints`
- `non_goals`
- `facts / stakeholder_views / hypotheses / unknowns`
- `evidence_refs`
- `unique_next_action`
- `frame_gate_status`
- `claims_allowed / claims_prohibited`

## Exit rule

Only a human-approved Frame Gate allows the conclusion to be treated as frozen. The next recommended
stage is Discover unless current evidence already satisfies the Evidence Gate.

## Guardrails

Do not design pages, select a model, promise scope, assign owners or write dates without evidence. Work
only inside the project when the user asks to save a candidate.
