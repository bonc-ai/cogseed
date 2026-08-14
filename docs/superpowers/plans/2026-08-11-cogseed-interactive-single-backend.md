# CogSeed Interactive Single-Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Preserve the original interactive Agent experience while routing every formal Agent execution, follow-up turn, workflow, retry, recovery, and cancellation through CogSeed Backend / Runtime, with Group Chat limited to entry, interaction state, and result projection.

**Architecture:** Group Chat owns conversation/member state, active recipient, handoff/handback ledger, and projection-only writes. P3394 owns admission/wake/approval. CogSeed Backend owns Agent-to-session mapping, task lifecycle, coordination, cancellation/recovery, and event persistence. CogSeed Runtime owns model/tool execution. Local CLI execution remains behind `src/main/features/local_agents/runner.ts`, invoked only through a backend-owned execution adapter.

**Tech Stack:** Electron main process, TypeScript, classic renderer JavaScript, JSON/JSONL stores, Vitest via `npm run test:js`, `npm test`, CogSeed Runtime JSONL worker protocol.

---

## Current baseline and constraints

- Worktree: `/Users/sudai/Documents/Mate-Backend-Test`
- Current branch: `local/test-merge-cogseed-single-backend`
- Existing uncommitted fixes must be preserved and folded into the implementation:
  - `src/main/features/cogseed_backend/p3394-wake-dispatcher.ts`
  - `src/main/features/cogseed_backend/runtime-controller.ts`
  - `src/main/features/p3394/wake-controller.ts`
  - related tests
- Already removed and must remain absent:
  - `src/main/features/group_chat/p3394-wake-dispatcher.ts`
  - `src/main/features/p3394/kstar-adapter.ts`
  - `src/main/features/p3394/kstar-factory.ts`
  - `packages/nseap-meta-skill-engine`
- `group_chat` is a historical wake domain only. It must never select a Group Chat execution backend.
- `agent_id` is an Agent identity and must never be passed as a model/API profile id.
- Formal visible Agents are interactive by default. Anonymous `run_worker` is the only explicitly headless helper path.
- Local CLI child processes may only start inside `src/main/features/local_agents/runner.ts`.

---

## Task 1: Lock the new contracts with failing tests

**Files:**
- Modify: `test/main/features/cogseed_backend/p3394-wake-dispatcher.test.ts`
- Modify: `test/main/features/cogseed_backend/runtime-controller.test.ts`
- Modify: `test/main/features/p3394/wake-controller.test.ts`
- Create: `test/main/features/cogseed_backend/interactive-session-contract.test.ts`
- Create: `test/main/features/group_chat/cogseed-projection-contract.test.ts`

- [ ] **Step 1: Add the direct wake identity test.**

Assert that a legacy `hand_off_to` request with `workflow_step_id` plus a plain conversation `execution_scope_id` calls `startMateTask` with:

```ts
{
  requestId: 'req-wake-<wake-id>',
  agentId: '<agent-id>',
  task: '<dispatch text>',
  sessionId: 'gconv-<cid>'
}
```

and does not pass `profileId: '<agent-id>'`.

- [ ] **Step 2: Add the interactive state test.**

Mock the CogSeed dispatcher and assert that approving `hand_off_to` calls `setActiveRecipient(userId, cid, agentId)` and writes a waiting ledger with `source_tool: 'hand_off_to'`. Assert that `dispatch_to` does not change the active recipient to the child Agent.

- [ ] **Step 3: Add the stable session mapping test.**

Given two approved turns for the same `(userId, cid, agentId)`, assert that both use the same persisted CogSeed session id and that a different Agent gets a different session id.

- [ ] **Step 4: Add the Group Chat projection contract test.**

Use a fake Runtime event stream containing `model.delta`, `tool.started`, `tool.finished`, `task.completed`, and `task.failed`. Assert that projection writes process events and exactly one terminal Agent message to the original `cid`, with the original `agent_id`, and never calls `group_chat.bus.enqueue` to execute the Agent.

- [ ] **Step 5: Run the new tests and verify they fail for the missing contracts.**

Run:

