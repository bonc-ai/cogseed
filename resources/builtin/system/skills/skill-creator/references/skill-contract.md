# Skill package contract

The single source of truth for what a complete skill package must contain. Read
this before authoring; the requirements below are enforced by the platform's
quality scan and the generation gate, not just by this document.

## 1. Trigger semantics (hard requirement)

In SKILL.md body:

- `use_when` — the situations that must fire this skill.
- `do_not_use_when` / `negative_examples` — the situations that must NOT fire it.
  A skill that cannot say when not to fire is a routing risk and is rejected at
  registration.
- Positive and negative examples, so routing can be tested.

## 2. Input / output contracts (hard requirement)

- `references/input-contract.md` — the input shape. Three layers:
  - `task_id` — task identity.
  - `owner_context` — field-positions the skill declares (`owner_id`, `role`,
    `authorization_scope`); the VALUES are injected by the Agent layer at load
    time. The skill never fills them.
  - `<primary>_payload` — the business payload for the skill's main entity.
- `references/output-contract.md` — the output shape, stable on success and on
  failure, and always including `audit_refs` (the runtime appends audit entries,
  append-only).

## 3. `references/skill-spec.yaml` (hard caps)

Identity / level / route. Two values are ALWAYS fixed:

- `promotion_ceiling: staged` — never higher; no automation may lift it.
- `production_release_allowed: false` — production loading requires an
  independent human release decision.

Capability level by risk: personal / low-risk → L2–L3; shared state, private
data, external actions, or decision-making → **L5**; meta-skills → **L5 always**.

## 4. `references/ontology-mapping.md`

The skill's ontology slice: TBox (concepts + fields), RBox (rules as structured
field/op/value + action), ABox (instances), plus `source_refs`. No ontology slice
→ it is a script, not a skill.

## 5. `references/governance-boundaries.md`

Non-claims block (never sends / deploys / charges; never resolves identity;
never touches real resources directly) plus the staged cap.

## 6. `references/validation-contract.md`

Boundary tests plus the HITL policy: preview → confirm → execute; any write
action requires human confirmation.

## 7. `references/eval-cases.yaml`

Positive / negative example cases used by the router and by regression runs.

## 8. `references/kstar-evolution.md`

Evolution hook declaration: updates are bounded patches; symbolic structure
decides right/wrong; the model only proposes DRAFT wording.

## 9. `evals/evals.json`

Machine-readable eval set. An honest stub (`cases: []` with an author note) is
acceptable at creation time.

## Completeness grades

- **Level A**: well-formed sections + ontology slice. Reachable by filling the
  skeleton templates.
- **Level B**: Level A + trigger/anti-trigger + input/output contracts + staged
  caps + the full artifact set.

The created skill is a **staged candidate**, never a production release. Do not
claim Level C (release) — that is governance work, out of scope.

## Editing / importing existing skills

Source-preserving: do NOT force this full skeleton onto imported skills. Fill
`references/` only where the source already carries the equivalent content.
