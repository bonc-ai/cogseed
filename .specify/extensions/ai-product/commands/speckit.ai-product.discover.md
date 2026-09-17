---
description: "Build an evidence-bound user journey, needs, contradictions and hypotheses"
---

# Discover｜User Evidence and Journey

## User input

```text
$ARGUMENTS
```

## Entry conditions

Use when value or experience uncertainty remains, or when user research/journey evidence must be
collected. Competitor pages, internal opinions and synthetic personas are not user evidence.

## Procedure

1. Freeze the research question, participant/sample boundary and evidence source types before analysis.
2. Extract facts, direct quotes/self-reports, stakeholder views and analyst interpretations separately.
3. Build the journey as trigger → action → obstacle → workaround → result. Include failure, refusal and
   abandonment, not only the happy path.
4. Bind every insight to Evidence IDs and record counter-evidence plus `does_not_prove`.
5. Form falsifiable hypotheses and choose one next contact or validation action.
6. Prepare an Evidence Gate candidate; insufficient evidence returns to research or De-risk.

## Stable output

```yaml
research_question: ""
sample_boundary: ""
evidence_refs: []
journey: []
insights: []
counter_evidence: []
hypotheses: []
primary_uncertainty: value | experience | unknown
unique_next_action: ""
evidence_gate_status: proposed | approved | returned | blocked | rejected
```

## Guardrails

- Label real, desensitized, synthetic and stub material.
- Preserve quotes faithfully and do not turn interpretations into user statements.
- A prototype can establish usability evidence only for the tested scope; it does not prove business value.
- Missing access or tools yields `blocked`, never a fallback to old snapshots or invented participants.