```bash
npm run test:js -- \
  test/main/features/cogseed_backend/interactive-session-contract.test.ts \
  test/main/features/group_chat/cogseed-projection-contract.test.ts
```

Expected: failures must identify missing session reuse/projection behavior, not unrelated test setup errors.

---

## Task 2: Add durable Agent-to-CogSeed session mapping

**Files:**
- Modify: `src/main/features/cogseed_backend/types.ts`
- Modify: `src/main/features/cogseed_backend/paths.ts`
- Modify: `src/main/features/cogseed_backend/session-store.ts`
- Modify: `src/main/features/cogseed_backend/task-store.ts`
- Modify: `src/main/features/cogseed_backend/runtime-controller.ts`
- Test: `test/main/features/cogseed_backend/session-store.test.ts`
- Test: `test/main/features/cogseed_backend/task-store.test.ts`

- [ ] **Step 1: Define the mapping fields.**

Extend the persisted session/task contracts with optional validated fields:

```ts
conversationId?: string;
agentId?: string;
```

`conversationId` must be a safe conversation id. `agentId` must be a safe Agent id. Existing records without these fields must hydrate as legacy/generic records.

- [ ] **Step 2: Add a stable session lookup.**

Add a user-scoped lookup keyed by `(conversationId, agentId)` that returns the existing `MateSessionRecord` or creates one with:

```text
sessionKind: 'member'
actorRole: 'member'
actorId: agentId
conversationId: cid
```

Do not use a module-level cache as the source of truth. Persist the mapping under the existing user-scoped local/cloud layout.

- [ ] **Step 3: Thread mapping through task creation.**

`StartMateTaskInput` must accept `conversationId` and `agentId`. `createMateTask` must persist both on the task and use the mapped `sessionId` when provided. `agentId` must be sent to Runtime as `agent_id`; `profileId` remains exclusively a model/API profile.

- [ ] **Step 4: Add duplicate/retry semantics.**

A duplicate request id must reuse the same task. A resume/retry must reuse the same Agent session unless an explicit new session is requested. Never resend the original user prompt during recovery; use a continuation request id and continuation text.

- [ ] **Step 5: Run the session/task tests.**

```bash
npm run test:js -- \
  test/main/features/cogseed_backend/session-store.test.ts \
  test/main/features/cogseed_backend/task-store.test.ts \
  test/main/features/cogseed_backend/runtime-controller.test.ts
```

Expected: all pass, including the new `(cid, agentId)` reuse assertions.

---

## Task 3: Resolve formal Agent profile and skill scope before Runtime execution

**Files:**
- Modify: `src/main/features/cogseed_backend/p3394-wake-dispatcher.ts`
- Create: `src/main/features/cogseed_backend/agent-execution-context.ts`
- Modify: `src/main/features/cogseed_runtime/protocol.ts`
- Modify: `src/main/features/cogseed_runtime/runtime-executor.ts`
- Test: `test/main/features/cogseed_backend/p3394-wake-dispatcher.test.ts`
- Test: `test/main/features/cogseed_runtime/protocol.test.ts`

- [ ] **Step 1: Create an execution-context resolver.**

`resolveCogSeedAgentExecutionContext(userId, agentId, cid)` must call the existing Agent loader and return:

```ts
{
  agentId,
  agentName,
  workflow,
  skillList,
  interactive: true,
  runtime: agent.runtime
}
```

It must reject management-only/unavailable Agents before creating a task. It must not use the Agent id as `model_profile`.

- [ ] **Step 2: Serialize Agent workflow as explicit Runtime context.**

Pass the Agent’s workflow/profile instructions as bounded `context` text sections with a stable label. Pass `agent_id` separately. Preserve selected/allowlisted skills as a backend-derived scope; never trust renderer-provided skill scope.

- [ ] **Step 3: Define runtime execution kind.**

Extend the Runtime request/task execution contract with a backend-owned execution kind:

```ts
type: 'cogseed-native' | 'local-cli'
```

The Runtime worker handles `cogseed-native`; the Backend adapter handles `local-cli`. Do not add a new child-process spawn path.

