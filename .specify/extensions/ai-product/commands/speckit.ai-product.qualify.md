---
description: "Decide AI suitability, failure cost, data boundary and minimum A0-A4 authority"
---

# Qualify｜AI Fit and Authority

## User input

```text
$ARGUMENTS
```

## This is a formal stage

Run after the user problem has enough evidence and before freezing AI-dependent product behavior. A
current approved Authority Grant may be reused only when scope, data, tools and risk have not changed.

## Procedure

1. Compare manual process, deterministic rules, search/retrieval, generation and agentic execution.
2. State why AI is necessary or choose the non-AI path. Do not add AI for positioning alone.
3. Evaluate error visibility, reversibility, sensitivity, blast radius and failure cost.
4. Define allowed/prohibited data, retention, redaction, third-party and trace boundaries.
5. Assign the minimum authority:
   - A0: read-only observation/summarization
   - A1: draft candidate, human chooses
   - A2: reversible project-local write
   - A3: controlled shared/external write with explicit confirmation, audit and rollback
   - A4: publish, permission, money, sensitive or irreversible action — disabled by default
6. Freeze evaluation obligations and prepare the AI Fit & Authority Gate.

## Stable output

```yaml
ai_fit: suitable | non_ai_preferred | needs_evidence
alternatives_considered: []
failure_cost: low | medium | high | unknown
data_boundary: []
authority_level: A0 | A1 | A2 | A3 | A4
allowed_actions: []
prohibited_actions: []
confirmation_points: []
rollback_plan: null
audit_requirements: []
owner: null
gate_status: proposed
```

## Fail-closed rules

- A4 remains prohibited in this candidate package.
- A3 without Owner, approval time, confirmation, audit and rollback is invalid.
- Convenience never lowers a high-risk classification.
- Do not execute any action while producing the Authority Grant.
