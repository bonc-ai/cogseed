# 2026-09-01-002-run-center-semantic-authority

Run Center Semantic Authority Consolidation — implementation spec.

- status: `proposed`
- date: 2026-09-01
- baseline at authoring: `origin/develop` @ `220b5fe5`
- design input: an external Run Center semantics design note — **design input only, not a fact source**
- fact source: the working tree at `220b5fe5`. Every `path:line` below was read against it.
- outcome: [change record](../changes/2026-09-01-002-run-center-semantic-authority.md)

---

## 1. Status

**Ready with blockers.**

Two product decisions are open (§11). They block exactly two tasks (`2.2`, `3.3`).
Every other task in §9 is unblocked and can start immediately.

Filename note: the request asked for `spec.md`. `docs/plans/README.md` fixes the repository
convention as `docs/plans/<YYYY-MM-DD-NNN-topic>-plan.md`, so this spec is filed under that
name rather than inventing a `specs/` layout.

---

## 2. Background

Run Center has five independent-looking defects that share one cause: the codebase never
declared **which side owns a fact**. Main computes some semantics, the renderer recomputes
others, and in three places the renderer keeps a private copy of a Main-side value domain that
nothing keeps in sync.

One subsystem already does this correctly and is the model for the rest: action availability.
`taskActions()` (`src/main/features/cogseed_backend/ipc-service.ts:530`) decides *whether* an
action is permitted; `recommendedActionAvailable()`
(`src/renderer/modules/run-center-board.js:452`) only picks a recommendation *from within* that
permitted set, and the detail pane gates its buttons on the same set. The rule was never
written down, so `dispatchable`, `userState`, `column`, lineage and failure reason each ended up
with their own answer.

This is one task, not five bug fixes, because the fixes share a single projection surface
(`taskSummary()` / the board projection) and a single renderer resolver layer. Fixing them
separately would add a sixth and seventh private table.

---

## 3. Problem Statement

Each item below was re-verified against the working tree. Claims from the design document that
did not survive verification are recorded in §3.6 and are **out of scope**.

### 3.1 Agent eligibility — two incomparable gates, not one loose one

`agent-registry-projection.ts:249` computes
`enabled && installed && online && runtimeSupported && peer?.disabled !== true`.

The execution admission gate `resolveCogSeedAgentExecutionContext`
(`agent-execution-context.ts:57-66`) checks `isAgentEnabled` → `getAgentForChatDispatch` →
`isCogSeedAgentRuntimeSupported`. The two are **not** ordered by strictness; they diverge in
both directions:

| Dimension | Registry projection | Admission gate |
| --- | --- | --- |
| `installed` (CLI present) | checked (`:240-244`) | **not checked** |
| `online` (peer reachable) | checked (`:245-247`) | **not checked** |
| `peer.disabled` | checked (`:249`) | **not checked** |
| `interaction_mode === 'management_only'` | **not checked** | checked, via `isAgentChatDispatchable` (`agent-dispatch-policy.ts:94`) |
| per-user enable file | active-user only (`listAgentSummaries` uses `getActiveUserId()`, `agents.ts:1528`) | per `userId` (`readAgentEnabled`) |

`AgentSummary` already carries `interaction_mode` (`agents.ts:1537`) — the projection simply
never reads it. So a management-only Agent is shown as `dispatchable: true` and rejected at
execution; an offline peer is shown as offline and accepted at execution.

A third definition exists in the renderer: `createAgentCandidates()`
(`run-center.js:335-344`) synthesises `dispatchable: agent?.enabled !== false` when
`cogseed.agent.list` failed, and `taskDispatchableAgentCandidates()` (`:345-348`) lets every
enabled fallback Agent through. `loadAgents()` (`:1067-1086`) swallows the registry error into
`state.agentRegistryError`, which is passed only to the Agents page (`:479`) — the create /
reassign modal shows no staleness signal at all.

A fourth partial definition sits in `run-center-overview.js:78-79`, which filters
`enabled !== false && interaction_mode !== 'management_only'` — the only renderer site that
knows about `management_only`.

### 3.2 Run state — four resolvers over three vocabularies, at two different levels

| Resolver | Location | Vocabulary | Level |
| --- | --- | --- | --- |
| `LOGICAL_ACTIVE_STATE_PRIORITY` | `run-center-board.js:7`, used at `:252-257` | `task.column` | picks the **member** that defines a Run's aggregate `column`/`status` |
| `ATTENTION_STATE_PRIORITY` | `run-center-board.js:8-14` | `userState.kind` | sorts the attention queue (`:477`) |
| `userStateForTask` branch order | `run-center-board.js:109-177` | `status` + `resultDeliveryState` + `column` + context | decides the card's displayed state |
| `attemptStateTask` | `run-center.js:271-277` | `status` | picks the representative **task inside an attempt** |

The three orderings disagree. `pending_recovery` is priority 4 (least urgent) in
`ATTENTION_STATE_PRIORITY` but is the **second** branch in `userStateForTask` (`:120`),
ahead of `failed` (`:152`).

The combination is reachable: `finalizeCogSeedTaskFromRetainedResult`
(`lifecycle.ts:94-139`) sets `status: 'failed'` and `resultDeliveryState: 'pending-recovery'`
together after a crash-recovery. `taskActions()` grants **both** `retry: true` (`:551`) and
`recoverResult: true` (`:553-554`) for that state, so both actions are legitimately available
and the only open question is which is primary — that is §11 PD-1.

Two further code facts constrain any merge:

- `aggregateMembers()` (`run-center-board.js:246-262`) runs inside `buildRunModels()`, which
  has **no** collaboration context. `contextForRun` is never supplied by `run-center.js` (the
  only call site, `renderQueue` at `run-center.js:453-459`, omits it), so `queueGroups`
  always calls `userStateForTask(task, {})`. A resolver that requires context therefore
  **cannot** replace `LOGICAL_ACTIVE_STATE_PRIORITY` without changing when the aggregate is
  computed.
- `attemptStateTask` selects within an attempt; `aggregateMembers` selects within a Run.
  They answer different questions and must stay separate functions even if they share a
  priority table.

Dead branch confirmed: `attemptIsRecovered` (`run-center.js:571-574`) tests for
`'recovered'` / `'delivered_after_recovery'`. `CogSeedResultDeliveryState`
(`types.ts:35`) is `not-applicable | pending | delivered | pending-recovery`; `task-store.ts:189-193`
rejects anything else on read. Neither value has a producer anywhere in `src/`. The condition
is constantly false.

Also dead: `userStateForTask:136` and `attemptStateTask`'s priority list test for
`needs_review`, `blocked`, `pending`, `skipped`. `CogSeedTaskStatus` (`types.ts:29-37`) has
none of them, and `CogSeedRendererTaskSummary.status` is typed `CogSeedTaskStatus`
(`ipc-service.ts:204`). Only `context.hasReview` / `context.hasConflict` can reach the review
branch, and only from the detail pane (`run-center.js:649-655`).

### 3.3 Column — two names for two concepts, and 15 unsynchronised consumers

`column` is projected only on the board projection
(`ipc-service.ts:1072`, type at `:152`), never on `taskSummary()`. It is computed by
`cogSeedRendererBoardColumn(status, archivedAt)` (`:560-567`), whose attention set is
`{waiting_user, recoverable, failed}`.

`displayColumnForTask` (`run-center-board.js:179-181`) returns `'attention'` whenever
`userStateForTask(...).attention` is true, else `task.column`. Because context is never
passed outside the detail pane, the **only** thing the renderer actually adds is
`pending-recovery`.