- [ ] **Step 4: Add tests for identity separation.**

Assert that a formal Agent request produces:

```ts
agent_id: 'agent-...'
```

and either omits `model_profile` or uses a real configured model profile id. Assert that an Agent id is never written as `profileId`.

- [ ] **Step 5: Run the resolver/protocol tests.**

```bash
npm run test:js -- \
  test/main/features/cogseed_backend/p3394-wake-dispatcher.test.ts \
  test/main/features/cogseed_runtime/protocol.test.ts \
  test/main/features/cogseed_runtime/runtime-executor.test.ts
```

---

## Task 4: Route all formal Agent wakes through Backend while preserving interactive state

**Files:**
- Modify: `src/main/features/p3394/wake-controller.ts`
- Modify: `src/main/features/cogseed_backend/p3394-wake-dispatcher.ts`
- Modify: `src/main/features/group_chat/state.ts` only for projection/state helpers if required
- Test: `test/main/features/p3394/wake-controller.test.ts`
- Test: `test/main/features/group_chat/bus.test.ts`

- [ ] **Step 1: Keep the only production default dispatcher.**

`wake-controller.ts` must always load `cogseed_backend/p3394-wake-dispatcher.ts`. Historical `group_chat` domains are accepted for reads but cannot select another dispatcher.

- [ ] **Step 2: Distinguish coordination workflow from legacy interactive handoff.**

Only a request with a valid `mate-coord-*` scope and a persisted workflow run may enter the coordination dispatcher. A legacy `workflow_step_id` paired with a plain conversation scope must start a direct CogSeed task.

- [ ] **Step 3: Commit interactive routing state atomically after Backend admission.**

For formal `hand_off_to`, after Backend task/session admission succeeds:

```ts
setActiveRecipient(uid, cid, agentId)
setOrchestrationLedger(uid, cid, {
  status: 'waiting_for_agent',
  blocked_on: 'agent_handoff',
  source_tool: 'hand_off_to',
  owner_agent_id: agentId,
  resume_instruction: explicit || generated continuation
})
```

If task admission fails, reset approval and do not change the recipient/ledger.

- [ ] **Step 4: Keep anonymous `run_worker` headless.**

Anonymous workers may create Backend child tasks, but must not set `active_recipient` or a user-visible Agent handoff ledger.

- [ ] **Step 5: Run the wake routing suite.**

```bash
npm run test:js -- \
  test/main/features/p3394/wake-controller.test.ts \
  test/main/features/p3394/wake-domain-routing.test.ts \
  test/main/features/group_chat/bus.test.ts
```

---

## Task 5: Add the Backend-to-Group-Chat projection bridge

**Files:**
- Create: `src/main/features/cogseed_backend/group-chat-projection.ts`
- Modify: `src/main/features/cogseed_backend/runtime-controller.ts`
- Modify: `src/main/features/group_chat/index.ts` or `src/main/features/group_chat/visibility.ts` only through projection helpers
- Test: `test/main/features/cogseed_backend/group-chat-projection.test.ts`
- Test: `test/main/features/group_chat/cogseed-projection-contract.test.ts`

- [ ] **Step 1: Define projection input and idempotency key.**

Projection input must contain:

```ts
{
  userId,
  conversationId,
  agentId,
  taskId,
  sessionId,
  event
}
```

Use a stable key `(taskId, eventId)` for process events and `(taskId, terminal)` for terminal message projection. Persist/reject duplicates before writing.

- [ ] **Step 2: Project Runtime delta/tool events.**

Map Runtime events as follows:

```text
model.delta     → Group Chat process delta for agentId
 tool.started   → process tool start
 tool.finished  → process tool result
 task.started   → process start
 task.failed    → process error
 task.cancelled → process cancelled
```

Do not call `group_chat.bus.enqueue` for these events; use projection-only persistence/subscription helpers.

- [ ] **Step 3: Project the terminal Agent message.**

On the first terminal result, persist exactly one Agent message to the original `cid`, with `from: agentId`, visibility matching the existing Agent/member rules, and no internal task/runtime ids in user-facing text.

