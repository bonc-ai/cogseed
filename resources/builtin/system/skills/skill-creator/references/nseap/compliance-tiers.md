# Three-tier compliance + the 5 ★ author files

## The tiers (向上兼容)

- **Tier A — minimal (draft/local).** Five well-formed sections
  (ontology / rules / state_machine / manifest / policy) + a non-empty ontology slice
  (at least one of TBox / RBox / ABox). The scaffold auto-satisfies A.
- **Tier B — registry-ready (staged candidate).** A + trigger/anti-trigger + positive
  and negative examples + **non-empty input/output dual schema** + **runtime_contracts
  boundary guards** + L5/Full profile + the 16 artifacts. The author writes the 5 ★ files.
- **Tier C — 1.0 release.** B + G0–G12 governance evidence + release receipts. **Out of
  scope for this skill** — this is governance/release owners' work. Never claim C.

## The 5 ★ files the author must actually write (everything else is templated)

1. **`SKILL.md`** — the business description + trigger semantics (`use_when` /
   `do_not_use_when` + positive/negative examples). This is the one that makes the skill
   findable and correctly scoped.
2. **`evals/evals.json`** + **`references/eval-cases.yaml`** — the real business test
   cases and the positive/negative examples (what "good" looks like for this domain).
3. **`references/skill-spec.yaml`** — the identity/level/route fields (usually just
   confirm the template defaults).
4. **`references/input-contract.md`** — the business meaning of each input field (what
   `dispute_amount` *means*, its unit, its source).
5. **`references/validation-contract.md`** — the boundary tests + which actions need
   HITL for this domain.

Everything else in the 16-artifact tree (manifest, output-contract, ontology-mapping,
governance-boundaries, kstar-evolution, failure-modes, forecast/outcome/replay/regression
stubs) is templated from Step 1 and needs only light editing.

## Self-check before declaring done

- [ ] Nine-element contract all present (see `nine-elements` in SKILL.md).
- [ ] `input_schema` three-layer with `owner_context.required = [owner_id, role, authorization_scope]`.
- [ ] `output_schema.required` includes `audit_refs`.
- [ ] `runtime_contracts` present with the four boundary guards set correctly.
- [ ] ontology slice has at least one of TBox / RBox / ABox, plus `source_refs`.
- [ ] `promotion_ceiling: staged` and `production_release_allowed: false` everywhere.
- [ ] Non-claims block present (see `references/non-claims.md`).
- [ ] Trigger + anti-trigger + positive/negative examples all filled.

Then state plainly: **"Scaffold reaches Tier B once you fill the 5 ★ files; it is
`staged`-capped; C (release) is governance's job."** Do not overstate.
