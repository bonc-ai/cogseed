# Tests · v0.1 Candidate

## Passing full pipeline

```bash
bash tests/test_pipeline.sh
```

This runs skill-shape checks, the mandatory synthetic research gate, report validation, DOCX generation, structural verification, rendering and accessibility audit. It cannot truthfully mark visual QA passed; inspect every page PNG and record a separate receipt.

## Required negative regressions

```bash
bash tests/test_research_gate_failures.sh
```

The following bundles must fail before Word generation:

- missing primary policy source;
- unresolved policy-date conflict;
- standard-version mismatch.

Fixtures are synthetic and prove mechanism only.
