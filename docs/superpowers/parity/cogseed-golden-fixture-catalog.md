# CogSeed Golden Fixture Catalog

> Phase 0 companion to `docs/superpowers/parity/cogseed-cogseed-capability-matrix.md`.
>
> Purpose: define the concrete synthetic scenarios we will capture as immutable golden fixtures before Phase 1 implementation begins.

## Capture rules

1. Use synthetic, non-secret inputs only.
2. Capture through existing public CogSeed entry points and IPC surfaces, not through internal data files.
3. Record the source revision or commit hash alongside every fixture set.
4. Canonicalize ids, timestamps, file paths, and non-semantic ordering before storing expected output.
5. Store each fixture family in a small, dedicated file or directory so review remains manageable.
6. If a scenario requires live user confirmation or external services, it is not a Phase 0 golden fixture.

## Fixture naming convention

Use the pattern:

```text
<family>-<surface>-<scenario>-v<version>
```

Examples:

- `A-collaboration-create-delegate-v1`
- `B-session-visibility-member-slice-v1`
- `D-tool-office-render-v1`
- `G-ipc-collaboration-panel-v1`

Each fixture record should contain:

- `source_revision`
- `capture_command`
- `inputs`
- `canonicalization_notes`
- `expected`
- `notes`

## Family A — Commander lifecycle

### A1. `A-collaboration-create-delegate-v1`

**Purpose:** capture the canonical create → plan → delegate path.

**Source surfaces:**
- `src/main/features/group_chat/collaboration.ts`
- `src/main/features/group_chat/bus.ts`
- `src/main/features/group_chat/plan_executor.ts`
- `src/main/features/cogseed_backend/coordinator.ts`

**Scenario:**
- Create a commander session for one user.
- Plan a two-step workflow.
- Delegate one child task from the first step.
- Record the resulting child task id and workflow step state.

**Expected assertions:**
- exactly one workflow run is created;
- the first step becomes running before dispatch returns;
- the child task id is recorded once;
- the final snapshot contains no duplicate dispatch entries.

### A2. `A-collaboration-abort-cascade-v1`

**Purpose:** capture abort propagation from parent to active children.

**Scenario:**
- Create a commander session.
- Start two child tasks.
- Abort the parent.
- Observe child cancellation and terminal workflow status.

**Expected assertions:**
- running child tasks are cancelled;
- no new dispatch is scheduled after abort;
- the workflow and parent snapshot end in a terminal cancelled/aborted state.

### A3. `A-collaboration-retry-skip-resume-v1`

**Purpose:** capture the retry/skip/resume state machine.

**Scenario:**
- Create a workflow with a blocked step, a skipped step, and a resumable step.
- Apply retry, skip, and resume actions in sequence.

**Expected assertions:**
- retry creates a new execution attempt only for the target step;
- skip changes step state without re-dispatching the original user message;
- resume clears the blocked condition and produces a new dispatch only when the workflow is eligible.

## Family B — Session and visibility

### B1. `B-session-kind-map-v1`

**Purpose:** capture how session ids map to conversation/member/worker roles.

**Source surfaces:**
- `src/main/features/group_chat/state.ts`
- `src/main/features/group_chat/conv_workspace.ts`
- `src/main/features/group_chat/router.ts`
- `src/main/features/p3394/session-source.ts`

**Expected assertions:**
- `gconv` and `gmember` map to distinct roles;
- worker/session resolution remains stable for the same input;
- invalid ids are rejected deterministically.

### B2. `B-visibility-member-slice-v1`

**Purpose:** capture the member-visible slice of a multi-agent conversation.

**Scenario:**
- Create a conversation with commander, user, member, and child task activity.
- Request the commander slice and a member slice.

**Expected assertions:**
- commander sees the full workflow projection;
- member slice excludes unauthorized messages and tool data;
- child-specific details appear only where policy allows them.

### B3. `B-visibility-negative-leak-v1`

**Purpose:** capture zero-leak behavior under a role that should not see raw details.

**Expected assertions:**
- no raw secret or raw path is present;
- no forbidden tool payload is visible;
- conflict/gate evidence is redacted outside its policy boundary.

## Family C — Bus scheduling

### C1. `C-bus-enqueue-order-v1`

**Purpose:** capture deterministic enqueue ordering and recipient resolution.

**Source surfaces:**
- `src/main/features/group_chat/bus.ts`
- `src/main/features/group_chat/router.ts`

**Expected assertions:**
- resolved recipient ordering is stable for the same input;
- only allowed recipients receive the event;
- hidden recipients stay hidden.

### C2. `C-bus-quiescence-v1`

**Purpose:** capture when the bus is considered quiescent.

**Expected assertions:**
- quiescence is false while work is in flight;
- quiescence becomes true only after all queues drain;
- no event is dropped during the drain transition.

### C3. `C-bus-retry-abort-v1`

**Purpose:** capture retry and abort behavior without duplicate side effects.

**Expected assertions:**
- retry reuses the same logical turn but a new execution attempt;
- abort prevents new dispatches;
- no duplicate terminal event is emitted for the same logical cancellation.

## Family D — Tool execution

### D1. `D-tool-file-guard-v1`

**Purpose:** capture file tool validation and path sandboxing.

**Source surfaces:**
- `src/main/model/core-agent/file-tools.ts`
- `src/main/model/core-agent/local-tools.ts`
- `src/main/features/cogseed_runtime/kernel/tools/file-tools.ts`

