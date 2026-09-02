# 2026-09-01-001-failure-category-boundaries

- status: completed
- date: 2026-09-01
- branch: `feature/spec-workflow-project-memory`
- baseline at start: `develop` @ `71453450`
- baseline at MR: rebased onto `origin/develop` @ `220b5fe5` before opening the MR; no conflicts, all six files replayed intact
- commit: recorded in this branch's history; this record does not restate its own hash
- plan: none — direct work, allowed by `spec-work` step 1.4 for a settled request; no plan was back-filled

## Goal

Pin the full branch and boundary behaviour of `failureCategory`, a pure classifier in
`src/renderer/modules/run-center.js:576` exposed through `window.CogSeedRunCenterAttempts`.

## Verified starting state

`test/renderer/run-center-attempts.test.ts` passed 3/3 before the change. It asserted only
2 of the 5 branches (`provider`, `other`), both piggybacked inside an unrelated test about
attempt selection. `none`, `model` and `collaboration` had no coverage.

## Files changed

- `test/renderer/run-center-attempts.test.ts` — one added `it` block, +25 lines. No source
  file touched; the existing two assertions were left where they are to keep the diff minimal.

## Behaviour pinned

All five branches, plus three boundary classes confirmed by probing the real function first:
falsy inputs (`undefined`, `null`, `''`, `0`, `false`, `NaN`) collapse to `none`; case or
whitespace near-misses (`Provider_Error`, `' provider_error'`) fall to `other`; truthy
non-strings (`42`, `{}`) return `other` instead of throwing.

## Verification

Re-run after the rebase onto `220b5fe5` unless noted; the pre-rebase run on `71453450` gave the
same results for the first four rows.

| Check | Command | Result | Baseline |
| --- | --- | --- | --- |
| target file | `npm run test:js -- test/renderer/run-center-attempts.test.ts` | `passed` 4/4 (was 3/3) | `220b5fe5` |
| typecheck | `npm run typecheck` | `passed`, exit 0 no output | `220b5fe5` |
| run-center suite | `npm run test:js -- test/renderer/run-center` | 29 passed, 1 pre-existing failure | `71453450` — not re-run after rebase |
| lint | `npx eslint test/renderer/run-center-attempts.test.ts` | `passed`, exit 0 | `71453450` — not re-run after rebase |
| full JS suite | `npm run test:js` | `failed` — 9953 passed / 33 failed across 13 files, none introduced here (A/B below) | `220b5fe5` |
| Python resources | `npm run test:resources` | `not run` | — |

Record validation also passed locally at the time via `scripts/check-spec-records.mjs`, personal
tooling that is **local-only** — not distributed with this repository or this MR, and **not
reviewer- or CI-reproducible**. It is recorded here as a local supplementary check, not as
repository-level verification, and is deliberately kept out of the table above.

## Remaining risks

`test/renderer/run-center.test.ts > builds an overview with health, trend, source, and Agent
load signals` fails with a rotated trend array
(`[0,0,0,0,1,1,0]` vs `[1,0,0,0,0,1,1]`), which looks calendar-dependent. It was already
failing in this session's earlier full run, before this change, and lives in a file this
task did not touch. Left alone — diagnosing it is separate work.

The rebase pulled in `220b5fe5` (builtin-packages seeding plus four builtin skills, 71679 lines).
It touches no path this task changed.

The full JS suite was re-run on `220b5fe5` against a control, so the 33 failures are attributed
by measurement rather than by inference:

| Run | Command | Result |
| --- | --- | --- |
| control — `develop` @ `220b5fe5`, without this commit | `npm run test:js` | 9952 passed / 33 failed / 10082 total, 13 files |
| this branch — same baseline, with this commit | `npm run test:js` | 9953 passed / 33 failed / 10083 total, same 13 files |

The delta is exactly `+1 test, +1 passed, +0 failed` — the test added here. The failing file set
is identical, so this change introduces no failure.

Two of those files are new relative to the task's starting baseline `71453450`:
`packaged-resource-gate.test.ts` (3) and `messaging.test.ts` (1). Both fail in the control too,
so they arrived with `220b5fe5`.

Some cases are flaky and the failure count is not stable across runs:
`chat_attachments.test.ts` gave 1 then 2 failures on consecutive runs, and
`cogseed_backend/runtime-controller.test.ts` failed earlier in the day and passed in both runs
above. Treat 33 as approximate.

## Recovery entry point

`git log feature/spec-workflow-project-memory` for the commit that carries this record, and
`git show <commit> -- test/renderer/run-center-attempts.test.ts` for the change itself. The task is
recorded in this change record; the branch history carries the corresponding commit. Pushed to the
feature branch; never merged into `develop`.
