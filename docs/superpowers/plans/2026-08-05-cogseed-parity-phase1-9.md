# Mate CogSeed Parity Phase 1-9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents to implement this plan task-by-task. Each task has an isolated write set and must finish with focused tests before integration.

**Goal:** Complete the CogSeed-native CogSeed capability parity program from Phase 1 through Phase 9 while preserving the current Runtime Worker, IPC allow-list, path sandbox, connector umbrella, and collaboration-control boundaries.

**Architecture:** Keep Mate as the canonical owner of runtime, sessions, actors, tasks, events, visibility, scheduling, tools, migration journals, and renderer projections. Use compatibility facades at the Group Chat boundary rather than importing CogSeed business modules into Mate runtime code. Execute work in dependency-aware waves: independent contracts and adapters in parallel, then integrate the event/scheduler/compatibility chain serially.

**Tech Stack:** Electron main-process Node backend, TypeScript main features, vanilla renderer JavaScript, JSON/JSONL stores, Vitest through `npm run test:js`, Python resource tests through `npm run test:resources`.

---

## Wave 0: Freeze Phase 0 artifacts

### Task 0.1: Preserve the approved Phase 0 capture set

**Files:**
- Existing: `docs/superpowers/parity/cogseed-cogseed-capability-matrix.md`
- Existing: `docs/superpowers/parity/cogseed-golden-fixture-catalog.md`
- Existing: `docs/superpowers/parity/fixtures/**/*.json`
- Existing: `scripts/capture-cogseed-parity-fixtures.ts`
- Existing: `test/main/parity/golden-fixtures.test.ts`

- [ ] Verify the fixture schema, source revision metadata, and canonicalizer output.
- [ ] Create a dedicated baseline commit before Phase 1 code changes.
- [ ] Run `npm run typecheck`, the parity focused tests, `git diff --check`, and `npm test`.

## Wave 1: Independent capability tracks

### Task 1: Mate Commander, Actor, Member Session, and gconv/gmember facade

**Files:**
- Modify/Create: `src/main/features/cogseed_backend/types.ts`
- Modify/Create: `src/main/features/cogseed_backend/session-store.ts`
- Modify/Create: `src/main/features/cogseed_backend/cogseed-control-service.ts`
- Modify/Create: `src/main/features/cogseed_backend/collaboration-dispatcher.ts`
- Modify/Create: `src/main/features/cogseed_backend/index.ts`
- Modify: `src/main/features/group_chat/state.ts`
- Modify: `src/main/features/group_chat/router.ts`
- Tests: `test/main/features/cogseed_backend/*.test.ts`, `test/main/features/group_chat/state.test.ts`, `test/main/features/group_chat/router.test.ts`

- [ ] Add failing contract tests for Mate commander sessions, canonical actor roles, member sessions, and stable `gconv-*` / `gmember-*` projections.
- [ ] Implement user-scoped session creation/read/update/recovery through the Mate session store.
- [ ] Implement the compatibility facade without making Mate runtime import CogSeed Group Chat business logic.
- [ ] Add lifecycle tests for create, resume, abort, terminal state, invalid actor/session ids, and user isolation.
- [ ] Run focused Commander/session tests and `npm run typecheck`.

### Task 2: Tool catalog parity

**Files:**
- Modify: `src/main/features/cogseed_runtime/kernel/tools/catalog.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/tools/runner.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/tools/host-tools.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/tools/file-tools.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/tools/shell-tools.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/tools/skill-tools.ts`
- Modify: `src/main/features/cogseed_backend/host-tool-router.ts`
- Tests: `test/main/features/cogseed_runtime/kernel/tool-schema.test.ts`, `test/main/features/cogseed_runtime/kernel/tool-runtime.test.ts`, `test/main/features/cogseed_backend/host-tool-router.test.ts`

- [ ] Inventory the approved CogSeed tool names against `TOOL_CATALOG` and classify missing entries.
- [ ] Add schemas and runner wiring only through the existing catalog and host-tool choke points.
- [ ] Preserve connector umbrella exposure; do not flatten MCP actions into SDK tools.
- [ ] Add scope, validation, bounded-result, and forbidden-tool tests.
- [ ] Run all runtime-tool and host-router focused tests.

### Task 3: Business capability adapters