**Expected assertions:**
- safe ids and sandboxed paths are accepted;
- traversal and unsafe paths are rejected;
- result caps are applied consistently.

### D2. `D-tool-office-render-v1`

**Purpose:** capture Office render/read behavior.

**Source surfaces:**
- `src/main/model/core-agent/office-tools.ts`
- `src/main/features/cogseed_backend/office-adapter.ts`

**Expected assertions:**
- Office read returns structured text/elements;
- render returns a bounded preview artifact;
- unsupported references are rejected.

### D3. `D-tool-browser-snapshot-v1`

**Purpose:** capture Browser navigation/snapshot/click/type behavior.

**Source surfaces:**
- `src/main/model/core-agent/browser-automation-guard.ts`
- `src/main/features/cogseed_backend/browser-manager.ts`
- `src/main/features/cogseed_backend/browser-adapter.ts`

**Expected assertions:**
- snapshot output is bounded and redacted;
- click/type operate on referenced elements only;
- private storage is not leaked.

### D4. `D-tool-connector-kb-v1`

**Purpose:** capture connector listing/call behavior and KB search/read behavior.

**Expected assertions:**
- only enabled connectors are visible;
- tool calls obey user scope;
- KB read/search returns user-owned data only.

## Family E — Recovery and restart

### E1. `E-runtime-restart-v1`

**Purpose:** capture restart and recovery behavior for running tasks.

**Source surfaces:**
- `src/main/features/cogseed_backend/runtime-controller.ts`
- `src/main/features/cogseed_backend/recovery.ts`
- `src/main/features/cogseed_backend/event-store.ts`
- `src/main/features/cogseed_backend/task-store.ts`

**Expected assertions:**
- completed tasks are not rerun after restart;
- recoverable tasks resume only once;
- child cleanup and orphan detection remain deterministic.

### E2. `E-collaboration-reconcile-v1`

**Purpose:** capture workflow reconciliation after a partial failure.

**Expected assertions:**
- persisted state is reconciled before re-dispatch;
- the recovery pass emits one deterministic recovery summary;
- no duplicate child is created for already completed steps.

## Family F — Historical migration

### F1. `F-legacy-session-migration-v1`

**Purpose:** capture migration from a legacy conversation/session shape into the CogSeed-native model.

**Expected assertions:**
- ids are remapped deterministically;
- unsupported records are reported, not silently transformed;
- migration output includes a journal or warning record.

### F2. `F-compat-projection-v1`

**Purpose:** capture legacy projection stability for public DTOs.

**Expected assertions:**
- legacy public DTO fields stay stable;
- new canonical fields do not leak into old snapshots unexpectedly.

## Family G — Renderer / IPC projection

### G1. `G-ipc-collaboration-panel-v1`

**Purpose:** capture the collaboration IPC payload shape used by the renderer.

**Source surfaces:**
- `src/main/ipc/index.ts`
- `src/renderer/index.html`
- `src/renderer/locales/*.json`

**Expected assertions:**
- the payload shape is stable;
- only renderer-safe fields are exposed;
- locale text remains deterministic.

### G2. `G-ipc-cogseed-session-v1`

**Purpose:** capture Mate session list/read projections.

**Expected assertions:**
- session list/read entries are limited to the user scope;
- record ordering is stable;
- invalid ids fail cleanly.

### G3. `G-ipc-wake-v1`

**Purpose:** capture wake approval UI payloads and statuses.

**Expected assertions:**
- approval/rejection states map consistently;
- no hidden backend fields are leaked;
- status transitions are deterministic.

## Family H — Negative security / leakage

### H1. `H-no-secret-leak-v1`

**Purpose:** ensure no raw secrets or tokens appear in public projections.

**Expected assertions:**
- connector and browser outputs do not expose credentials;
- context and event payloads remain redacted.

### H2. `H-no-path-leak-v1`

**Purpose:** ensure no raw filesystem paths leak into public surfaces.

**Expected assertions:**
- renderer and IPC payloads contain sanitized references only;
- internal workspace paths are not surfaced verbatim.

### H3. `H-no-forbidden-import-v1`

**Purpose:** ensure ordinary parity code does not import forbidden CogSeed business modules.

**Expected assertions:**
- the parity implementation and harness rely on adapter/facade boundaries only;
- live fixture capture uses public entry points only.

## Canonicalizer rules

Every fixture family should apply these canonicalization rules before snapshotting expected output:

- sort object keys where order is not semantically meaningful;
- normalize timestamps to a fixed UTC format or replace them with the placeholder `__TIMESTAMP__` only in the fixture output, not in the source inputs;
- normalize generated ids to family-specific stable tokens;
- strip volatile process ids, temp filenames, and absolute workspace roots;
- bound arrays to the exact expected count;
- keep error messages verbatim when the message text is part of the contract.

## Capture sequence

Recommended Phase 0 capture order:

1. Family A — Commander lifecycle
2. Family B — Session and visibility
3. Family C — Bus scheduling
4. Family D — Tool execution
5. Family E — Recovery and restart
6. Family F — Historical migration
7. Family G — Renderer / IPC projection
8. Family H — Negative security / leakage

This order front-loads the collaboration core before the tool/runtime surfaces and leaves the negative checks as a final guardrail sweep.

## Approval gate

Phase 0 only advances when the matrix and this catalog are both approved and the fixtures are captured into an immutable checked-in form.
