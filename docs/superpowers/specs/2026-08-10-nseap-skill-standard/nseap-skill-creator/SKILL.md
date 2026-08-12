---
name: nseap-skill-creator
description: >-
  Create a NEW skill that conforms to the whole NSEAP product system — not just the Skill
  standard (nine elements, three-tier, dual schema, runtime_contracts, non-claims) but also its
  system placement: two-class classification (EndUse vs ProductionProcess), the four orthogonal
  axes (Skill-L / Asset-L / session_role / form), the KSTAR evolution discipline, K = ontology +
  skill + meta-skill, and Team A-F ownership boundaries. Use whenever the user wants to create,
  scaffold, author, or package a Skill / agent capability / SkillPackage / "skill for X" — even
  phrased as "make a skill for refunds" or "turn this SOP into a skill". Produces a staged-capped,
  auditable, product-system-conformant skill, usable with Claude alone — no engine required.
---

# NSEAP Skill Creator (product-system conformant)

Turn a domain description into a **new SkillPackage that fits the NSEAP product system**. A Skill
is an auditable capability (`ontology slice + workflow + tool binding + eval + KSTAR hooks +
governance`), not a prompt. Output is always **`staged`** (`production_release_allowed: false`).
Claude-only — no Python engine.

**Honest boundary (keep it in the output):** this scaffolds product-system-conformant *structure*
to staged. It does NOT run the real KSTAR loop (ΔR/ΔA, reflect→distill→gates — needs the
`metaskill` engine), does NOT publish/deploy, does NOT access real resources/identity (Agent
layer injects those). Never claim "learned", "production-ready", or Tier C.

## Step 0 — Place it in the product system (this is what makes it "conformant")

Classify and position before scaffolding:

- **用途二分 (skill_class)**: **EndUseSkill** (business output — e.g. refund handling, contract
  review) or **ProductionProcessSkill** (makes/validates/governs skills — e.g. an eval
  synthesizer). ProductionProcess skills map to a seat on the 16-step assembly line
  (`situation→ontology→skill→eval→factory→runtime→KSTAR→replay→staged`).
- **Four orthogonal axes**:
  - **Skill-L 0..5** — capability/risk grade (a real governed skill is L5).
  - **Asset-L 0..5** — cognitive-asset maturity (static file → … → Evolutionary Cell).
  - **session_role** — `master_task_skill` (session entry, `owns_session: true`, one per session)
    vs `sub_skill` (default). One-Session → One-Master → Many-Sub.
  - **form** — `interpreted` (default) vs `compiled` (packaged-to-staged snapshot).
- **K = ontology + skill + meta-skill**: the skill carries its ontology slice (K_skill). A
  *meta-skill* (a skill that makes skills) also carries a K_meta playbook and **is-a SkillPackage**
  (it obeys this same standard — no exemption).
- **Position**: it is a **Skill Layer** artifact that the upper Task Agent runtime (E0) consumes.
- **Team A-F ownership**: the skill only **exposes contract field-positions**. Real ontology
  authority (D), runtime/trace/gateway (C), owner binding/resource access (A/C/F), release (F) are
  other layers — the skill never does their work.

