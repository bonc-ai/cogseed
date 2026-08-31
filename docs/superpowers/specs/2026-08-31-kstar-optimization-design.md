# KSTAR Optimization Design

## Goal

Implement the first production-oriented KSTAR optimization wave on the local integration branch before any remote push. The wave covers explicit lifecycle guards, distinct timeout semantics, security-boundary regression coverage, an Electron smoke path, measurable Forecast and Episode records, cross-task candidate validation, and consistent `abandon` handling.

## Scope

- O1: explicit Task, Requirement, Episode, and Review transition guards with audit metadata.
- O2: represent timeout separately from ordinary failure and cancellation.
- O3: test owner isolation, path safety, invalid inputs, and duplicate terminal events.
- O4: exercise the real Electron startup path and the KSTAR happy/error paths where the existing smoke harness permits.
- O5: add backward-compatible Forecast confidence, risk, freshness, and creation metadata.
- O6: add backward-compatible Episode execution measurements.
- O7: persist candidate validation counters and failure tracking using existing JSON storage and migration conventions.
- O9: use `abandon` for user-driven cancellation while preserving compatibility with existing cancelled records.

O8 and O10-O13 remain separate follow-up work because they require broader data-model, product-policy, or operational decisions.

## Architecture

`state-machine.ts` will be a pure feature-layer module. Each transition table is explicit and `assertTransition` fails closed. Existing feature services remain responsible for workflow decisions; they call the guard immediately before persistence. Audit fields are added only where an existing receipt or lifecycle record already carries the operation context.

Timeout classification will happen at the KSTAR boundary that already interprets Runtime terminal events. Existing stored records remain readable: new fields are optional on read and populated for new writes. A timeout will not create a strong learning candidate by default.

Renderer code will not gain direct KSTAR storage access. Security tests will verify the Main-side owner/path checks and IPC contract. Smoke verification will use the existing launcher and test fixtures, without introducing a second Electron process entry point.

## Testing

Each behavior is added test-first and run in a focused test file before implementation. The final gate is:

```text
npm run typecheck
npm test
scripts/restart-cogseed.sh
```

The existing baseline test failures are recorded separately from regressions introduced by this wave. The final report will include exact pass/fail counts and any environment-only failures.

## Non-goals

- No new npm dependency or database.
- No direct push to `develop`.
- No reintroduction of `kstar_control` into the Commander tool surface.
- No Renderer-side authorization or KSTAR business semantics.
