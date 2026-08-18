# Collaboration Control Plane Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Extract the existing P3394/Group Chat collaboration state machine into a reusable control plane and connect both Group Chat and Mate Agent through isolated adapters.

**Architecture:** Preserve current Group Chat exports while moving pure types, lifecycle validation, dependency/gate/conflict reconciliation, and event reduction into `features/collaboration_control`. Introduce Store, Dispatcher, Approval, and Observer ports; then implement Group Chat and Mate adapters without sharing data paths.

**Tech Stack:** TypeScript, JSON/JSONL stores, async-mutex locks, existing Mate Runtime Controller, Vitest.

---

## Task 1: Freeze current collaboration behavior

**Files:**
- Create: `test/main/features/collaboration_control/lifecycle-contract.test.ts`
- Create: `test/main/features/collaboration_control/dependency-contract.test.ts`
- Create: `test/main/features/collaboration_control/adapter-boundary.test.ts`
- Read: `src/main/features/group_chat/collaboration.ts`

- [ ] Write fixture-based tests for run/step transitions, dependency readiness, blocking gates, active conflicts, retry, skip, resume, abort, and event replay.
- [ ] Run the new tests and verify they initially fail because the generic control-plane API does not exist.
- [ ] Add a static boundary test rejecting imports from `group_chat`, `cogseed_backend`, renderer, IPC, or model inside the new control-plane directory.

Run:

```bash
npm run test:js -- test/main/features/collaboration_control
```

## Task 2: Extract common types and lifecycle kernel

**Files:**
- Create: `src/main/features/collaboration_control/types.ts`
- Create: `src/main/features/collaboration_control/lifecycle.ts`
- Create: `src/main/features/collaboration_control/dependency-reconciler.ts`
- Create: `src/main/features/collaboration_control/index.ts`
- Modify: `src/main/features/group_chat/collaboration.ts`

- [ ] Move/re-export workflow, step, gate, context proposal/conflict, event, and snapshot-neutral types without changing serialized field names.
- [ ] Implement pure `transitionRun`, `transitionStep`, `retryStep`, `skipStep`, `resumeRun`, `abortRun`, and `reconcileStepBlockers` functions.
- [ ] Make Group Chat collaboration import the generic types/functions while preserving all public exports.
- [ ] Run contract tests, existing collaboration tests, and typecheck.

## Task 3: Define control-plane ports and engine

**Files:**
- Create: `src/main/features/collaboration_control/ports.ts`
- Create: `src/main/features/collaboration_control/engine.ts`
- Create: `src/main/features/collaboration_control/event-replay.ts`
- Test: `test/main/features/collaboration_control/engine.test.ts`

- [ ] Define Store, Dispatcher, Approval and Observer interfaces with opaque scope ids.
- [ ] Implement engine methods for plan/start/complete/retry/skip/resume/abort/gate/conflict/event replay.
- [ ] Ensure engine writes state and append-only event under one store lock before dispatch side effects.
- [ ] Verify user abort never schedules retry and observer failure cannot corrupt state.

## Task 4: Add Group Chat adapters

**Files:**
- Create: `src/main/features/group_chat/collaboration-store-adapter.ts`
- Create: `src/main/features/group_chat/collaboration-dispatcher.ts`
- Modify: `src/main/features/group_chat/collaboration.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Test: `test/main/features/group_chat/collaboration-adapter.test.ts`

- [ ] Map existing `conversationLayout` files and locks to `CollaborationStore`.
- [ ] Map dispatcher calls to `bus.enqueue` without adding a second enqueue path.
- [ ] Route existing nested dispatch tracking, gate review, conflict tools and snapshots through the engine.
- [ ] Preserve Group Chat IPC and renderer snapshot schemas.

## Task 5: Add Mate adapters

**Files:**
- Create: `src/main/features/cogseed_backend/collaboration-store-adapter.ts`
- Create: `src/main/features/cogseed_backend/collaboration-dispatcher.ts`
- Modify: `src/main/features/cogseed_backend/coordinator.ts`
- Modify: `src/main/features/cogseed_backend/host-tool-router.ts`
- Modify: `src/main/paths.ts`
- Test: `test/main/features/cogseed_backend/collaboration-adapter.test.ts`

- [ ] Store Mate workflow run/context/events only below the Mate coordination directory.
- [ ] Dispatch and cancel through the shared `cogseedRuntimeController`.
- [ ] Keep `cogseed_delegate`, `cogseed_tasks`, and `cogseed_cancel` tool names but route them through the engine.
- [ ] Add Mate tools for plan, retry, skip, resume, gate and conflict only after their engine methods are covered.

## Task 6: Split P3394 wake dispatch

**Files:**
- Create: `src/main/features/p3394/wake-dispatcher.ts`
- Create: `src/main/features/group_chat/p3394-wake-dispatcher.ts`
- Create: `src/main/features/cogseed_backend/p3394-wake-dispatcher.ts`
- Modify: `src/main/features/p3394/wake-controller.ts`
- Modify: `src/main/features/p3394/wake-service.ts`
- Modify: `src/main/ipc/index.ts`
- Test: `test/main/features/p3394/wake-domain-routing.test.ts`

- [ ] Remove direct Group Chat imports from the generic wake decision path.
- [ ] Persist wake request domain and opaque execution scope.
- [ ] Route approval to Group Chat enqueue or Mate engine resume.
- [ ] Keep current IPC and renderer request fields backward compatible.

## Task 7: Instantiate P3394 admission for Mate

**Files:**
- Create: `src/main/features/cogseed_backend/p3394-admission.ts`
- Modify: `src/main/features/cogseed_backend/host-tool-router.ts`
- Test: `test/main/features/cogseed_backend/p3394-admission.test.ts`

- [ ] Supply Mate session, epoch and collaboration context sources to `P3394Controller`.
- [ ] Enforce admission before Mate child dispatch and result handback.
- [ ] Keep Group Chat admission wiring unchanged.

## Task 8: Recovery, compatibility removal and full verification

**Files:**
- Modify: `src/main/features/cogseed_backend/recovery.ts`
- Modify: `src/main/features/group_chat/plan_executor.ts`
- Modify: `scripts/smoke-cogseed-agent-host-capabilities.mjs`
- Test: `test/main/features/collaboration_control/recovery.test.ts`

- [ ] Recover persisted running workflows by reconciling dispatcher execution status; do not resend completed steps.
- [ ] Connect retry/skip/resume to real callers before deleting inert compatibility exports.
- [ ] Remove duplicated state-transition code only after Group Chat and Mate adapter parity tests pass.
- [ ] Run final verification:

```bash
git diff --check
npm run typecheck
npm run test:js -- test/main/features/collaboration_control test/main/features/group_chat test/main/features/p3394 test/main/features/cogseed_backend
node scripts/smoke-cogseed-agent-native.mjs
node scripts/smoke-cogseed-agent-host-capabilities.mjs
npm test
```
