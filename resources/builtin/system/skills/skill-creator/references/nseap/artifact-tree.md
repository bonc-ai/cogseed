# The 16-artifact SkillPackage layout

A registry-ready (Tier B) SkillPackage is this tree. ★ = author writes it (see
`compliance-tiers.md`); the rest are templated from the Step-1 domain material.

```
<skill-name>/
├── SKILL.md                              ★  business description + trigger semantics
├── agents/openai.yaml                       tool / agent declaration
├── evals/
│   ├── evals.json                        ★  real business test cases
│   ├── forecast_model.md                    forecast contract stub
│   ├── outcome_evaluation.md                outcome contract stub
│   ├── replay_dataset.md                    replay set stub
│   └── regression_tests.md                  regression stub
└── references/
    ├── skill-spec.yaml                   ★  identity / level / route
    ├── input-contract.md                 ★  business meaning of input fields
    ├── output-contract.md                   output shape
    ├── validation-contract.md            ★  boundary tests + HITL policy
    ├── ontology-mapping.md                  TBox/RBox/ABox ↔ fields + source_refs
    ├── kstar-evolution.md                   KSTAR hook (bounded patch, symbolic-decides)
    ├── governance-boundaries.md             non-claims + promotion cap
    └── eval-cases.yaml                   ★  positive / negative examples
```

That is **16 files** (the 15 above + `input-contract.md` = 16 per the current standard).
`references/failure-modes.md` may be added as a 17th supporting doc.

## Minimum for "usable now"

If the user just wants a quick, correct scaffold, the highest-signal files to get right
are: `SKILL.md` (trigger), `skill-spec.yaml` (identity/caps), the dual schema + ontology
slice (in `ontology-mapping.md`), and `governance-boundaries.md` (non-claims). The eval
files can start as honest stubs the author fills before registry submission.