State the classification in the output (e.g. "EndUseSkill · Skill-L5 · Asset-L2 · sub_skill ·
interpreted").

## Step 1 — Capture the domain (only place domain content lives)

`domain` slug, a 1–3 sentence `narrative` (what it does + business rules), `entities` (nouns +
fields), `rules` (conditions, thresholds, which actions need HITL).

## Step 2 — Scaffold (nine elements + schemas + ontology slice)

### Nine-element contract (every L3+ Skill)
1. **Trigger semantics** — `use_when` **and** anti-trigger (`do_not_use_when`/`negative_examples`)
   + `positive_examples`. Anti-trigger is a hard requirement.
2. **Business-context mapping** — relevant TBox + applicable RBox + current ABox.
3. **Executable workflow** — state machine with `preview`/`confirm` before any `execute`.
4. **Tool/resource binding** — the `runtime_contracts` below.
5. **Validation contract** — ontology refs + boundary tests + HITL-for-high-risk.
6. **Eval/replay/regression** — forecast → actual → delta + replay set.
7. **Failure attribution** — which layer a failure maps to (TBox/RBox/Skill/Tool/…).
8. **KSTAR evolution hook** — see the discipline below.
9. **Governance boundaries** — non-claims + `promotion_ceiling: staged`.

### KSTAR discipline (element 8, first-class in the product system)
The evolution hook follows: `K/S/T → Â/R̂ → A/R → ΔA/ΔR → learning_hypothesis → candidate →
bounded patch → three gates (Validation→Governance→Release) → K update`.
- **ΔR = R − R̂** is the learning signal (a positive ΔR ≠ a release instruction).
- **ΔA gates ΔR**: if the executed action ≠ the intended one (ΔA ≠ 0), distrust ΔR — don't learn
  from it.
- **Bounded patch**: updates are size-limited (`edit_budget`) and must pass all three gates.
- **Symbolic decides right/wrong** (structure, well-formedness); **neural only proposes DRAFT
  wording** — never writes `formal`/`config_key`/`value`.
- The scaffold *declares* these hooks; the *real* loop runs in the `metaskill` engine.

### Schemas (copy-paste; `<primary>` = main entity, lowercased)

**input_schema** — three-layer; `owner_context` is a field-position you expose, values injected by
the Agent layer:
```json
{ "type":"object","required":["task_id","owner_context","<primary>_payload"],
  "properties":{ "task_id":{"type":"string"},
    "owner_context":{"type":"object","required":["owner_id","role","authorization_scope"],
      "properties":{"owner_id":{"type":"string"},"role":{"type":"string"},
                    "authorization_scope":{"type":"array","items":{"type":"string"}}}},
    "<primary>_payload":{"type":"object","required":["<field>"],"properties":{"<field>":{"type":"number"}}}}}
```
**output_schema** (`audit_refs` required):
```json
{ "type":"object","required":["actions","result","trace","audit_refs"],
  "properties":{"actions":{"type":"array","items":{"type":"string"}},"result":{"type":"number"},
    "trace":{"type":"array","items":{"type":"string"}},"audit_refs":{"type":"array","items":{"type":"string"}}}}
```
**runtime_contracts** — expose field-positions + fixed boundary guards (skill never accesses
resources, resolves identity, or holds tokens):
```json
{ "resource":{"resource_requirements":[{"resource_type":"<primary>","operation":"read","purpose":"ontology_grounded_read","min_scope":true}],
    "access_via_gateway_only":true,"direct_resource_access":false},
  "permission":{"permissions":[{"action":"execute","permission_level":"write","hitl_required":true}]},
  "owner_binding":{"required_owner_sections":["role","authorization_scope"],
    "owner_context_ref":"input_schema.owner_context","binding_resolved_by":"agent_layer"},
  "audit":{"audit_refs_field":"output_schema.audit_refs","emitted_by":"runtime","append_only":true} }
```
Boundary invariants (never change): `direct_resource_access=false`, `access_via_gateway_only=true`,
`binding_resolved_by="agent_layer"`, `emitted_by="runtime"`.

**Ontology slice** (rules structured; `formal` is human-only, never machine-parsed):
```yaml
tbox: { <Entity>: [<field_a>, <field_b>] }
rbox: [ { rule_id: R1, formal: "<human rule>", field: <field_a>, op: le, value: 300, action: null } ]
abox: {}
source_refs: ["materials::<domain>::snapshot"]     # platform ontology-registry binding is target-state
```
**skill-spec identity** (carries the classification + axes):
```yaml
skill_spec: { standard_id: nseap-skill-creator, skill_class: execution, level: L5, risk_route: Full,
  promotion_ceiling: staged, production_release_allowed: false,
  session_role: sub_skill, owns_session: false, form: interpreted, asset_level: L2 }
```

## Step 3 — Three-tier compliance + self-check (say which tier + be honest)

| Tier | Satisfies | Who |
|---|---|---|
| **A minimal** | 5 well-formed sections + non-empty ontology slice | scaffold auto |
| **B registry-ready** | A + trigger/anti-trigger + non-empty dual schema + runtime_contracts guards + 16 artifacts | author fills 5 ★ |
| **C release** | B + G0–G12 governance | governance/release — **out of scope, never claim** |

**5 ★ files the author writes** (rest templated): `SKILL.md` (business + trigger) · `evals/evals.json`
+ eval-cases (real ±examples) · `skill-spec.yaml` (confirm defaults) · `input-contract.md`
(field meanings) · `validation-contract.md` (boundary tests + HITL).

**Self-check**: product-system placement stated (用途/四轴/K) · nine elements present · input
three-layer with `owner_context.required=[owner_id,role,authorization_scope]` · output has
`audit_refs` · runtime_contracts guards set · ontology slice + `source_refs` · KSTAR hook declared ·
staged caps · non-claims block · trigger + anti-trigger + ±examples.

## Non-claims (never violate)
- `promotion_ceiling: staged`, `production_release_allowed: false` everywhere — staged only.
- Exposes contract field-positions; does not send/deploy, access real resources, or resolve
  identity (`binding_resolved_by: agent_layer`).
- Symbolic decides right/wrong; neural (LLM) only proposes DRAFT wording.

**Honest layering — label these as target-state, never "done":** owner_context/contract *values*
(injected by Agent layer), platform ontology-registry binding (waits on the schema-authority
decision), `compiled` form + real KSTAR run (need the `metaskill` engine). The scaffold is real
structure to staged; these are hooks, not runs.