- [ ] **Step 4: Handle stale/late events.**

If the task is cancelled, aborted, or has already projected a terminal result, discard later Runtime deltas/results. If the conversation was deleted, drop the event without recreating it.

- [ ] **Step 5: Call projection from Runtime event consumption.**

`runtime-controller.ts` must call the bridge while consuming events. The bridge must be best-effort for display projection but must not hide task lifecycle persistence failures.

- [ ] **Step 6: Run projection tests.**

```bash
npm run test:js -- \
  test/main/features/cogseed_backend/group-chat-projection.test.ts \
  test/main/features/group_chat/cogseed-projection-contract.test.ts \
  test/main/features/cogseed_backend/runtime-controller.test.ts
```

---

## Task 6: Route subsequent interactive user turns into the same Backend session

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/group_chat/index.ts`
- Modify: `src/main/features/cogseed_backend/runtime-controller.ts`
- Modify: `src/main/features/cogseed_backend/session-store.ts`
- Test: `test/main/features/group_chat/cogseed-interactive-followup.test.ts`
- Test: `test/main/features/cogseed_backend/session-store.test.ts`

- [ ] **Step 1: Detect an active formal Agent recipient.**

At Group Chat routing admission, read `state.active_recipient`. Resolve the Agent and determine whether it is a formal in-process/CLI Agent. Do not route Commander messages to Backend.

- [ ] **Step 2: Create a Backend follow-up request.**

For a user message targeted to the active Agent, call Backend resume/start with:

```ts
{
  conversationId: cid,
  agentId,
  sessionId: stableMappedSession,
  requestId: uniqueContinuationRequestId,
  task: userMessageText,
  context: compact visible Agent session context,
  parentTaskId: activeTaskId
}
```

Do not call the existing Group Chat Agent model loop for this path.

- [ ] **Step 3: Preserve user-visible message and process events.**

Persist the user message normally, then use the projection bridge for Runtime output. Do not duplicate the user message or re-run the original handoff task.

- [ ] **Step 4: Add follow-up tests.**

Assert that after handoff:

1. `active_recipient === agentId`.
2. A new user message creates a continuation request for the same Agent session.
3. No `streamChatWithModel` call occurs for the formal Agent.
4. The final Agent message is projected to the same `cid`.

- [ ] **Step 5: Run the follow-up suite.**

```bash
npm run test:js -- \
  test/main/features/cogseed_interactive-followup.test.ts \
  test/main/features/cogseed_backend/session-store.test.ts \
  test/main/features/group_chat/bus.test.ts
```

---

## Task 7: Route Local CLI Agents through a Backend-owned adapter

**Files:**
- Create: `src/main/features/cogseed_backend/local-cli-execution-adapter.ts`
- Modify: `src/main/features/local_agents/runner.ts` only to expose a typed event adapter if needed; do not add spawn logic elsewhere
- Modify: `src/main/features/cogseed_backend/runtime-controller.ts`
- Modify: `src/main/features/cogseed_backend/types.ts`
- Test: `test/main/features/cogseed_backend/local-cli-execution-adapter.test.ts`
- Test: `test/main/features/local_agents/runner.test.ts`
- Test: `test/main/features/cogseed_backend/separation-boundary.test.ts`

- [ ] **Step 1: Define the adapter contract.**

The adapter accepts the same Backend task/session context and exposes an async event stream. It calls only `local_agents/runner.ts`. It must map CLI events to the Backend task event contract.

- [ ] **Step 2: Move formal CLI dispatch ownership to Backend.**

`Group Chat` must not directly invoke `local_agents/runner.ts` for formal Agent turns. Backend resolves `agent.runtime.kind === 'cli'` and calls the adapter. Anonymous `run_worker` may remain a separately bounded Backend child execution.

- [ ] **Step 3: Preserve CLI session continuity.**

Use the existing CLI session binding/resume behavior, but persist the Backend task id and Agent session id around it. A CLI resume failure creates one new continuation session and never replays the original user message twice.

- [ ] **Step 4: Run CLI boundary tests.**

```bash
npm run test:js -- \
  test/main/features/cogseed_backend/local-cli-execution-adapter.test.ts \
  test/main/features/local_agents/runner.test.ts \
  test/main/features/cogseed_backend/separation-boundary.test.ts
