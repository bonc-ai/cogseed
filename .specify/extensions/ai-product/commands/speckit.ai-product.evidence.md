---
description: "Create or review a source-bound Evidence record and its claim limits"
---

# Evidence Record

## User input

```text
$ARGUMENTS
```

## Procedure

1. Read the primary source. If unavailable, mark `blocked`; do not rely on a locator, summary or old snapshot.
2. Classify source as real, desensitized, synthetic or stub.
3. Classify claim as fact, user_quote, self_report, stakeholder_view, hypothesis or proposal.
4. Preserve direct wording for quotes and separate analyst interpretation.
5. State both `supports` and `does_not_prove`.
6. Default verification to `Submitted`. Use `Verified` only after the stated check; use `Accepted` only
   with a named human reviewer and compatible source type.
7. Save only on request, under `.ai-product/evidence/EV-*.yml`, never following symlinks outside the project.
8. Validate the saved candidate with the extension record validator.

## Output contract

Use the `ai-product-evidence` template exactly. Never invent observed_at, reviewer, participant, owner,
business result or approval.