**Files:**
- Modify: `src/main/features/cogseed_backend/connector-manager.ts`
- Modify: `src/main/features/cogseed_backend/connector-store.ts`
- Modify: `src/main/features/cogseed_backend/cogseed-kb-store.ts`
- Modify: `src/main/features/cogseed_backend/office-adapter.ts`
- Modify: `src/main/features/cogseed_backend/browser-adapter.ts`
- Modify: `src/main/features/cogseed_backend/browser-manager.ts`
- Modify: `src/main/features/cogseed_backend/host-tool-router.ts`
- Tests: `test/main/features/cogseed_backend/cogseed-connectors.test.ts`, `test/main/features/cogseed_backend/cogseed-kb.test.ts`, `test/main/features/cogseed_backend/office-adapter.test.ts`, `test/main/features/cogseed_backend/browser-manager.test.ts`, `test/main/features/cogseed_backend/host-capability-boundary.test.ts`

- [ ] Compare the approved tool catalog with Connector, KB, Office, and Browser adapters.
- [ ] Implement missing CogSeed-owned lifecycle and scope adapters without bypassing connector authorization, path sandboxing, or Browser/Office isolation.
- [ ] Add negative tests for secrets, private storage, transcript paths, unsupported Office references, and cross-user data.
- [ ] Run the business-capability focused suite.

## Wave 2: Collaboration projection and bus

### Task 4: Visibility policy and append-first Mate Event Bus

**Files:**
- Create/Modify: `src/main/features/cogseed_backend/visibility-policy.ts`
- Create/Modify: `src/main/features/cogseed_backend/event-bus.ts`
- Modify: `src/main/features/collaboration_control/engine.ts`
- Modify: `src/main/features/collaboration_control/event-replay.ts`
- Modify: `src/main/features/cogseed_backend/event-store.ts`
- Modify: `src/main/features/cogseed_backend/collaboration-dispatcher.ts`
- Tests: `test/main/features/collaboration_control/engine.test.ts`, `test/main/features/cogseed_backend/event-store.test.ts`, new visibility/event-bus tests

- [ ] Add failing tests for actor visibility slices, append-first ordering, filtered subscriptions, and event replay.
- [ ] Implement Mate visibility policy as a pure decision boundary over actor role, task scope, and event type.
- [ ] Implement durable append-first event publication and filtered projections.
- [ ] Route workflow, task, tool, recovery, and approval events through one bus.
- [ ] Add zero-leak negative fixtures for raw secrets, paths, tool payloads, artifacts, gates, and conflicts.
- [ ] Run focused visibility, event ordering, replay, and security tests.

### Task 5: Renderer / IPC parity contracts

**Files:**
- Modify: `src/main/features/cogseed_backend/ipc-service.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/main/preload.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/conversation.js`
- Modify: `src/renderer/modules/conversation-info.js`
- Tests: `test/main/features/cogseed_backend/ipc-service.test.ts`, `test/main/ipc/security.test.ts`, renderer collaboration and wake tests

- [ ] Define renderer-safe DTOs for collaboration snapshots, session lists, task status, approvals, artifacts, and recovery summaries.
- [ ] Keep `window.cogseed.invoke` / `window.cogseed.stream` allow-list boundaries unchanged except for explicit Mate routes.
- [ ] Add stale-while-revalidate behavior for collaboration snapshot and session-list reads: return the last valid cached projection immediately, then refresh it asynchronously and publish one replacement event.
- [ ] Add locale-safe renderer projections and schema tests.
- [ ] Run IPC security and renderer projection focused tests.

## Wave 3: Durable scheduler and compatibility

### Task 6: Durable multi-agent scheduler

**Files:**
- Modify: `src/main/features/cogseed_backend/coordinator.ts`
- Modify: `src/main/features/cogseed_backend/task-store.ts`
- Modify: `src/main/features/cogseed_backend/cogseed-execution-store.ts`
- Modify: `src/main/features/cogseed_backend/runtime-controller.ts`
- Modify: `src/main/features/cogseed_backend/recovery.ts`
- Modify: `src/main/features/collaboration_control/dependency-reconciler.ts`
- Tests: `test/main/features/cogseed_backend/coordinator.test.ts`, `coordinator-integration.test.ts`, `recovery.test.ts`, `task-store.test.ts`, new scheduler fairness and lease tests