```

---

## Task 8: Cancellation, handback, recovery, and visibility invariants

**Files:**
- Modify: `src/main/features/cogseed_backend/runtime-controller.ts`
- Modify: `src/main/features/cogseed_backend/recovery.ts`
- Modify: `src/main/features/p3394/wake-controller.ts`
- Modify: `src/main/features/group_chat/state.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Test: `test/main/features/cogseed_backend/recovery.test.ts`
- Test: `test/main/features/group_chat/cogseed-interactive-followup.test.ts`
- Test: `test/main/features/p3394/wake-controller.test.ts`

- [ ] **Step 1: Cancel both backend and interactive state.**

Group abort/cancel must cancel the Backend task, mark the Agent session/recipient state stopped, clear or terminalize the ledger, and discard late Runtime events.

- [ ] **Step 2: Require explicit handback.**

Only an explicit handback/completion protocol, user switch, or abort may call `setActiveRecipient(..., COMMANDER_ID)` and clear the waiting ledger. A normal Runtime terminal result must not silently restore Commander when the Agent remains interactive.

- [ ] **Step 3: Recover without replay.**

On boot or task recovery, reattach to the persisted Agent session/task and emit projection state. Do not enqueue the original user message again. Recovery must be idempotent by task/request/event ids.

- [ ] **Step 4: Enforce visibility.**

Agent messages and process events use the existing Group Chat visibility slice. Internal task/runtime ids stay in metadata only and are never added to user-visible text.

- [ ] **Step 5: Run recovery/cancellation tests.**

```bash
npm run test:js -- \
  test/main/features/cogseed_backend/recovery.test.ts \
  test/main/features/group_chat/cogseed-interactive-followup.test.ts \
  test/main/features/p3394/wake-controller.test.ts
```

---

## Task 9: Messaging and external entry integration

**Files:**
- Modify: `src/main/features/cogseed_backend/messaging-host-adapter.ts`
- Modify: `src/main/features/cogseed_backend/messaging-capability-policy.ts`
- Modify: `src/main/features/messaging/manager.ts` if needed after tracing actual entry
- Test: `test/main/features/messaging.test.ts`
- Test: `test/main/features/cogseed_backend/messaging-host-adapter.test.ts`
- Test: `test/main/features/cogseed_backend/capability-artifact-lifecycle.test.ts`

- [ ] **Step 1: Trace inbound messaging into Group Chat.**

Confirm Feishu/Lark inbound messages enter the normal Group Chat conversation path and never create an alternate Agent executor.

- [ ] **Step 2: Route formal Agent actions through Backend.**

An Agent action initiated by messaging must use the same P3394/Backend/session/projection path as desktop Group Chat. The outbound adapter only sends projected final messages/events back to the external conversation.

- [ ] **Step 3: Test normal Commander and Agent flows.**

Keep ordinary external user → Commander replies unchanged. Add a formal Agent dispatch test that asserts the Backend task/session is created and the result is projected once to the external binding.

- [ ] **Step 4: Run messaging tests.**

```bash
npm run test:js -- \
  test/main/features/messaging.test.ts \
  test/main/features/cogseed_backend/messaging-host-adapter.test.ts
```

---

## Task 10: Remove stale architecture tests/references and add final boundary coverage