Consequence: the two-stage split is real but the *justification* in the design document —
that collaboration facts are visible only to the renderer — does not hold for
`displayColumn`. `displayColumn` is a pure function of `status`, `resultDeliveryState` and
`archivedAt`, all of which Main owns.

The duplication is real and unguarded. `column` is read at 15 sites
(`run-center-board.js:28,29,112,163,253,255,260,363,435`;
`run-center-overview.js:39,44,53,67,98,119`). `filteredTasks` mixes both in adjacent lines
(`:28` uses `task.column`, `:29` routes through `displayColumnForTask`). `filterRuns:315-317`
and the Overview `statusCounts:51-54` each re-derive attention independently, with a
`|| task.column` fallback that silently diverges if the board module fails to load.

`board.counts` (`ipc-service.ts:1080-1088`), keyed by base column, is **not read by any
renderer module** — verified by grep. It is a dead projection field.

A fifth attention definition exists in `diagnostics` (`ipc-service.ts:1146`), duplicating
`cogSeedRendererBoardColumn`'s attention set inline.

### 3.4 Lineage — one guessing path, narrower than the document claims

`action()` (`ipc-service.ts:1449-1495`) always returns
`collaborationSnapshot(userId, { taskId: input.taskId })` — the **source** task. The renderer
therefore guesses at `run-center.js:1536-1543`: it diffs Run keys before/after refresh, keeps
candidates matching `sessionId` or `conversationId`, and takes the newest by `updatedAt`.

Scope is narrower than the design document states:

- **`reassign` is already correct.** `submitCreate()` calls `cogseed.task.reassign`
  (`run-center.js:1181`) and selects `created.sessionId` / `created.taskId`
  (`:1194`). The handler returns `taskSummary(childTask)` (`ipc-service.ts:883-922`).
- **`retry` and `resume` channels already exist and already return the child**:
  `cogseed.task.retry` → `taskSummary` (`ipc-service.ts:944-950`), `cogseed.task.resume` →
  `taskSummary` (`:952-975`), both wired at `ipc/index.ts:960-961`. The renderer simply does
  not use them; it routes retry/resume through `cogseed.task.action`.
- **`resume` does not create a child task at all.** `resumeCogSeedTask`
  (`runtime-controller.ts:1094-1140`) resumes the existing record and returns it.
- **`recover-result` and `abort` create no child.**
- **Group Chat retry cannot return a child synchronously.** `action()` delegates to
  `retryGroupChat(...)` which returns `{ ok, error }` (`ipc-service.ts:1473-1483`); the child
  task appears later through the bridge. So *no* uniform `childTaskId` is available on every
  child-producing path.
- **`retryCogSeedTask` may return the source task**, not a child:
  `settleReplacementSource` short-circuits with `if (source.recoveredResult) return source.task`
  (`runtime-controller.ts:1078`, mirrored for reassign at `:1050`).

Authority already exists: `retryOfTaskId` is written by both `retryCogSeedTask`
(`lifecycle.ts:163`) and `reassign` (`ipc-service.ts:902`, via `prepareAgentStart`).
`parentTaskId` is **already projected** (`ipc-service.ts:604`) and already consumed
(`run-center.js:280-281,291`). Only `retryOfTaskId` is unprojected.

### 3.5 Failure classification — an open string space used as a behaviour enum

`safeErrorCode` (`lifecycle.ts:55-58`) and `runtimeErrorCode`
(`runtime-controller.ts:175-178`) validate format only (`/^[A-Za-z0-9_.:-]+$/`, ≤120). There
is no shared enum. Verified producers:

| Producer | Location | Codes |
| --- | --- | --- |
| model adapter | `cogseed_runtime/kernel/model-adapter.ts:138-150` | `provider_auth` · `provider_rate_limit` · `provider_server_error` · `provider_network` · `provider_error` |
| **core-agent event mapper** | `model/core-agent/event-mapper.ts:69-90` | `provider_no_first_event` · `provider_network` · `provider_not_configured` · `provider_auth` · `provider_rate_limit` · `context_overflow` · `provider_timeout` · `provider_balance` · `provider_permission` · `provider_request` · `provider_error` |
| execution loop | `cogseed_runtime/kernel/execution-loop.ts:47,85,110,121` | `aborted` · `max_tool_rounds` · `runtime_tool_error` |
| session runner | `cogseed_runtime/kernel/session-runner.ts:17` | `aborted` |
| **runtime index** | `cogseed_runtime/index.ts:129,181` | `runtime_capture_failed` · `runtime_worker_failed` |
| runtime controller | `runtime-controller.ts:444,448,587,663-665,677-681,1253,1262` | `runtime_restart` · `runtime_watchdog_orphaned` · `runtime_stream_ended` · `result_retention_failed` · `runtime_worker_error` · `worker_restart` |
| passthrough default | `runtime-controller.ts:177` | `runtime_failed` |
| local CLI adapter | `local-cli-execution-adapter.ts:182` | raw CLI status string (not a failure taxonomy) |
| Group Chat run | `group_chat/bus.ts:1607` | `group_chat_run_failed` |
| Group Chat turn | `group_chat/bus.ts:3923` | `group_chat_turn_failed` · `group_chat_turn_cancelled` |
| Group Chat plan | `plan_executor.ts:185` → `bus.ts:3885` | `model_preflight` · `model_stream_error` · plus any `event-mapper` code |
| Group Chat admission | `bus.ts:2917` | `runtime_admission_failed` |
| recovery / reassign | `recovery.ts:91` · `ipc-service.ts:850,907` | `worker_restart` · `conversation_unavailable` |

The **entire `event-mapper` set is missing from the design document's producer list**, and it
reaches `task.errorCode` through `plan_executor.failureFields` → `bus.ts:3885`
`finishTask({ errorCode: result.outcome.failureCode })`. `provider_not_configured` and
`provider_balance` in particular are model-configuration failures that today land in the
renderer's "retry" path exactly like `provider_auth`.

Consumers in the renderer:

- `run-center-board.js:153` — `['model_preflight', 'provider_error']` decides
  `configure-model` vs `retry`. This is the confirmed user-visible defect: `provider_auth` is
  not in the list, so an auth failure recommends "retry", which can never succeed.
- `run-center.js:558-563` `errorHelpKey` — three-code table selecting a help string.
- `run-center.js:1091-1095` `createFailureMessage` — matches the English strings
  `'CogSeed Agent is unavailable'` / `'CogSeed Agent runtime is not executable'` thrown by
  `agent-execution-context.ts:61,64,66`, i.e. natural language used as a wire protocol.
- `run-center.js:775` — diagnostics panel renders raw codes. Legitimate; keep.

`failureKind` already exists upstream. `GroupMessageFailureKind`
(`group_chat/visibility.ts:69-70`) is `model | config | dependency | validation | operation |
runtime`, paired with a low-cardinality `failure_code` (`:162-164`). `plan_executor.ts:181-186`
produces both. `bus.ts:3885` forwards only `failureCode`;
`group-chat-task-bridge.ts:228-254` has no `failureKind` parameter. The kind is dropped at the
bridge and never reaches Run Center.

### 3.6 Design-document claims that did NOT survive verification — out of scope