- [ ] Add failing tests for ready queue ordering, leases, idempotent claims, fairness, concurrency budgets, join/barrier, and no-resend recovery.
- [ ] Implement durable scheduler state using the existing user-scoped stores and event correlation fields.
- [ ] Ensure completed steps are never re-enqueued and expired claims are reconciled exactly once.
- [ ] Add parent/child cancellation cascade and orphan detection tests.
- [ ] Run crash/restart/fault-injection focused tests.

### Task 7: Plan executor parity and compatibility window

**Files:**
- Modify: `src/main/features/cogseed_backend/collaboration-dispatcher.ts`
- Modify: `src/main/features/cogseed_backend/cogseed-control-service.ts`
- Modify: `src/main/features/group_chat/plan_executor.ts`
- Modify: `src/main/features/group_chat/retry_resume.ts`
- Modify: `src/main/features/group_chat/collaboration.ts`
- Modify: `src/main/features/cogseed_backend/session-store.ts`
- Tests: `test/main/features/group_chat/plan-executor-terminal-delivery.test.ts`, `failed-turn-retry.test.ts`, `test/main/features/cogseed_backend/collaboration-adapter.test.ts`, new compatibility tests

- [ ] Map existing plan_set, dispatch_to, hand_off_to, run_worker, retry, skip, resume, and abort transitions into the canonical Mate workflow model.
- [ ] Route new sessions through Mate after parity checks while retaining a read-only/legacy compatibility path for historical sessions.
- [ ] Verify exact-once dispatch, terminal delivery, event order, visibility, and cancellation semantics.
- [ ] Run full Group Chat compatibility and Mate adapter tests.

## Wave 4: Historical migration

### Task 8: Historical session migration and legacy finalization

**Files:**
- Modify: `src/main/util/migrate-session-ids.ts`
- Modify/Create: `src/main/features/cogseed_backend/migration-journal.ts`
- Modify: `src/main/features/cogseed_backend/session-store.ts`
- Modify: `src/main/features/cogseed_backend/recovery.ts`
- Tests: `test/main/util/migrate-session-ids.test.ts`, `test/main/features/cogseed_backend/session-store.test.ts`, new migration journal and rollback tests

- [ ] Add preview, validate, transform, write, verify, finalize, resume, and rollback states.
- [ ] Preserve user scope, actor identity, causal lineage, terminal state, and unsupported-record warnings.
- [ ] Make migration idempotent through a durable journal and explicit finalization gate.
- [ ] Keep unmigrated historical sessions on the Phase 7 compatibility path until the rollback window closes.
- [ ] Run migration, rollback, interruption, and historical tool-call safety tests.

## Wave 5: Surpass audit

### Task 9: Recovery, security, observability, and cross-platform audit

**Files:**
- Modify: `docs/superpowers/parity/cogseed-cogseed-capability-matrix.md`
- Create/Modify: `scripts/benchmark-cogseed-scheduler.mjs`
- Create/Modify: `scripts/fault-inject-cogseed-recovery.mjs`
- Create/Modify: `test/main/features/cogseed_backend/surpass-audit.test.ts`
- Modify: `test/main/features/cogseed_backend/*.test.ts`
- Modify: `test/renderer/*.test.ts`

- [ ] Add reproducible fairness, recovery, isolation, visibility, observability, and conflict-replay acceptance metrics.
- [ ] Run deterministic scheduler load and fault-injection scenarios.
- [ ] Verify macOS and Windows-specific Office, Browser, filesystem, and process-boundary behavior.
- [ ] Update the parity matrix only when the corresponding tests and metrics pass.
- [ ] Run `npm run typecheck`, `npm test`, smoke scripts, and all platform-native gates available in the workspace.

## Integration rules

- Every worker commits only its assigned write set and reports the commit hash and focused test output.
- The coordinator reviews each worker diff before merging it into the integration branch.
- No worker may modify `src/main/preload.js`, `src/main/ipc/index.ts`, `src/main/features/group_chat/bus.ts`, or the parity fixtures concurrently with another worker.
- Before each wave boundary run `git diff --check`, focused tests, `npm run typecheck`, and the relevant smoke scripts.
- The final integration gate is `npm test` plus the Phase 9 audit commands.
