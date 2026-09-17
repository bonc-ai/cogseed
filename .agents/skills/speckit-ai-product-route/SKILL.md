---
name: speckit-ai-product-route
description: Select one primary uncertainty, current stage, next action and human gate
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: AI Product Method Working Group
  source: ai-product:commands/speckit.ai-product.route.md
---

# Route AI Product Work

## User input

```text
$ARGUMENTS
```

## Purpose

Route a `zero_to_one`, `iteration` or `diagnosis` request to exactly one next method stage. Do not
solve the product problem, create a prototype or start implementation in this command.

## Procedure

1. Read project-local `.ai-product/` context when present: product version, current Gate, Evidence,
   Handoff and Change Candidates. Treat summaries as locators, not replacements for primary sources.
2. Separate facts, direct quote/self-report, stakeholder view, hypothesis, proposal, decision and unknown.
3. Select exactly one primary uncertainty:

   | Value | Route |
   |---|---|
   | `value` | user research or Wizard of Oz → `discover` |
   | `experience` | lowest-cost journey prototype → `derisk` |
   | `ai-capability` | frozen golden set and offline Eval → `derisk` |
   | `integration` | Technical Spike → `derisk` |
   | `governance` | data/authority/audit exercise → `qualify` |
   | `clear` | complete handoff → native `speckit.specify` |
   | `unknown` | identify the smallest evidence gap; do not guess |

4. Check prerequisite Gate status. Discussion, a file, a prototype or a passing test is not approval.
5. Return one next action and one required human Gate. If two uncertainties appear equal, ask one
   upstream decision question and stop.

## Stable output

```yaml
entry_mode: zero_to_one | iteration | diagnosis
current_stage: orchestrate | frame | discover | qualify | define | derisk | spec-kit | build-evaluate | launch-learn
primary_uncertainty: value | experience | ai-capability | integration | governance | clear | unknown
evidence_refs: []
decision_refs: []
selected_command: speckit.ai-product.<stage> | speckit.specify | null
next_action: "one concrete action"
required_human_gate: "gate name or 状态待确认"
claims_allowed: []
claims_prohibited: [staged, published, production_ready, accepted, business_value]
```

## Guardrails

- Never invent owner, date, evidence, approval, delivery or production status.
- A4 is disabled. Do not send messages, publish, change permissions, move money, export sensitive data
  or execute irreversible actions.
- A frozen product's substantive change becomes a Change Candidate before re-routing.
- Write a route record only when the user explicitly asks; otherwise this command is read-only.