# NSEAP governance / ontology / eval templates (MANDATORY for every new skill)

## references/governance-boundaries.md

```markdown
# Governance boundaries — <skill-name>

## Promotion & release caps (HARD)
- `promotion_ceiling: staged` — never higher, no automation may lift it.
- `production_release_allowed: false` — production loading requires an independent
  human release decision, out of this skill's scope.

## Non-claims (never violate)
- Does not send / deploy / charge; exposes contract field-positions only.
- Does not resolve identity or access real resources (`binding_resolved_by: agent_layer`).
- Symbolic decides right/wrong; neural only proposes DRAFT wording.
- A passing validation is a staged draft — never a production release.
```

## references/ontology-mapping.md

```markdown
# Ontology slice — <skill-name>

## TBox (concepts + fields)
- <Entity>: [<field_a>, <field_b>]

## RBox (rules, structured: field/op/value + action)
- R1: <field_a> op <value> → <action_or_null>

## ABox (instances)
- (empty at authoring time)

## source_refs
- materials::<domain>::snapshot
```

## references/eval-cases.yaml

```yaml
# Eval cases — <skill-name> (positive / negative examples)
positive:
  - "<real user phrasing 1>"
  - "<real user phrasing 2>"
negative:
  - "<near-miss 1 — must NOT fire>"
  - "<near-miss 2 — must NOT fire>"
```

## references/validation-contract.md

```markdown
# Validation contract — <skill-name>

## Boundary tests
- B1: <input A> → <expected route/decision>
- B2: <input B> → <expected route/decision>

## HITL policy (human-in-the-loop)
- Any `execute` (write) requires `confirm` (HITL) — the workflow gate.
- <high-risk condition> forces human review before execute.

## Invariants
- `ΔA gates ΔR`: if the executed action differs from the intended one, the outcome
  signal is distrusted (not used to learn).
- `staged is not production release`: a passing validation is a staged draft.
```

## references/kstar-evolution.md

```markdown
# KSTAR evolution hook — <skill-name>

## Loop (declared; real run needs the metaskill engine)
K/S/T → Â/R̂ → A/R → ΔA/ΔR → learning_hypothesis → candidate → bounded patch →
three gates (Validation → Governance → Canary) → K update.

## Discipline
- ΔR = R − R̂ is the learning signal; a positive ΔR ≠ a release instruction.
- ΔA gates ΔR: if the executed action ≠ intended (ΔA ≠ 0), distrust ΔR.
- Bounded patch: updates are size-limited and must pass all three gates.
- Symbolic decides right/wrong; neural only proposes DRAFT wording.
```

## evals/evals.json

```json
{
  "schema_version": 1,
  "cases": [],
  "notes": "Author-owned: fill real business test cases (positive/negative/boundary)."
}
```