**Files:**
- Modify: `test/main/features/cogseed_backend/separation-boundary.test.ts`
- Modify: `test/main/features/cogseed_backend/host-capability-boundary.test.ts`
- Modify: `test/static/kstar-single-core.test.ts`
- Modify: `test/main/cogseed-residual-identifiers.test.ts`
- Create: `test/main/features/cogseed_backend/single-formal-agent-execution.test.ts
- Modify: `src/main/features/p3394/execution-boundary.ts`

- [ ] **Step 1: Assert legacy paths are absent.**

Static tests must fail if production source contains the removed files, old dispatcher imports, old adapter/factory symbols, old Engine env vars, or `meta-skill-engine-mcp`.

- [ ] **Step 2: Assert Group Chat does not execute formal Agents.**

Tests must mock the Backend dispatcher and assert formal Agent turns do not call `streamChatWithModel`, `local_agents/runner.ts`, or `group_chat.bus.enqueue` as an execution path. The only allowed Group Chat writes are projection/event/state writes.

- [ ] **Step 3: Assert anonymous worker exception.**

`run_worker` may use a bounded internal Backend execution but must not set `active_recipient` or a user-visible handoff ledger.

- [ ] **Step 4: Run architecture scans.**

```bash
rg -n "groupChatWakeDispatcher|kstar-adapter|kstar-factory|getKstarAdapter|KstarAdapter|meta-skill-engine-mcp|ORKAS_KSTAR_ENGINE|--orkas-kstar-engine" src/main bootstrap.cjs package.json scripts test
```

Expected: no production references; only explicit negative-test strings may remain in the boundary test itself.

---

## Task 11: Verification and runtime acceptance

**Files:**
- No new production files; update tests/docs only if verification exposes a contract gap.

- [ ] **Step 1: Run typecheck.**

```bash
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Run focused suites.**

```bash
npm run test:js -- \
  test/main/features/cogseed_backend \
  test/main/features/cogseed_runtime \
  test/main/features/p3394 \
  test/main/features/group_chat/bus.test.ts \
  test/main/features/group_chat/bus-integration.test.ts \
  test/main/features/messaging.test.ts \
  test/static/kstar-single-core.test.ts
```

Expected: 0 failures.

- [ ] **Step 3: Run full verification.**

```bash
npm test
node scripts/smoke-mate-agent-host-capabilities.mjs
```

Expected: JS and Python resource suites pass; smoke prints `{"ok":true,"hostCalls":3}`.

- [ ] **Step 4: Restart the correct worktree.**

```bash
scripts/restart-cogseed.sh restart
```

Confirm `/tmp/cogseed-agent-cogseed-run.log` contains the current worktree path and commit.

- [ ] **Step 5: Run the real interactive acceptance flow.**

1. Create a new chat.
2. `@` a formal interactive Agent.
3. Confirm Wake is pending and no Agent task starts before approval.
4. Approve Wake.
5. Confirm `active_recipient` is the Agent.
6. Confirm a CogSeed task/session is created and Runtime execution starts.
7. Send a second user message without re-mentioning the Agent.
8. Confirm it resumes the same Agent/CogSeed session.
9. Confirm Runtime delta/tool/final events appear in the original `cid` exactly once.
10. Explicitly hand back or abort and confirm Commander/interactive state changes correctly.
11. Repeat through Feishu if the connector is configured.

- [ ] **Step 6: Inspect logs.**

```bash
LOG="$HOME/.cogseed/runtime-variants/cogseed/data/logs/$(date +%Y-%m-%d).log"
grep -Ei "p3394|wake|mate-task|runtime|projection|active_recipient|kstar-factory|kstar-adapter|meta-skill-engine-mcp|adapter unavailable|groupChatWakeDispatcher" "$LOG"
```

Expected positive evidence:

```text
wake-request-approved
CogSeed task/session created or resumed
Runtime execution started
Runtime result projected to Group Chat
```

Expected absent evidence:

```text
kstar-factory
kstar-adapter
meta-skill-engine-mcp
adapter unavailable
groupChatWakeDispatcher
```

---

## Commit checkpoints

Use separate commits so the MR can be reviewed and reverted by architectural boundary:

1. `test: define interactive CogSeed Agent session and projection contracts`
2. `feat: persist Agent-to-CogSeed session mappings`
3. `feat: route formal Agent wakes through CogSeed Backend`
4. `feat: project Runtime events into Group Chat`
5. `feat: route interactive follow-up turns through CogSeed sessions`
6. `feat: adapt Local CLI execution behind CogSeed Backend`
7. `test: cover cancellation recovery messaging and legacy boundaries`

Do not push `develop` directly. Final integration is through a `dev/*` branch and GitLab MR.