| Document claim | Code fact |
| --- | --- |
| "`retryOfTaskId` 与 `parentTaskId` 均未出现在任何投影中" | `parentTaskId` **is** projected (`ipc-service.ts:604`) and consumed (`run-center.js:280`). Only `retryOfTaskId` is missing. |
| "重试/改派后可能切到错误的新运行" | Reassign already selects the returned task (`run-center.js:1194`). Only the `cogseed.task.action` path guesses. |
| "`action()` 返回体扩展 … `childTaskId` 在所有产生 child task 的路径上都可获得" | False for Group Chat retry (`retryGroupChat` returns `{ok,error}`) and meaningless for `resume` / `recover-result`, which create no child. |
| "`relationKind: 'retry' \| 'reassign' \| 'resume' \| 'recover-result'`" | `resume` and `recover-result` produce no child record to carry a relation. |
| C3 §8.3 "两阶段必要，因为协作信息只在 Renderer 可见" | `displayColumnForTask` never receives collaboration context outside the detail pane. Its extra input over Main is only `resultDeliveryState`, which Main owns. The two-stage split may be kept, but not for this reason. |
| "`requiresModelConfiguration`" as a standalone function at `board.js:153` | It is an inline `const` inside `userStateForTask`, not an exported function. |
| "`failureCategory` … Renderer 私有分类（消费者）" | `failureCategory` (`run-center.js:576-582`) has **no production caller**. It is exported at `:2027` and exercised only by `test/renderer/run-center-attempts.test.ts:59-85`. |
| "bus.ts 的三个 finishTask 调用点一并传入 failureKind" | Only `bus.ts:3885` has a real `failureKind`. `:1602` and `:3923` synthesise codes with no kind. |
| "现有测试真实执行：渲染层 29 用例全通过" | 30 tests; 29 pass, 1 fails (`run-center.test.ts:344`, calendar-drifting trend fixture — the R13 item, pre-existing). |
| collaboration `targetId` "待运行时验证" | Not a semantic-authority issue. `collaborationAction` (`ipc-service.ts:1504-1505`) format-validates, then delegates existence checking to `groupChat.*` / `cogseedControlService.*`. Single owner, no consumer guessing. **Does not block this task.** |

---

## 4. Goals

Each goal is machine-verifiable.

- **G1** One authoritative Agent eligibility resolver. `dispatchable` has exactly one
  assignment expression for agent rows, consumed by the registry projection and by the
  execution admission gate. Verified by an invariant test (§14 INV-1) plus a consistency test
  feeding one Agent fact set to both.
- **G2** The admission gate and the registry projection agree in **both** directions:
  the gate rejects not-installed / offline / peer-disabled agents, and the projection reports
  `dispatchable: false` for `management_only` agents.
- **G3** The renderer never derives behaviour from a producer `errorCode` value list.
  `requiresModelConfiguration` and `errorHelpKey` read `failureCategory` only.
- **G4** `provider_auth`, `provider_not_configured`, `provider_balance`, `provider_permission`
  and `model_preflight` all recommend "configure model", not "retry".
- **G5** The renderer locates a post-action run from an authoritative task id returned by the
  invoked channel; the `sessionId`/`conversationId`/`updatedAt` heuristic is deleted.
- **G6** Sorting, card display, attempt-representative selection and Run-aggregate selection
  draw their priority values from a single exported table; no second priority constant exists
  in the renderer.
- **G7** Filtering, grouping and counting consume `displayColumn`; `baseColumn` is read only
  where lifecycle meaning is intended (archive handling).

---

## 5. Non-Goals

- No Run Center refactor beyond the five contracts. No UI redesign.
- No change to Run identity: `logicalRunKey` (`run-center-board.js:55-66`) and
  `attemptKeyForTask` (`run-center.js:266-270`) are untouched.
- No new IPC channel. Every change is a field addition to an existing projection or a switch
  to an already-registered channel. IPC schema stays v1.
- No change to Group Chat semantics beyond adding an optional `failureKind` parameter to the
  task bridge and passing it at one call site.
- `recoverable` is **not** split out of `status` into its own dimension. It is coupled to
  execution outcome today and no verified defect depends on separating them.
- Collaboration `targetId` validation is untouched (§3.6).
- `R13` (the drifting Overview trend fixture, `run-center.test.ts:344`) is **not** fixed here.
  It predates this task. Task 4.1 only requires that it not regress further.
- No `provider_error` behaviour change: it keeps its current "configure model" mapping.

---

## 6. Semantic Contracts (verified C0–C5)

### C0 — Authority boundary

- **Authority**: Main owns every judgement of the form "what is this, objectively" —
  executability, execution outcome, delivery outcome, lineage, failure class.
- **Renderer may**: choose among Main-permitted options, group, sort, count, and label.
- **Renderer must not**: (a) hold a parallel enumeration of a Main value domain; (b) parse
  natural-language messages as machine state; (c) infer a domain fact from a presentation
  conclusion.
- **Scope correction**: C0 does not require moving presentation derivation into Main. The
  action-availability pattern (`taskActions` → `recommendedActionAvailable`) is the
  reference shape: Main publishes the permitted set, the renderer picks within it.
- **Legitimate renderer-side facts**: collaboration review/conflict state
  (`run-center.js:649-650`) is read from `cogseed.session.read`, a different projection than
  `cogseed.task.list`. It stays renderer-side and is passed as explicit context.

### C1 — Agent execution eligibility

- **Authority**: one exported pure function in `agent-registry-projection.ts`.
- **Inputs**: `{ enabled, interactionMode, runtime, cliAvailable, peer }`.
- **Outputs**: `{ dispatchable: boolean, reasonCode?: EligibilityReasonCode }`.
- **Consumers**: the registry projection (agent rows), the admission gate, the renderer's
  filters and health badges.
- **Prohibited**: synthesising `dispatchable` in the renderer; treating "registry unavailable"
  as "eligible".
- **Explicitly retained**: the per-source-kind branching at `:240-249` and `:289-299` is
  **correct** and must be preserved verbatim inside the extracted function. Runtime rows
  (`:309-344`) are a different entity (runtimes, not agents) and are **not** unified.

### C2 — Run state resolution

- **Authority**: `status` and `resultDeliveryState` remain two independent Main fields; the
  projection does not merge them.
- **Single renderer resolver**: one exported priority table; `userStateForTask` remains the
  single producer of `{ kind, attention, stateKey, reasonKey, action, actionKey, priority }`.
- **Level separation is preserved**: `aggregateMembers` (member-within-Run) and
  `attemptStateTask` (task-within-attempt) stay separate functions that *read* the shared
  table. They are not merged into one call.
- **Prohibited**: a second priority constant; branch reordering to match a document.

### C3 — Run presentation projection

- **Authority**: Main owns `baseColumn` (lifecycle bucket). The renderer owns `displayColumn`
  (attention bucket), computed by exactly one function.
- **Consumers**: filtering, grouping and counting use `displayColumn`. `baseColumn` is read
  only for archive handling.
- **Prohibited**: `|| task.column` fallbacks that silently produce a third answer.

### C4 — Run lineage

- **Authority**: Main. `retryOfTaskId` and `parentTaskId` are the authoritative links.
- **Two channels**: (1) the invoked channel returns the resulting task record — the renderer
  selects `result.taskId`; (2) `taskSummary()` projects `retryOfTaskId` so the link survives a
  refresh.
- **Prohibited**: inferring lineage from `sessionId`, `conversationId` or `updatedAt`.
- **Boundary**: for paths where no synchronous child id exists (Group Chat retry), the
  renderer falls back to *keeping the current selection*, never to guessing.

### C5 — Failure classification

- **Authority**: Main. `classifyFailure(errorCode, failureKind?)` runs at the projection
  boundary and emits `failureCategory`.
- **Two dimensions**: `failureCategory` is a stable low-cardinality behaviour enum;
  `errorCode` stays an open diagnostic string and is unchanged.
