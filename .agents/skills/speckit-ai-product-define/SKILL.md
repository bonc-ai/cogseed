---
name: speckit-ai-product-define
description: Define product objects, states, acceptance and a traceable handoff to native speckit.specify
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: AI Product Method Working Group
  source: ai-product:commands/speckit.ai-product.define.md
---

# Define｜Objects, States and Spec Handoff

## User input

```text
$ARGUMENTS
```

## Entry conditions

An approved/effective Frame, sufficient Evidence, an AI Fit & Authority result, and resolved primary
journey are required. If a key journey remains untested, return to De-risk.

## Procedure

1. Extract product objects, owners, relationships and stable IDs.
2. Define legal states and transitions, including success, failure, refusal, empty, no-permission and rollback.
3. Bind each requirement to Evidence, Decision, object/state and measurable acceptance criterion.
4. Freeze evaluation inputs, thresholds, protection surfaces, blocked/error handling and stop conditions.
5. Create a Spec Handoff candidate. Set `ready_for_speckit: true` only when Discovery Gate is approved,
   Authority Grant is valid and blocking gaps are empty.
6. Hand off to the **native** `speckit.specify`; do not implement a replacement specification command.

## Stable output

- object model and state machine
- requirements and acceptance contract
- evaluation/protection-surface contract
- unresolved assumptions and blocking gaps
- Spec Handoff record with `next_command: speckit.specify`
- Experiment Contract Gate request

## Guardrails

A PRD, prototype or handoff is Submitted evidence, not an Owner decision. Do not mark `approved`,
`Accepted` or `release_ready` without the corresponding human record.