# KSTAR Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Implement the confirmed KSTAR optimization wave locally, validate it, and only then push the verified integration branch.

**Architecture:** Keep KSTAR business logic in `src/main/features/kstar`, reuse JSON stores and existing Runtime terminal events, and make lifecycle guards pure and fail-closed. New fields are optional when reading old records and populated on new writes; renderer authorization remains unchanged.

**Tech Stack:** TypeScript, Vitest through `npm test`, Electron smoke launcher, existing JSON persistence and locking helpers.

---

### Task 1: Establish lifecycle guards

**Files:** Create `src/main/features/kstar/state-machine.ts`; modify `src/main/features/kstar/types.ts`, `requirement-types.ts`, `control-service.ts`, `requirement-closure.ts`; test `test/main/features/kstar/state-machine.test.ts` and existing control/closure tests.

- [ ] Write tests proving valid transitions are accepted, closed/abandoned records cannot be reopened or completed, and repeated identical terminal transitions are idempotent.
- [ ] Run focused tests and observe failure because the guard and status are absent.
- [ ] Add explicit transition tables and `assertKstarTransition(kind, from, to)` with a stable invalid-transition error.
- [ ] Route status writes through the guard and preserve old status values when reading records.
- [ ] Run focused KSTAR tests and typecheck.

### Task 2: Add timeout and abandon semantics

**Files:** Modify `src/main/features/kstar/types.ts`, `episode-builder.ts`, `review-inference.ts`, `control-service.ts`; test `test/main/features/kstar/episode-builder.test.ts`, `review-inference.test.ts`, and a new timeout fixture test.

- [ ] Add failing tests for Runtime timeout metadata mapping to KSTAR `timed_out`, no strong precipitation, and user cancellation using `abandon` while old `cancelled` records remain readable.
- [ ] Implement minimal classification and review behavior, without changing Runtime protocol names.
- [ ] Run focused tests and typecheck.

### Task 3: Add KSTAR security boundary regression coverage

**Files:** Create `test/main/features/kstar/kstar-security-boundary.test.ts`; modify only the smallest affected validator if a test exposes a real gap.

- [ ] Test cross-user IDs, `../` and slash IDs, oversized IDs, invalid review verdicts, unauthorized tool references, and duplicate finish/abandon operations.
- [ ] Run the new test independently, then run all KSTAR tests.

### Task 4: Add measurable Forecast and Episode fields

**Files:** Modify `src/main/features/recall/world-model-types.ts`, `world-model.ts`, `world-model-reconciliation.ts`, `src/main/features/kstar/forecast-commit.ts`, `auto-forecast.ts`, `types.ts`, `episode-builder.ts`; test corresponding existing files.

- [ ] Add failing tests for new Forecast metadata and Episode duration/tool/network measurements.
- [ ] Populate fields for new records and tolerate missing fields in old records.
- [ ] Run focused tests and typecheck.

### Task 5: Track candidate validation outcomes

**Files:** Modify `src/main/features/recall/candidate-service.ts`, `direct-experience-assets.ts`, and existing candidate tests.

- [ ] Add failing tests for validation count, last validation timestamp, consecutive failures, and promotion maturity behavior.
- [ ] Persist counters through existing candidate update paths without changing candidate IDs or storage roots.
- [ ] Run focused recall/KSTAR tests.

### Task 6: Electron smoke and full verification

**Files:** Modify or create the existing smoke script only after locating its supported entry point; add tests under `test/main/features/kstar/` as needed.

- [ ] Add a deterministic smoke fixture covering normal completion, abandon, timeout, duplicate terminal events, and restart-read compatibility.
- [ ] Run `npm run typecheck`, `npm test`, `scripts/restart-cogseed.sh`, and the supported smoke command.
- [ ] Separate baseline failures from regressions, commit locally, inspect the diff, and push only the verified branch.

## Verification

Expected final commands are `npm run typecheck`, `npm test`, `scripts/restart-cogseed.sh`, and the KSTAR smoke command. The result must include exact exit codes and pass/fail counts; no remote push occurs before these checks.
