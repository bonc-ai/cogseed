# Tasks: Reconcile Task Status

**Input**: Design documents from `/specs/001-reconcile-task-status/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Regression tests are required because the defect is a cross-layer timing and concurrency failure.

**Organization**: Tasks are grouped by user story and ordered so tests fail before implementation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches a different file or independent fixture
- **[Story]**: Maps the task to the specification user story
- Every task names its concrete file path

## Phase 1: Setup and Evidence Baseline

**Purpose**: Preserve current work and establish the exact regression surface

- [X] T001 Record the current unrelated working-tree changes and keep them untouched while implementing this feature
- [X] T002 Run the current targeted suites from `specs/001-reconcile-task-status/quickstart.md` to establish the pre-change baseline

---

## Phase 2: Foundational Runtime Predicate

**Purpose**: Define one renderer interpretation of the authoritative runtime snapshot

- [X] T003 Add a shared pure runtime-active predicate in `src/renderer/modules/conversation.js` covering `processing`, `backend_active`, `in_flight`, and `active_turns`
- [X] T004 Replace duplicate runtime-active calculations in `src/renderer/modules/conversation.js` with the shared predicate without changing endpoint or payload contracts

**Checkpoint**: Conversation recovery and retry can use the same authoritative state rule

---

## Phase 3: User Story 1 - View Trustworthy Task Status (Priority: P1) 🎯 MVP

**Goal**: Long-running tasks remain non-terminal while the backend reports active

**Independent Test**: A task with an old `processing_since` and authoritative `processing: true` remains pending during polling and after conversation reopen.

### Tests for User Story 1

- [X] T005 [P] [US1] Add a failing long-running polling regression to `test/renderer/conversation-polling.test.ts` proving elapsed time cannot call `_onPolledResponse` while the backend reports active
- [X] T006 [P] [US1] Add a source/behavior regression to `test/renderer/conversation-failed-retry.test.ts` proving history recovery has no 15-minute freshness gate and uses the authoritative runtime predicate

### Implementation for User Story 1

- [X] T007 [US1] Remove the 2,100-second client terminalization branch from `src/renderer/modules/state.js` so polling continues while the server reports processing
- [X] T008 [US1] Replace `processingFresh` age gating in `src/renderer/modules/conversation.js` with authoritative active-state recovery; keep `processing_since` only as the display timer anchor

**Checkpoint**: Active backend work can no longer be shown as completed, failed, or idle because of renderer elapsed time

---

## Phase 4: User Story 2 - Retry Safely (Priority: P1)

**Goal**: Retry never races or queues behind an already-active execution

**Independent Test**: Clicking retry while the runtime snapshot is active sends zero retry requests, restores running UI, and shows a clear status message.

### Tests for User Story 2

- [X] T009 [P] [US2] Add failed-message retry preflight tests to `test/renderer/conversation-failed-retry.test.ts` for active and idle runtime snapshots
- [X] T010 [P] [US2] Add a queue-boundary assertion to `test/renderer/conversation-failed-retry.test.ts` proving both `retry_message_id` and `edit_message_id` are non-queueable historical operations

### Implementation for User Story 2

- [X] T011 [US2] Add an authoritative runtime preflight to `_retryFailedAssistantMessage` in `src/renderer/modules/conversation.js`; when active, restore observation and do not send retry
- [X] T012 [US2] Harden `sendInConversation` in `src/renderer/modules/conversation.js` so retry and edit operations return a busy failure instead of entering the normal FIFO queue
- [X] T013 [P] [US2] Add the active-task retry message to all files in `src/renderer/locales/{en,ja,pt,zh}.json`

**Checkpoint**: Concurrent user retries cannot create or queue duplicate historical executions from the renderer

---

## Phase 5: User Story 3 - Recover After Stale UI State (Priority: P2)

**Goal**: A stale page automatically converges to the backend state without user restart or duplicate action

**Independent Test**: With local pending state absent and runtime active, retry preflight or reopen reconstructs the running observer and status surfaces.

### Tests for User Story 3

- [X] T014 [US3] Extend `test/renderer/conversation-failed-retry.test.ts` to verify active retry preflight calls the existing observer/recovery path and leaves no retry request

### Implementation for User Story 3

- [X] T015 [US3] Reuse the existing conversation run observer from `src/renderer/modules/conversation.js` when retry preflight discovers active backend work
- [X] T016 [US3] Ensure runtime-read failure does not clear pending state or manufacture a terminal result in `src/renderer/modules/conversation.js`

**Checkpoint**: Reopen, reconnect, and retry-preflight paths converge on the same authoritative running state

---

## Phase 6: Polish and Cross-Cutting Validation

**Purpose**: Verify regressions, contracts, and unchanged behavior

- [X] T017 Run `npm test -- test/renderer/conversation-polling.test.ts test/renderer/conversation-failed-retry.test.ts test/main/features/group_chat/failed-turn-retry.test.ts` to verify renderer reconciliation and the existing backend retry idempotency contract
- [X] T018 Run `npm run typecheck` and record any unrelated pre-existing failures separately
- [X] T019 Run `npm run lint` and record any unrelated pre-existing failures separately
- [X] T020 Review the diff to confirm no changes to backend lifecycle, storage schema, ordinary FIFO message queueing, or the user's pre-existing modified files
- [X] T021 Update this task list with completed checkboxes and summarize Submitted versus Verified evidence; do not claim manual acceptance or release

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** establishes the baseline and protects concurrent work.
- **Phase 2** creates the shared predicate required by US1–US3.
- **Phase 3 (US1)** and its tests must complete before retry reconciliation can rely on trustworthy active-state semantics.
- **Phase 4 (US2)** depends on Phase 2 and uses the same predicate.
- **Phase 5 (US3)** integrates US1 and US2 through the existing observer path.
- **Phase 6** depends on all implementation phases.

### User Story Dependencies

- **US1 (P1)**: Depends only on the foundational predicate.
- **US2 (P1)**: Depends on the foundational predicate; independently testable with active/idle retry fixtures.
- **US3 (P2)**: Depends on the reconciliation behavior from US1 and the retry preflight from US2.

### Parallel Opportunities

- T005 and T006 can be authored in parallel conceptually, but both touch renderer tests and should be serialized in one workspace.
- T009 and T010 belong to the same test file and should be implemented together.
- T013 can run in parallel with T011–T012 because it only changes locale files.
- No source implementation begins before its regression test is observed failing.

## Implementation Strategy

1. Add and run failing US1 tests.
2. Implement the shared predicate and remove client-side timeout terminalization.
3. Add and run failing US2/US3 retry tests.
4. Implement retry preflight, observer restoration, and queue defense.
5. Run targeted tests, typecheck, lint, and final diff review.

## AI Product Evidence Notes

- E-001 remains **Submitted** until the regression tests reproduce the mismatch.
- Passing automated tests can move the technical hypothesis to **Verified** for covered scenarios only.
- Manual product acceptance, merge, release, and production outcome remain unclaimed human decisions.

## Completion Evidence (2026-09-18)

- **Submitted**: Specification, design artifacts, regression tests, renderer reconciliation changes, retry concurrency guard, and four-locale user message.
- **Verified**: Renderer regression suites passed 13/13; backend failed-turn retry contract passed 16/16; `npm run typecheck`, `npm run lint`, and `git diff --check` passed.
- **Baseline note**: The pre-change regression tests failed on the seven newly specified cases. An accidental full `npm test -- <files>` run passed 11,718 tests and exposed two unrelated existing failures in `test/main/cogseed-residual-identifiers.test.ts` and `test/main/features/recall/asset-service.test.ts`; neither was modified.
- **Command note**: Targeted verification used `npx vitest run ...` because this repository's `npm test` script ignores trailing file arguments and runs the full suite.
- **Scope review**: No backend lifecycle, persistence schema, dependency, or ordinary FIFO queue behavior changed. Existing user modifications in `src/renderer/modules/boot.js`, `test/renderer/lazy-features.test.ts`, and `test/renderer/settings-open.test.ts` remain untouched.
- **Not claimed**: Manual product acceptance, PR approval, merge, release, and production outcome.