- **Precedence**: `failureKind` (when present) wins over the `errorCode` map. Rationale:
  `failureKind` is produced by the component that knows *why*
  (`plan_executor.ts:182`), while the code map is a lookup by a value the producer may extend
  without notice.
- **Consumers**: the renderer picks recommended action and text key from `failureCategory`
  only. The diagnostics panel keeps rendering raw `errorCode`.
- **Prohibited**: `errorCode` value lists in the renderer; `message.includes()` on backend
  English strings.

---

## 7. Failure taxonomy (evidence-backed)

Every category maps to at least one verified producer from §3.5. Categories are mutually
exclusive by construction: the map is a total function from `errorCode` to exactly one
category, with `failureKind` consulted first.

| category | errorCodes mapped | recommended action |
| --- | --- | --- |
| `model_unavailable` | `provider_auth` · `provider_not_configured` · `provider_balance` · `provider_permission` · `model_preflight` | configure model |
| `provider_transient` | `provider_rate_limit` · `provider_server_error` · `provider_network` · `provider_timeout` · `provider_no_first_event` | retry |
| `provider_error` | `provider_error` · `provider_request` · `context_overflow` | configure model (preserves today's `provider_error` behaviour) |
| `runtime_failure` | `runtime_failed` · `runtime_tool_error` · `max_tool_rounds` · `runtime_stream_ended` · `runtime_capture_failed` · `result_retention_failed` | retry |
| `worker_restart` | `runtime_restart` · `worker_restart` · `runtime_watchdog_orphaned` · `runtime_worker_error` · `runtime_worker_failed` | resume |
| `conversation_unavailable` | `conversation_unavailable` | reassign |
| `agent_unavailable` | `runtime_admission_failed` | reassign |
| `collaboration_failure` | `group_chat_run_failed` · `group_chat_turn_failed` | open handling |
| `cancelled` | `aborted` · `cancelled` · `group_chat_turn_cancelled` | none |
| `unknown` | everything else, including raw local-CLI status strings | retry |

`failureKind` precedence map: `config` → `model_unavailable`; `model` → fall through to the
code map (a `model` kind may be transient or terminal, so the code decides);
`dependency` / `operation` → `collaboration_failure`; `runtime` → `runtime_failure`;
`validation` → `unknown`.

Rationale for the `model` exception: `plan_executor.ts:185` defaults a `model` kind's code to
`model_stream_error`, which is genuinely retryable, while an auth failure also arrives with
kind `model`. Kind alone is insufficient there; the code is more specific.

---

## 8. Data / IPC Changes

IPC schema stays v1 throughout; the preload bridge is a generic
`invoke(channel, payload)` (`src/main/preload.js:47`) with an allow-list in
`src/main/ipc/index.ts`, so **no preload change is required**. The renderer is vanilla JS
(`AGENTS.md` "Boundary"), so **there are no renderer typings to update**.

| field | owner | type | producer | projection point | consumer | optional | old data | back-compat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `eligibility.reasonCode` | Main | `'not_installed' \| 'offline' \| 'disabled' \| 'peer_disabled' \| 'unsupported_runtime' \| 'management_only'` | `resolveAgentEligibility()` | `CogSeedRendererAgentSummary` (`agent-registry-projection.ts:15-31`) | `run-center-agents.js` filters/health | yes — absent when `dispatchable` | n/a, computed live | additive |
| `registryFreshness` | Main | `'fresh'` | `buildCogSeedAgentRegistryProjection` | `CogSeedRendererAgentRegistryProjection` (`:59-65`) | `run-center.js` create modal | no | n/a | additive. `'stale'`/`'unknown'` are **renderer-side** states meaning "the call failed"; Main only ever emits `'fresh'` |
| `failureCategory` | Main | the §7 enum | `classifyFailure()` | `taskSummary()` (`ipc-service.ts:569-631`) | `run-center-board.js`, `run-center.js` | yes — absent when no `errorCode` | historical `errorCode`s run through the same map; unmapped → `unknown` | additive |
| `retryOfTaskId` | Main | `string` | `lifecycle.ts:163`, `ipc-service.ts:902` | `taskSummary()` | `run-center.js` lineage fallback | yes | absent on pre-retry tasks — treated as "no lineage" | additive. Passes `rendererSafeIdentifier` like `parentTaskId` |
| `baseColumn` | Main | `CogSeedRendererBoardColumn` | `cogSeedRendererBoardColumn()` | board projection (`ipc-service.ts:1072`) | renderer archive handling | no | n/a | **`column` is kept as an alias for one release**; both fields emitted, identical value |
| `failureKind` (bridge input) | Group Chat | `GroupMessageFailureKind` | `plan_executor.ts:182` | `GroupChatTaskFinishInput` (`group-chat-task-bridge.ts:57`) | `classifyFailure` | yes | absent → code map only | additive parameter |

**Not added** (contrary to the design document, per §3.6):

- `lineage.relationKind` — no persisted field is added. `resume` and `recover-result` create
  no child; `retry` vs `reassign` is already distinguishable at the projection boundary
  (`retryOfTaskId` present + a different `agentId` than the source ⇒ reassign) and no
  verified consumer needs the distinction. Adding a persisted field would require a
  `task-store` schema change and a back-fill for no consumer.
- `action().result.childTaskId` — superseded by task 3.1, which switches the renderer to the
  already-existing `cogseed.task.retry` / `cogseed.task.resume` channels that return the task
  record directly. This is strictly less code and no new response shape.
- `retainedResultAvailable` — `resultDeliveryState === 'pending-recovery'` already carries it.

---

## 9. Implementation Plan

### Phase 1 — Authoritative facts (no behaviour change)

#### Task 1.1 — Project `retryOfTaskId`

- **Files**: `src/main/features/cogseed_backend/ipc-service.ts`
- **Change**: add `...(rendererSafeIdentifier(task.retryOfTaskId) ? { retryOfTaskId: ... } : {})`
  to `taskSummary()` (`:569-631`) and to `CogSeedRendererTaskSummary` (`:196-223`), next to
  the existing `parentTaskId` line at `:604`.
- **Why**: §3.4 — the authoritative link exists but is invisible to the renderer.
- **Dependencies**: none.
- **Must preserve**: `parentTaskId` projection and its consumers (`run-center.js:280-281,291`).
  Field ordering in the returned object is irrelevant but the four strict-equality assertions
  at `renderer-projection.test.ts:115,504,543,556` and `ipc-service.test.ts:500` must still pass.
- **Remove**: nothing.
- **Acceptance**: a task created by `retryCogSeedTask` projects `retryOfTaskId === source.taskId`.
- **Tests**: extend `test/main/features/cogseed_backend/renderer-projection.test.ts`.

#### Task 1.2 — `classifyFailure()` + `failureCategory` projection

- **Files**: `src/main/features/cogseed_backend/ipc-service.ts` (new exported pure function +
  `taskSummary` field + type).
- **Change**: implement the §7 map as a module-level frozen record; call it from `taskSummary`.
  Export `classifyFailure` for unit testing.
- **Why**: §3.5 — no stable behaviour dimension exists.
- **Dependencies**: none.
- **Must preserve**: `errorCode` projection and the diagnostics aggregation
  (`ipc-service.ts:1137,1149`) unchanged.
- **Remove**: nothing yet.
- **Acceptance**: every `errorCode` in the §3.5 producer table maps to its §7 category; an
  unmapped code yields `unknown`; a task with no `errorCode` yields no `failureCategory` key.
- **Tests**: new `test/main/features/cogseed_backend/failure-classification.test.ts` — one
  assertion per row of §7 plus the unmapped and absent cases.

#### Task 1.3 — Carry `failureKind` across the Group Chat bridge

- **Files**: `src/main/features/cogseed_backend/group-chat-task-bridge.ts` (add optional
  `failureKind` to `GroupChatTaskFinishInput` at `:57` and thread it into the `updateTask` /
  `transitionTask` payload at `:228-254`); `src/main/features/group_chat/bus.ts:3885`
  (pass `result.outcome.failureKind`); `src/main/features/cogseed_backend/types.ts` (persist
  `failureKind?`); `ipc-service.ts` (`classifyFailure` reads it).
- **Change**: one optional field end to end.
- **Why**: §3.5 — the upstream two-level taxonomy is dropped at the bridge.
- **Dependencies**: 1.2 (needs `classifyFailure`).
- **Must preserve**: `bus.ts:1602` and `bus.ts:3923` are **not** modified — they have no real
  `failureKind`. Group Chat message rendering and analytics that read
  `GroupMessage.failure_kind` are untouched.
- **Remove**: nothing.
- **Acceptance**: a Group Chat plan failure with `failureKind: 'config'` produces
  `failureCategory: 'model_unavailable'` even when its `errorCode` is unmapped.
- **Tests**: extend `test/main/features/cogseed_backend/group-chat-task-bridge.test.ts`.

#### Task 1.4 — Extract `resolveAgentEligibility()` (pure refactor + `reasonCode`)

- **Files**: `src/main/features/cogseed_backend/agent-registry-projection.ts`
- **Change**: extract the `:240-249` computation and the bare-peer computation at `:289-299`
  into one exported pure function returning `{ dispatchable, reasonCode? }`. Add
  `interaction_mode` as an input and `management_only` as a reason. Both agent call sites
  consume it. Runtime rows (`:309-344`) are **not** touched.
- **Why**: §3.1 — eligibility has never existed as a single function.
- **Dependencies**: none.
- **Must preserve**: the per-source-kind branching semantics exactly, **except** that
  `management_only` agents now report `dispatchable: false` (this is the one intended
  behaviour change in this task; it aligns the projection with the gate that already rejects
  them).
- **Remove**: the two inline `dispatchable` expressions.
- **Acceptance**: `agent-registry-projection.test.ts` passes unchanged for every existing
  case; new cases assert `reasonCode` for each of the six values.
- **Tests**: extend `test/main/features/cogseed_backend/agent-registry-projection.test.ts`.

#### Task 1.5 — `registryFreshness`

- **Files**: `agent-registry-projection.ts` (emit `registryFreshness: 'fresh'` in the returned
  projection at `:365-371`).
- **Change**: one literal field.
- **Why**: §3.1 — the renderer has no way to tell a fresh list from a fallback list.
- **Dependencies**: none (parallel with 1.4).
- **Must preserve**: `schemaVersion: 1`.
- **Acceptance**: `cogseed.agent.list` responses carry `registryFreshness: 'fresh'`.
- **Tests**: one assertion in `agent-registry-projection.test.ts`.

### Phase 2 — Behaviour alignment

#### Task 2.1 — Admission gate consumes the shared resolver

- **Files**: `src/main/features/cogseed_backend/agent-execution-context.ts`
- **Change**: after `getAgentForChatDispatch` succeeds (`:63-64`), gather the registry facts
  the resolver needs (`detectAll()` for the agent's CLI, `listP3394Peers()` for its peer) via
  the existing `cogseed-agent-registry-host` facade, call `resolveAgentEligibility`, and throw
  a structured error carrying `reasonCode` when `dispatchable` is false.
- **Why**: §3.1 G2 — offline peers and uninstalled CLIs are accepted today.
- **Dependencies**: **1.4**.
- **Must preserve**:
  - `isAgentChatDispatchable` / `management_only` rejection stays where it is — it is a
    security-relevant authorization read and `agent-dispatch-policy.ts` must keep its
    documented import isolation (`agent-dispatch-policy.ts:1-6`). The shared resolver
    *reports* `management_only`; it does not *replace* the policy check.
  - The gate has **three** callers, all of which inherit this change:
    `interactive-turn.ts:46`, `ipc-service.ts:812`, `p3394-wake-dispatcher.ts:31`.
    The P3394 wake path must be exercised — a wake for an offline peer will now be rejected
    earlier.
  - `isCogSeedAgentRuntimeSupported` keeps its current signature; it is imported by
    `agent-registry-projection.ts:8`.
  - For `runtime.kind === 'in_process'` the added checks are identities (`installed` and
    `online` are constant true, `:240-247`), so in-process behaviour is unchanged.
- **Remove**: the independently rewritten condition at `:66` is replaced, not deleted —
  `runtimeSupported` becomes one input to the resolver.
- **Acceptance**: an Agent whose `runtime.kind === 'cli'` with `cli.available === false` is
  rejected; a `p3394-gateway` Agent whose peer is `online: false` is rejected; both errors
  carry a `reasonCode`. An `in_process` enabled Agent is still admitted.
- **Tests**: extend `test/main/features/cogseed_backend/agent-execution-context.test.ts` with
  one negative case per `reasonCode`, and re-run `p3394-wake-dispatcher.test.ts`.
- **Risk**: this is the one task that can reject work the system previously accepted. Before
  merging, confirm no existing test depends on the looser gate — `agents.test.ts:236,266`,
  `auto_tasks.test.ts`, `wake-controller.test.ts` and the 34-file `group_chat` suite all call
  `getAgentForChatDispatch` and must stay green.

#### Task 2.2 — Single run-state priority table — **BLOCKED by PD-1**

- **Files**: `src/renderer/modules/run-center-board.js`, `src/renderer/modules/run-center.js`
- **Change**: export one priority table; `userStateForTask` implements the PD-1 outcome for
  `failed` + `pending-recovery` (emitting both dimensions in the card text either way);
  `attemptStateTask` (`run-center.js:271-277`) reads the shared table instead of its own list;
  `aggregateMembers` keeps operating on `baseColumn` but sources its ordering from the shared
  table. Fix `attemptIsRecovered` (`run-center.js:571-574`) to use the real value domain.
- **Why**: §3.2 — three disagreeing orderings; one dead recovery indicator.
- **Dependencies**: **PD-1** (§11).
- **Must preserve**:
  - `aggregateMembers` must keep running without collaboration context — it executes inside
    `buildRunModels` (`:264-286`), which has none. Do **not** make the aggregate depend on
    `hasReview` / `hasConflict`.
  - `attemptStateTask` and `aggregateMembers` remain separate functions (different levels).
  - `recommendedActionAvailable` (`:452-463`) keeps gating on the backend `actions` set.
    The resolver proposes; `actions` disposes.
  - `logicalRunKey` and `attemptKeyForTask` untouched.
- **Remove**: `ATTENTION_STATE_PRIORITY` as a second constant; `attemptStateTask`'s inline
  priority list; the dead `'recovered'` / `'delivered_after_recovery'` test.
- **Acceptance**: exactly one priority constant in `src/renderer/modules/`; a `failed` +
  `pending-recovery` task yields the PD-1 primary action, the PD-1 sort position, and a card
  showing both dimensions; `attemptIsRecovered` returns true for a delivered-after-recovery
  attempt.
- **Tests**: new cases in `test/renderer/run-center-attempts.test.ts` and
  `test/renderer/run-center-recommended-action.test.ts`.

### Phase 3 — Consumer cleanup

#### Task 3.1 — Delete the lineage heuristic

- **Files**: `src/renderer/modules/run-center.js`
- **Change**: route `retry` and `resume` through the existing `cogseed.task.retry` /
  `cogseed.task.resume` channels (`ipc/index.ts:960-961`), which return
  `CogSeedRendererTaskSummary`. Select `result.taskId` / `result.sessionId`. For actions with
  no returned task (`abort`, `archive`, `recover-result`, and Group Chat `retry`, which must
  stay on `cogseed.task.action`), keep the current selection and refresh; add a
  `retryOfTaskId` reverse lookup as the post-refresh fallback.
- **Why**: §3.4.
- **Dependencies**: **1.1** (for the reverse-lookup fallback).
- **Must preserve**:
  - The archive branch (`run-center.js:1516-1534`) — adjacent-run selection and its toast.
  - `selectionRevision` checking (`:1157-1162`, `:1523`) — new field arrivals must not
    bypass it.
  - Group Chat retry still goes through `cogseed.task.action`; `action()`'s Group Chat branch
    (`ipc-service.ts:1459-1487`) is unchanged.
  - The `recoveredResult` short-circuit (`runtime-controller.ts:1078`) means the returned task
    may be the **source** task. Selecting the returned id is correct in that case too — do not
    assume the returned id differs from the source.
- **Remove**: `run-center.js:1536-1543` — the `previousRunKeys` diff, the
  `sessionId`/`conversationId` filter and the `updatedAt` sort.
- **Acceptance**: with two runs in one conversation landing within the same second, retry
  selects the run whose `retryOfTaskId` is the source — the case the heuristic gets wrong.
- **Tests**: new race case in `test/renderer/run-center-async-resilience.test.ts`.

#### Task 3.2 — Delete the renderer's `errorCode` tables

- **Files**: `src/renderer/modules/run-center-board.js`,
  `src/renderer/modules/run-center.js`, `src/renderer/locales/{zh,en,ja,pt}.json`
- **Change**: `requiresModelConfiguration` (`board.js:153`) becomes
  `task?.failureCategory === 'model_unavailable' || task?.failureCategory === 'provider_error'`.
  `errorHelpKey` (`run-center.js:558-563`) becomes a single-line
  `run_center.failure_help_${category}` lookup. Delete `failureCategory`
  (`run-center.js:576-582`) and its export at `:2027`.
- **Why**: §3.5, G3, G4.
- **Dependencies**: **1.2**.
- **Must preserve**: the diagnostics panel's raw `errorCode` rendering (`:775`);
  `attemptIsFailed`'s `!!task.errorCode` truthiness test (`:566`) — that is a presence check,
  not a value table; the timeline event grouping at `:490,497` which uses `event.errorCode`,
  a different field.
- **Remove**: the three tables above.
- **Test impact — must be handled, not skipped**: deleting `failureCategory` invalidates
  ten assertions added yesterday by task `2026-09-01-001`
  (`test/renderer/run-center-attempts.test.ts:59-85`). Rewrite them against the Main-side
  `classifyFailure` from task 1.2 rather than deleting the coverage. Record the supersession
  in this task's change record.
- **Locale impact**: ten new `run_center.failure_help_<category>` keys in **all four**
  locales. `run-center.test.ts` "defines all static Run Center labels in Simplified Chinese
  and English" already guards zh/en; ja and pt must be checked manually.
- **Acceptance**: a task with `errorCode: 'provider_auth'` recommends "configure model".
- **Tests**: regression case for R1 in `test/renderer/run-center-recommended-action.test.ts`.

#### Task 3.3 — Degraded-mode agent candidates — **BLOCKED by PD-2**

- **Files**: `src/renderer/modules/run-center.js`, `src/renderer/modules/run-center-agents.js`
- **Change**: delete the synthesised `dispatchable` at `run-center.js:341`. Implement the
  PD-2 outcome for the create/reassign modal. Wire `registryFreshness` into the modal so the
  degraded list is labelled. `run-center-agents.js` filters (`:59,62`) and health
  (`:99-119`) read `reasonCode`.
- **Why**: §3.1.
- **Dependencies**: **1.4**, **1.5**, **2.1**, **PD-2** (§11).
- **Must preserve**: `agentOptionsReady()` (`:356-358`) semantics; the Agents-page error
  surface at `:479`; `run-center-overview.js:78-79`'s `management_only` filter — which becomes
  redundant once 1.4 lands but must not be removed in the same task without a passing
  overview test.
- **Remove**: `run-center.js:341`.
- **Acceptance**: with `cogseed.agent.list` failing, the modal shows the PD-2 behaviour and
  the list carries a staleness label.
- **Tests**: extend `test/renderer/run-center-async-resilience.test.ts` (it already models a
  degraded registry at `:166-173`).

#### Task 3.4 — `column` → `baseColumn`, one `displayColumn` resolver

- **Files**: `src/main/features/cogseed_backend/ipc-service.ts`,
  `src/renderer/modules/run-center-board.js`, `src/renderer/modules/run-center-overview.js`
- **Change**: emit `baseColumn` alongside `column` (identical value) in the board projection
  (`:1072`) and in `CogSeedRendererBoardTask` (`:152`). In the renderer, replace all 15
  `task.column` reads with `baseColumn` (archive handling) or `displayColumnForTask`
  (filtering, grouping, counting). Delete the `|| task.column` fallbacks at
  `overview.js:39,53,98`.
- **Why**: §3.3, G7.
- **Dependencies**: **2.2** (the resolver must be settled first).
- **Must preserve**: `board.counts` (`ipc-service.ts:1080-1088`) stays keyed by base column
  and stays unread — do **not** delete it in this task; it is projection surface with no
  verified consumer and removing it is a separate compatibility decision.
  `matchesFilter`'s archived semantics (`:22`) unchanged.
- **Remove**: the `|| task.column` fallbacks. `column` itself stays as an alias.
- **Acceptance**: the same task set produces identical column assignments and counts in Queue,
  Board and Overview.
- **Tests**: a three-surface consistency case in `test/renderer/run-center.test.ts`.

#### Task 3.5 — Structured admission rejection replaces string matching

- **Files**: `src/main/features/cogseed_backend/agent-execution-context.ts`,
  `src/main/features/cogseed_backend/ipc-service.ts`,
  `src/renderer/modules/run-center.js`
- **Change**: the gate's thrown errors carry `reasonCode` (from 2.1); the IPC layer surfaces
  it; `createFailureMessage` (`run-center.js:1091-1095`) reads it.
- **Why**: §3.5 — English messages used as a wire protocol.
- **Dependencies**: **2.1**.
- **Must preserve**: the two English `message.includes` branches stay as a **legacy fallback**
  for one release, after the structured branch, so an older backend still localises.
- **Remove**: nothing yet; removal is scheduled for the release after this one.
- **Acceptance**: a structured rejection localises without the message ever being inspected.
- **Tests**: extend `test/renderer/run-center.test.ts`.

### Phase 4 — Verification

#### Task 4.1 — Static gates

- Run the exact commands in §13. Record `passed` / `failed` / `not run` per
  `docs/changes/README.md` — a planned-but-unexecuted command is `not run`, never `passed`.
- Confirm the pre-existing overview-trend failure in `run-center.test.ts` is unchanged (still one
  failure, same assertion) and that the pre-existing full-suite failure set has not grown.

#### Task 4.2 — Electron runtime verification

Six checks, none of which a static test can substitute:

1. Invalid model credentials → the card recommends "configure model", not "retry" (C5 final
   acceptance).
2. Crash-recovery producing `failed` + `pending-recovery` → sort position, card text and
   primary/secondary actions match PD-1.
3. P3394 gateway disconnected → submitting an offline Agent is rejected by the gate with a
   localised reason (C1).
4. Two runs in one conversation landing within the same second, then retry → the child run is
   selected (C4 race).
5. `cogseed.agent.list` forced to fail → candidate list shows the PD-2 behaviour with a
   staleness label.
6. New projection fields under a delayed response → `selectionRevision`
   (`run-center.js:1157-1162`) still prevents cross-selection.

**Outcome.** Checks 1, 3 and 4 (lineage half) were verified against a real build. Checks 2, 5, 6
and the decoy-race half of 4 proved unreachable at runtime in this build — not for lack of
effort but for structural reasons, each recorded with its cause and its discriminating regression
test in the change record's *Phase 4* sections. No check was reclassified as an implementation
defect.

---

## 10. Dependency Graph

```
PD-1 ──────────────┐
PD-2 ──────────┐   │
               │   │
1.1 retryOfTaskId ─────────────┐
1.2 classifyFailure ──┬─ 1.3 failureKind bridge
                      │
1.4 resolveAgentEligibility ─┬─ 2.1 admission gate ─┬─ 3.5 structured rejection
1.5 registryFreshness ───────┘                      │
               │   │                                │
               └───┼────────────────────────────────┴─ 3.3 degraded candidates
                   │
                   └─ 2.2 run-state table ── 3.4 baseColumn / displayColumn

1.1 ─── 3.1 lineage heuristic removal
1.2 ─── 3.2 errorCode table removal

all ─── 4.1 static gates ─── 4.2 Electron
```

Parallelisable now, with no blocker: **1.1, 1.2, 1.4, 1.5** (four independent tasks), then
**1.3, 2.1, 3.1, 3.2** as their dependencies land.

`3.1` and `3.2` are on independent chains and can run concurrently.

Blocked: **2.2** (PD-1) and, transitively, **3.4**; **3.3** (PD-2).

Phase 0 is **not** a global gate. Ten of the twelve implementation tasks are unblocked.

---

## 11. Product Decision Blockers

### PD-1 — `failed` + `pending-recovery`: which action is primary?

- **Exact state**: `status === 'failed'` and `resultDeliveryState === 'pending-recovery'`.
  Produced by `finalizeCogSeedTaskFromRetainedResult` (`lifecycle.ts:94-139`) when a terminal
  result was durably retained before a process exit and the task is settled on restart.
- **Implementation-independent facts**:
  - `taskActions()` grants both `retry: true` (`ipc-service.ts:551`) and
    `recoverResult: true` (`:553-554`). Both actions are genuinely available; nothing in Main
    prefers one.
  - `archive` is denied in this state (`:532-534`) and `archiveCogSeedTask` throws
    (`lifecycle.ts:47-49`), so the card cannot be dismissed without resolving it.
  - Today the card shows "result not delivered" and recommends `recover-result`
    (`run-center-board.js:120-126`), but sorts **last** in the attention queue
    (`ATTENTION_STATE_PRIORITY.pending_recovery = 4`, `:13`). Display and sort already
    contradict each other.
  - Both options cost the same to implement.
- **Option A — recover first**: primary `recover-result`, secondary `retry`, sorted by
  recovery urgency rather than last. *User consequence*: the user retrieves the retained
  output without re-invoking the model or incurring cost, then decides whether to retry. The
  failure is visually secondary and may be missed.
- **Option B — fail first**: primary `retry`, secondary `recover-result`. *User consequence*:
  the failure is immediately visible; the primary path re-runs the model and incurs cost even
  though a retrievable result already exists.
- **Decision required**: primary action, secondary action, and sort position.
- **Blocks**: task **2.2**, and transitively **3.4**.
- **Does not block**: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 3.1, 3.2, 3.5.
- **Note**: whichever is chosen, the card must show both dimensions. The current model forces
  a choice between two facts that are simultaneously true; the fix is to display both and
  decide only the *action* ordering.

### PD-2 — Degraded registry: may the user submit an Agent of unknown eligibility?

- **Exact state**: `cogseed.agent.list` threw; `state.agentRegistry` is unset;
  `state.agentRegistryError` is populated (`run-center.js:1078-1081`); `agentOptionsReady()`
  returns true on `agentsLoaded` alone (`:356-358`).
- **Implementation-independent facts**:
  - Today the fallback list is built from `agents.list` and marks every non-disabled Agent
    `dispatchable: true` (`:341`) with no installed/online/runtime/peer information.
  - The local pre-submit check at `:1169` therefore admits everything, and the create modal
    displays no staleness signal — `agentRegistryError` reaches only the Agents page (`:479`).
  - After task 2.1 the backend gate rejects ineligible Agents with a structured reason
    regardless of which option is chosen, so neither option can start an impossible run.
  - The two options differ only in *where* the user is stopped and what they can attempt.
- **Option A — show but do not promise**: list the Agents with an explicit "status unknown"
  label, drop the local pre-submit gate, and let the backend answer. *User consequence*: the
  user can still start work while the registry is down; an ineligible choice fails at submit
  with a clear reason instead of being invisible.
- **Option B — block on unknown**: keep a local gate and refuse submission until the registry
  is readable. *User consequence*: no misleading options, but a registry outage blocks all
  Agent-targeted task creation, including for Agents that would in fact work.
- **Decision required**: which behaviour, and whether the same rule applies to reassign as to
  create.
- **Blocks**: task **3.3** only.
- **Does not block**: any other task, including 2.1, which makes the backend authoritative
  either way.
- **Note**: the design document treats this as a PRD clarification rather than a decision. It
  is user-observable behaviour and is recorded here as a decision. PRD 13.3 / 14.3 should be
  updated to match whichever option is chosen.

---

## 12. Compatibility & Migration

- **IPC schema**: stays v1. Every change is an additive optional field on an existing
  projection, or a switch to an already-registered channel. No channel is added, removed or
  renamed. `ipc/index.ts:955-979` is unchanged except where noted (it is not).
- **Preload**: unchanged. `src/main/preload.js:47` forwards `{ channel, payload }` generically.
- **Renderer typings**: none exist — the renderer is classic JS per `AGENTS.md`.
- **Old renderer / new backend**: safe. Every new field is additive; an old renderer ignores
  `failureCategory`, `retryOfTaskId`, `baseColumn`, `reasonCode` and `registryFreshness`.
  `column` is retained as an alias for exactly this reason.
- **New renderer / old backend**: this is a single-process Electron app shipped as one
  artifact, so the combination does not occur in production. It **does** occur in tests that
  stub the projection. Every new-renderer read must therefore tolerate an absent field:
  `failureCategory` absent → treat as `unknown`; `baseColumn` absent → fall back to `column`
  **in task 3.4 only**, and remove that fallback when the alias is removed;
  `registryFreshness` absent → treat as `unknown`.
- **Persisted task records**: `retryOfTaskId` and `parentTaskId` already exist in
  `CogSeedTaskRecord` (`types.ts:18-19,97,102`). Only `failureKind?` is added (task 1.3), and
  it is optional with no back-fill. Historical records simply have no kind and classify from
  `errorCode` alone.
- **Historical `errorCode` values**: classified by the same §7 map. Codes from removed or
  renamed producers fall to `unknown`, which recommends retry — the current default. No
  migration, no rewrite of stored records.
- **`resultDeliveryState` guard**: `task-store.ts:189-193` already rejects values outside the
  four-value domain on read, so no record can carry the phantom `'recovered'` /
  `'delivered_after_recovery'` values that task 2.2 stops testing for.
- **Fixtures**: `test/fixtures/parity/**` contains no Run Center projection — verified by
  grep for `column` / `errorCode` / `resultDeliveryState`. No golden fixture is affected.
  `test/main/parity/golden-fixtures.test.ts` is unaffected.
- **Strict-equality assertions to re-run**: `renderer-projection.test.ts:115,504,543,556`
  and `ipc-service.test.ts:500` use `toEqual({...})` on projection results. They cover
  empty/edge shapes rather than full task summaries, but any added field must be checked
  against them.
- **Localisation**: four locales (`zh`, `en`, `ja`, `pt`). Task 3.2 adds ten
  `run_center.failure_help_<category>` keys and task 3.3/3.5 add reason-code and staleness
  strings. `run-center.test.ts`'s static-label test guards zh and en only; ja and pt need a
  manual pass.
- **Alias removal**: `column` is removed one release after `baseColumn` ships. That removal is
  **not** part of this task.

---

## 13. Testing Strategy

Commands are the repository's real gates (`AGENTS.md` "Quick gates"; `package.json`).
`npx vitest --reporter=basic` fails in this repo — use `npm run test:js`.

**Unit** — pure functions, no I/O.
- `classifyFailure` — one case per §7 row, plus unmapped, absent, and `failureKind`
  precedence. New file `test/main/features/cogseed_backend/failure-classification.test.ts`.
- `resolveAgentEligibility` — the six source kinds × the six reason codes.
- The shared run-state priority table — one case per state.

**Contract** — Main projection → renderer consumer, same data on both sides.
- One Agent fact set → registry projection, admission gate: identical `dispatchable`.
- One task set → Queue, Board, Overview: identical column assignment and counts.
- One `errorCode` → `classifyFailure` → `requiresModelConfiguration` → recommended action.

**Regression** — one per confirmed defect.
- R1: `errorCode: 'provider_auth'` ⇒ primary action "configure model".
- R2: uninstalled CLI / offline peer rejected by the gate.
- R4: retry selects the child run, not a sibling.
- R9: `attemptIsRecovered` true for a delivered-after-recovery attempt.

**Negative** — prevent the private tables from coming back.
- The renderer contains no `errorCode === '<producer value>'` comparison.
- The renderer contains no second attention/state priority constant.
- `dispatchable` is assigned in exactly one place for agent rows.

**Race**
- Two runs in one conversation, `updatedAt` within one second, then retry ⇒ correct selection
  (this is the case the deleted heuristic gets wrong; pin it as a regression).
- A background refresh arriving mid-selection must not move the selected card
  (`selectionRevision`).

**Runtime / Electron** — the six checks in task 4.2. Mark
`RUNTIME_VALIDATION_PENDING` until executed. Static tests do not substitute for them.

### Commands

| check | command |
| --- | --- |
| types | `npm run typecheck` |
| backend | `npm run test:js -- test/main/features/cogseed_backend/` |
| renderer Run Center | `npm run test:js -- test/renderer/run-center.test.ts test/renderer/run-center-attempts.test.ts test/renderer/run-center-recommended-action.test.ts test/renderer/run-center-async-resilience.test.ts` |
| Group Chat + agents | `npm run test:js -- test/main/features/group_chat/ test/main/features/agents.test.ts` |
| full JS suite | `npm run test:js` |
| app | `./run.sh` |

---

## 14. Structural Invariants

Expressed as tests, following the existing precedent
`test/main/cogseed-residual-identifiers.test.ts`, which already reads source files and asserts
on their content. Grep-only checks are used solely where the pattern is unambiguous.

- **INV-1 — one eligibility authority.** In
  `src/main/features/cogseed_backend/agent-registry-projection.ts`, the string `dispatchable:`
  appears at most twice outside type declarations (the two runtime-row literals), and neither
  agent-row site contains a boolean expression. Implemented as a source-reading test, not a
  bare grep, so type declarations are excluded.
- **INV-2 — one run-state priority table.** Across `src/renderer/modules/run-center*.js`,
  exactly one object literal or array maps state names to priority numbers. Asserted by
  requiring `ATTENTION_STATE_PRIORITY` to be the only exported priority symbol and by a
  behavioural test that sorting, card state, attempt representative and Run aggregate agree on
  a fixed input.
- **INV-3 — no producer value copies in the renderer.** No file under
  `src/renderer/modules/run-center*.js` contains a comparison of a task field against a
  literal from the §3.5 producer inventory. Implemented as a test that reads the four files and
  fails on `errorCode ===`, `errorCode)` inside an `includes([...])`, or
  `resultDeliveryState === '<value not in the four-value domain>'`. The diagnostics panel's
  raw rendering (`run-center.js:775`) is exempt by line-range allowlist.
- **INV-4 — no lineage guessing.** No Run Center renderer file selects a run by combining
  `conversationId`/`sessionId` with an `updatedAt` sort. Expressed behaviourally by the race
  test rather than by grep — the pattern is too diffuse to match reliably.
- **INV-5 — no natural-language protocol.** `run-center*.js` contains no
  `.includes('CogSeed ` outside the explicitly annotated legacy-fallback block in
  `createFailureMessage`. The allowlist is a named constant in the test so removing the
  fallback later also removes the exemption.
- **INV-6 — presentation does not decide domain truth.** `src/main/features/cogseed_backend/`
  imports nothing from `src/renderer/`. Trivially greppable and worth pinning.

Invariants deliberately **not** written as grep: "actions gating is respected" and "the
resolver is the only state source" — both produce false positives on legitimate code and are
covered by contract tests instead.

---

## 15. Definition of Done

- [ ] Tasks 1.1–1.5, 2.1, 3.1, 3.2, 3.4, 3.5 implemented.
- [ ] PD-1 decided and recorded; task 2.2 implemented to match; PRD 12.1 / 24.2 updated if
      option A is chosen.
- [ ] PD-2 decided and recorded; task 3.3 implemented to match; PRD 13.3 / 14.3 clarified.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run test:js -- test/main/features/cogseed_backend/` passes (baseline 319/319).
- [ ] `npm run test:js -- test/main/features/group_chat/ test/main/features/agents.test.ts`
      passes (baseline 801 passed / 7 skipped).
- [ ] Renderer Run Center suite: 1 pre-existing failure only
      (`run-center.test.ts:344`), no new failures.
- [ ] `npm run test:js` full-suite failure count has not grown beyond the 33 pre-existing
      failures at baseline `220b5fe5`, with an A/B comparison against that same baseline.
- [ ] New unit, contract, regression, negative and race tests from §13 exist and pass.
- [ ] INV-1 … INV-6 implemented and passing.
- [ ] The superseded `failureCategory` assertions from `2026-09-01-001` are rewritten against
      `classifyFailure`, not deleted; the supersession is recorded in the change record.
- [ ] Ten new locale keys present in `zh`, `en`, `ja`, `pt`.
- [ ] No occurrence remains of: the synthesised `dispatchable` (`run-center.js:341`), the
      lineage heuristic (`:1536-1543`), `errorHelpKey`'s code table (`:558-563`), the dead
      `failureCategory` (`:576-582`), the hardcoded
      `['model_preflight','provider_error']` (`run-center-board.js:153`), or the dead
      `'recovered'` / `'delivered_after_recovery'` test (`:573`).
- [ ] `column` alias still emitted; its removal is deferred and recorded as follow-up.
- [ ] Task 4.2's six Electron checks executed, or explicitly recorded as
      `RUNTIME_VALIDATION_PENDING`.
- [ ] `docs/changes/2026-09-01-002-*.md` written with every command marked
      `passed` / `failed` / `not run`.
- [ ] Final diff contains no unrelated refactor. In particular: `board.counts` not deleted,
      R13's trend fixture not "fixed", runtime rows in `agent-registry-projection.ts` not
      unified, `recoverable` not split out of `status`.
