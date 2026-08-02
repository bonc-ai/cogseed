# P3394 Real Execution and Validation Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Turn the existing P3394/KSTAR admission and evidence infrastructure into a verifiable real-execution loop with authoritative session resolution, scoped context reuse receipts, Task Agent/OpenClaw/Codex execution records, Baseline/Treatment comparison, Skill Validator/scanner results, and Review/Patch provenance.

**Architecture:** Keep `P3394Controller` as the admission gate and keep `features/group_chat/bus.ts` as the single dispatch choke point. Add a user-scoped execution-record layer under `local/kstar/executions/` that records the real session, context, permissions, process events, stdout/stderr summaries, result references, and artifact IDs. Add a separate immutable Context Reuse Receipt that is created before execution and completed after execution. Reuse the existing local-agent runner, core-agent runner, KSTAR stdio MCP adapter, quality validator, and evolution patch service rather than creating parallel runners or a second memory of process state.

**Tech Stack:** TypeScript in Electron main, classic Renderer JavaScript, existing IPC shim and `window.orkas.invoke`, JSON/JSONL user-local storage, Vitest through `npm run test:js`, existing `McpConnection` stdio transport, existing `src/main/quality` validator, existing `features/local_agents/runner.ts`, and existing Meta Skill Engine dynamic import/MCP adapter.

---

## Current gaps and acceptance boundary

The current code already provides:

- `P3394Controller` admission, sender-scoped epoch replay detection, and collaboration context ID checks.
- Group Chat bus admission before agent execution.
- KSTAR stdio adapter/factory, evidence recording, pending evidence fallback, Wake-to-Bus KSTAR decision preservation, and KSTAR 7-step Evolution orchestration.
- Local CLI Agent status/events persistence and OpenClaw output parsing.
- Skill quality validation and evolution patch candidate review.

This plan must add the missing end-to-end proof:

1. Session resolution must read the authoritative session-store record/path rather than only parsing a session ID prefix.
2. A real Task Agent/Codex/OpenClaw run must have one durable execution record that links session, context, permission mode, events, output, and artifacts.
3. Baseline and Treatment must be separate real runs with the same input and a persisted comparison.
4. Context reuse must be represented by an immutable receipt, not only prose guidance.
5. Validator and inventory scan findings must be attached to the same execution/review flow with explicit `pass`, `risk`, `blocked`, or `degraded` status.
6. KSTAR/Skill/MCP/Review/Patch results must declare whether they are real, degraded, or test-double results.

The implementation must not add an HTTP server, a second dispatch queue, a second CLI spawn path, a second MCP spawn path, or a new persistent user-data domain.

---

## File map

### Session and receipt layer

- Create `src/main/features/p3394/session-source.ts`: authoritative session resolution built on `model/core-agent/session-store.ts` and existing session-kind rules.
- Create `src/main/features/p3394/context-reuse-receipt.ts`: immutable receipt schema, creation/completion, storage, and bounded redacted summaries.
- Modify `src/main/features/p3394/controller.ts`: consume the authoritative session source and return session-resolution metadata needed by execution records.
- Modify `src/main/features/group_chat/bus.ts`: pass the resolved session/context data into execution-record and receipt hooks at the existing admission/dispatch choke point.
- Modify `src/main/features/p3394/paths.ts` or the existing KSTAR path module: add `local/kstar/executions/`, `events.jsonl`, and receipt paths without introducing module-level uid-derived constants.
- Test in `test/main/features/p3394/session-source.test.ts`, `test/main/features/p3394/context-reuse-receipt.test.ts`, and existing `test/main/features/p3394/controller.test.ts`.

### Execution observability layer

- Create `src/main/features/execution-records.ts`: shared execution record/event types and atomic JSON/JSONL persistence.
- Modify `src/main/features/local_agents/runner.ts`: emit the shared execution lifecycle only through dependency injection/callbacks; preserve the existing CLI spawn path.
- Modify `src/main/features/local_agents/sessions.ts`: expose the persisted CLI session binding for receipt/session linkage without changing CLI ownership.
- Modify `src/main/model/core-agent/runner.ts` or its existing `ChatOptions` callback path: emit the same lifecycle for in-process Core Agent/Codex runs.
- Modify `src/main/features/chat_artifacts.ts` only where needed to attach validated artifact IDs to the execution record; do not widen artifact serving or iframe privileges.
- Test in `test/main/features/execution-records.test.ts`, existing `test/main/features/local_agents/runner.test.ts`, and a new `test/main/features/local_agents/execution-integration.test.ts`.

### Baseline/Treatment and validation layer

- Create `src/main/features/p3394/behavior-contrast.ts`: validates a contrast request, runs the two approved execution modes through existing dispatch entry points, and persists comparison results.
- Create `src/main/features/p3394/skill-validation-run.ts`: wraps `src/main/quality/index.ts` and the existing installed-skill inventory scan into a normalized result used by Review/Patch UI.
- Modify `src/main/features/evolution/evals-store.ts`: store explicit baseline/treatment result references instead of writing `withoutPass: false` as a placeholder.
- Modify `src/main/features/evolution/patch-service.ts`: require the latest validation/contrast status before applying a patch and persist the source execution/run IDs.
- Test in `test/main/features/p3394/behavior-contrast.test.ts`, `test/main/features/p3394/skill-validation-run.test.ts`, `test/main/features/evolution/evals-store.test.ts`, and `test/main/features/evolution/patch-service.test.ts`.

### IPC and Renderer

- Modify `src/main/ipc/index.ts`: add thin handlers for execution records, receipts, contrast runs, validation reports, and patch provenance. Handlers validate IDs and call feature functions only.
- Modify `src/renderer/modules/ipc-shim.js`: add route mappings for the new IPC channels.
- Modify `src/renderer/modules/evolution/pages.js` and `src/renderer/modules/evolution/console.js`: show real/degraded/mock labels, execution state, context receipt, validator findings, and patch provenance.
- Modify `src/renderer/locales/{en,zh,ja,pt}.json`: add visible strings for execution status, receipt fields, validation severity, degraded/mock boundaries, and errors.
- Test in `test/main/ipc/p3394-execution.test.ts`, `test/renderer/p3394-execution-observability.test.ts`, and existing Evolution Renderer tests.

---

### Task 1: Authoritative SessionSource and Context Reuse Receipt

**Files:**
- Create: `src/main/features/p3394/session-source.ts`
- Create: `src/main/features/p3394/context-reuse-receipt.ts`
- Modify: `src/main/features/p3394/controller.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/p3394/paths.ts` or the existing KSTAR path module
- Test: `test/main/features/p3394/session-source.test.ts`
- Test: `test/main/features/p3394/context-reuse-receipt.test.ts`
- Modify: `test/main/features/p3394/controller.test.ts`

- [ ] **Step 1: Write failing SessionSource tests**

Cover a real resumable session, an ephemeral session, an unknown session ID, malformed session JSONL metadata, and a missing session file. The resolver must use the existing `resolveSessionPath(userId, sessionId)` and `sessionKindOf(sessionId)` rules and return a stable shape:

```typescript
export interface ResolvedSession {
  sessionId: string;
  kind: string | null;
  region: 'cloud' | 'local';
  exists: boolean;
  resumable: boolean;
  ownerId?: string;
  source: 'session-store';
}
```

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
npm run test:js -- test/main/features/p3394/session-source.test.ts
```

Expected: FAIL because `session-source.ts` does not exist.

- [ ] **Step 3: Implement the authoritative resolver**

Use `resolveSessionPath(uid, sessionId)` for the path check, `sessionKindOf(sessionId)` for the canonical kind, and `isEphemeralSessionId(sessionId)` for the resumable flag. Do not parse uid from the session ID. Treat a missing file as `exists:false`, but return `valid:false` to the controller for unknown kind or missing session. Do not use the current bus prefix parser as the source of truth.

- [ ] **Step 4: Replace the bus-only session parser dependency**

Change the default `P3394Controller` dependency in `src/main/features/group_chat/bus.ts` to call the new resolver. Keep `actorSessionId(cid, actor)` as the session ID producer; the resolver is responsible for verifying that the produced ID maps to a real store entry. Existing test injection `_setP3394ControllerForTest` remains unchanged.

- [ ] **Step 5: Add receipt schema tests**

Define and test an immutable receipt:

```typescript
export interface ContextReuseReceipt {
  receiptId: string;
  executionId: string;
  sourceSessionId?: string;
  sourceContextId?: string;
  targetSessionId: string;
  targetContextId?: string;
  reusedRefs: string[];
  omittedRefs: string[];
  permissionMode: string;
  allowedScopes: string[];
  baselineExecutionId?: string;
  treatmentExecutionId?: string;
  status: 'prepared' | 'completed' | 'rejected' | 'degraded';
  boundary: 'real' | 'degraded' | 'test-double';
  createdAt: string;
  completedAt?: string;
}
```

Test that creation rejects a target session/context mismatch, deduplicates refs, redacts prompt/token-like values, writes atomically under `local/kstar/executions/<executionId>/context-reuse-receipt.json`, and completion cannot mutate source/target refs.

- [ ] **Step 6: Implement receipt persistence**

Use the existing user-local path helpers and `writeTextAtomicSync`/async equivalent. Do not place receipts under cloud sync. `prepareReceipt()` writes `status:prepared`; `completeReceipt()` writes a new immutable version with only status, completedAt, output/artifact refs, and comparison IDs changed. Reject a second completion or a changed target context.

- [ ] **Step 7: Run GREEN and commit**

```bash
npm run test:js -- \
  test/main/features/p3394/session-source.test.ts \
  test/main/features/p3394/context-reuse-receipt.test.ts \
  test/main/features/p3394/controller.test.ts

git add src/main/features/p3394 src/main/features/group_chat/bus.ts test/main/features/p3394
git commit -m "feat(p3394): resolve real sessions and persist context reuse receipts"
```

---

### Task 2: Shared Execution Records for Core Agent, Codex, and Local Agents

**Files:**
- Create: `src/main/features/execution-records.ts`
- Modify: `src/main/features/local_agents/runner.ts`
- Modify: `src/main/features/local_agents/sessions.ts`
- Modify: `src/main/model/core-agent/runner.ts`
- Modify: `src/main/features/chat_artifacts.ts` only for validated reference attachment
- Test: `test/main/features/execution-records.test.ts`
- Test: `test/main/features/local_agents/execution-integration.test.ts`

- [ ] **Step 1: Write failing execution-record tests**

Test creation, ordered lifecycle events, terminal state, redacted event payloads, oversized output spill references, artifact attachment, and restart-safe read:

```typescript
export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export interface ExecutionRecord {
  executionId: string;
  uid: string;
  kind: 'core-agent' | 'codex' | 'local-agent' | 'openclaw';
  sessionId: string;
  conversationId?: string;
  agentId?: string;
  cli?: string;
  status: ExecutionStatus;
  boundary: 'real' | 'degraded' | 'test-double';
  permissionMode: string;
  contextId?: string;
  receiptId?: string;
  resultRef?: string;
  artifactIds: string[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/main/features/execution-records.test.ts
```

Expected: FAIL because the shared store does not exist.

- [ ] **Step 3: Implement JSON + JSONL storage**

Store one record at:

```text
<uid>/local/kstar/executions/<executionId>/record.json
```

Store append-only events at:

```text
<uid>/local/kstar/executions/<executionId>/events.jsonl
```

Store large output through the existing tool-result spill mechanism or a bounded `output.json` reference. Every event must contain `seq`, `type`, `at`, and redacted metadata; never write raw API keys, OAuth tokens, full prompts, or arbitrary absolute paths.

- [ ] **Step 4: Add runner callbacks without creating a new spawn path**

Add optional lifecycle callbacks to the existing runner options. The local-agent runner remains the only CLI dispatch spawn path. Emit:

```text
queued → started → process/event/tool/output/artifact → terminal
```

For Core Agent, reuse the existing `onProcessEvent` and `onArtifactCreated` callbacks in `src/main/model/core-agent/runner.ts`. For CLI agents, translate existing runner events into the common event vocabulary.

- [ ] **Step 5: Link real CLI session IDs**

When a CLI backend returns a session ID, persist it through `local_agents/sessions.ts` and update the execution record. For Codex/OpenClaw, record the CLI name and returned session ID; do not treat a synthetic local run ID as the external session ID.

- [ ] **Step 6: Link validated artifacts**

When `create_artifact` creates an artifact, attach only `{ cid, artifactId, title }` to the execution record after the existing artifact resolver accepts it. Do not expose arbitrary paths and do not alter iframe sandbox rules.

- [ ] **Step 7: Run GREEN and commit**

```bash
npm run test:js -- \
  test/main/features/execution-records.test.ts \
  test/main/features/local_agents/execution-integration.test.ts \
  test/main/features/local_agents/runner.test.ts \
  test/main/model/core-agent/local-tools.test.ts

git add src/main/features/execution-records.ts src/main/features/local_agents src/main/model/core-agent/runner.ts src/main/features/chat_artifacts.ts test/main/features
git commit -m "feat(execution): persist real agent status logs and artifacts"
```

---

### Task 3: Baseline/Treatment Contrast and Context Reuse Receipt Completion

**Files:**
- Create: `src/main/features/p3394/behavior-contrast.ts`
- Modify: `src/main/features/p3394/context-reuse-receipt.ts`
- Modify: `src/main/features/evolution/evals-store.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/renderer/modules/evolution/pages.js`
- Test: `test/main/features/p3394/behavior-contrast.test.ts`
- Modify: `test/main/features/evolution/evals-store.test.ts`
- Test: `test/main/ipc/p3394-execution.test.ts`

- [ ] **Step 1: Write failing contrast tests**

Use a deterministic injected executor in tests and assert two distinct executions receive the same task input but different context modes:

```typescript
export type ContrastMode = 'baseline' | 'treatment';
export interface BehaviorContrast {
  contrastId: string;
  baselineExecutionId: string;
  treatmentExecutionId: string;
  sameInputHash: string;
  baseline: { status: string; outputHash: string; artifactIds: string[] };
  treatment: { status: string; outputHash: string; artifactIds: string[] };
  changed: boolean;
  receiptId: string;
  boundary: 'real' | 'degraded' | 'test-double';
}
```

Assert baseline has no reused context refs, treatment has the selected refs, and the receipt records both execution IDs.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/main/features/p3394/behavior-contrast.test.ts
```

Expected: FAIL because `behavior-contrast.ts` does not exist.

- [ ] **Step 3: Implement contrast orchestration**

The orchestrator must call the existing dispatch boundary twice, never call the CLI spawn path directly, and pass an explicit `contextMode`. Compute a stable input hash from normalized task text and attachment IDs. Persist the contrast under:

```text
<uid>/local/kstar/executions/contrasts/<contrastId>.json
```

Set `boundary:test-double` only when the injected executor is used by tests; real UI runs must report `real` or `degraded`.

- [ ] **Step 4: Replace placeholder eval fields**

Change `evolution/evals-store.ts` so `withoutPass` is populated from the actual baseline result. Keep `withPass` for treatment compatibility, add `baselineExecutionId`, `treatmentExecutionId`, `contrastId`, and `receiptId`, and set `regression` from the comparison rather than hard-coding `false`.

- [ ] **Step 5: Add IPC and UI read paths**

Add thin handlers:

```text
p3394.execution.list
p3394.execution.read
p3394.contextReuseReceipt.read
p3394.behaviorContrast.start
p3394.behaviorContrast.read
```

The renderer shows baseline/treatment status, output/artifact counts, reused refs, omitted refs, permission mode, and boundary label. No raw prompt or credential is shown.

- [ ] **Step 6: Run GREEN and commit**

```bash
npm run test:js -- \
  test/main/features/p3394/behavior-contrast.test.ts \
  test/main/features/evolution/evals-store.test.ts \
  test/main/ipc/p3394-execution.test.ts \
  test/renderer/p3394-execution-observability.test.ts

git add src/main/features/p3394/behavior-contrast.ts src/main/features/p3394/context-reuse-receipt.ts src/main/features/evolution/evals-store.ts src/main/ipc/index.ts src/renderer/modules/evolution test/main test/renderer
git commit -m "feat(p3394): compare baseline treatment and persist reuse receipts"
```

---

### Task 4: Skill Validator and Inventory Scanner Integration

**Files:**
- Create: `src/main/features/p3394/skill-validation-run.ts`
- Modify: `src/main/quality/index.ts` only if a normalized result export is missing
- Modify: `src/main/features/marketplace.ts` or the existing scanner owner only to expose an inventory scan function; do not duplicate scan logic
- Modify: `src/main/features/evolution/patch-service.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/renderer/modules/evolution/pages.js`
- Test: `test/main/features/p3394/skill-validation-run.test.ts`
- Modify: `test/main/features/evolution/patch-service.test.ts`
- Test: `test/main/ipc/p3394-validation.test.ts`

- [ ] **Step 1: Write failing validation normalization tests**

Normalize existing quality reports into:

```typescript
export type ValidationStatus = 'pass' | 'risk' | 'blocked' | 'degraded';
export interface SkillValidationRun {
  validationId: string;
  skillId: string;
  target: 'working-tree' | 'installed-skill' | 'patch-candidate';
  status: ValidationStatus;
  validatorVersion: string;
  violations: Array<{ level: string; rule: string; path?: string; message: string }>;
  scannedFiles: number;
  boundary: 'real' | 'degraded' | 'test-double';
  createdAt: string;
}
```

Test mapping: no violations → `pass`; only MEDIUM/LOW → `risk`; EXTREME or parse failure → `blocked`; unavailable scanner → `degraded`.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/main/features/p3394/skill-validation-run.test.ts
```

Expected: FAIL because the normalizer does not exist.

- [ ] **Step 3: Reuse quality validator and existing scanner**

Call `validateSkillDir`/`validateAgentDir` from `src/main/quality/index.ts` and the current installed-content scanner used by Marketplace. The new feature only maps results and persists provenance; it must not reimplement red-flag rules or scan files through shell.

- [ ] **Step 4: Attach validation to review and patch candidates**

`listPatchCandidates` returns the latest validation status. `reviewPatchCandidate` rejects approval when status is `blocked`, permits `risk` only with explicit notes, and records `validationId`. `applyPatchToSkill` revalidates the final content before writing and does not apply when the final report is blocked.

- [ ] **Step 5: Add IPC/UI presentation**

Add:

```text
p3394.validation.scan
p3394.validation.read
```

Show status labels `通过 / 风险 / 阻断 / 降级`, violation counts, validator version, scanned file count, and patch candidate association. Keep raw source snippets out of logs and telemetry.

- [ ] **Step 6: Run GREEN and commit**

```bash
npm run test:js -- \
  test/main/features/p3394/skill-validation-run.test.ts \
  test/main/features/evolution/patch-service.test.ts \
  test/main/ipc/p3394-validation.test.ts \
  test/renderer/p3394-execution-observability.test.ts

git add src/main/features/p3394/skill-validation-run.ts src/main/features/marketplace.ts src/main/features/evolution/patch-service.ts src/main/ipc/index.ts src/renderer/modules/evolution test/main test/renderer
git commit -m "feat(p3394): attach validator and inventory scan results"
```

---

### Task 5: Real OpenClaw/Codex/Task Agent Context and Permission Verification

**Files:**
- Modify: `src/main/features/local_agents/runner.ts`
- Modify: `src/main/features/local_agents/backends/openclaw.ts`
- Modify: `src/main/features/local_agents/backends/codex.ts`
- Modify: `src/main/features/local_agents/backends/base.ts`
- Modify: `src/main/features/p3394/session-source.ts`
- Modify: `src/main/features/p3394/context-reuse-receipt.ts`
- Test: `test/main/features/local_agents/openclaw-execution-e2e.test.ts`
- Test: `test/main/features/local_agents/codex-execution-e2e.test.ts`
- Test: `test/main/features/p3394/context-injection.test.ts`

- [ ] **Step 1: Define an explicit launch contract**

The runner receives a prepared execution context:

```typescript
interface PreparedExecutionContext {
  executionId: string;
  sessionId: string;
  contextId?: string;
  prompt: string;
  readOnlyRoots: string[];
  writableRoots: string[];
  permissionMode: string;
  receiptId: string;
}
```

It must pass only the approved context and roots to the existing backend argv/env builders. It must not put raw receipt JSON or secrets into the prompt.

- [ ] **Step 2: Write integration tests with deterministic local fixtures**

Use a local fake executable only through the existing runner injection point. The fixture must emit a session ID, progress event, one tool event, one result, and a terminal event. Assert the persisted execution record, permission mode, receipt completion, and artifact reference. Mark these tests `test-double`; they do not prove the real CLI binary.

- [ ] **Step 3: Add optional real smoke tests**

Add opt-in commands that run only when the relevant binary is available:

```bash
ORKAS_RUN_REAL_OPENCLAW=1 npm run test:js -- test/main/features/local_agents/openclaw-execution-e2e.test.ts
ORKAS_RUN_REAL_CODEX=1 npm run test:js -- test/main/features/local_agents/codex-execution-e2e.test.ts
```

Without the environment variable, tests skip with an explicit reason. With it, assert actual session ID, status events, permission behavior, result collection, and reproducibility hash.

- [ ] **Step 4: Verify permission and context boundaries**

Test that a reused context cannot add a path outside the approved read/write roots, cannot change the target context ID, and cannot bypass the existing local execution permission mode. A denied operation must produce a structured event and a `blocked` result, not a successful receipt.

- [ ] **Step 5: Run GREEN and commit**

```bash
npm run test:js -- \
  test/main/features/local_agents/openclaw-execution-e2e.test.ts \
  test/main/features/local_agents/codex-execution-e2e.test.ts \
  test/main/features/p3394/context-injection.test.ts \
  test/main/features/local_agents/openclaw_parser.test.ts \
  test/main/features/local_agents/runner.test.ts

git add src/main/features/local_agents src/main/features/p3394 test/main/features/local_agents test/main/features/p3394
git commit -m "feat(p3394): verify agent context injection and result recovery"
```

---

### Task 6: Real KSTAR/MCP, Review/Patch Provenance, and Mock Boundary Labels

**Files:**
- Modify: `src/main/features/p3394/kstar-adapter.ts`
- Modify: `src/main/features/p3394/kstar-factory.ts`
- Modify: `src/main/features/p3394/kstar-bus-integration.ts`
- Modify: `src/main/features/evolution/orchestrator-bridge.ts`
- Modify: `src/main/features/evolution/patch-service.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/renderer/modules/evolution/pages.js`
- Modify: `src/renderer/modules/evolution/console.js`
- Test: `test/main/features/p3394/kstar-real-boundary.test.ts`
- Modify: `test/main/features/p3394/kstar-bus-wake-e2e.test.ts`
- Modify: `test/main/features/evolution/e2e-kstar.test.ts`

- [ ] **Step 1: Add boundary metadata to KSTAR calls**

Every KSTAR/evolution result must carry:

```typescript
interface ExecutionBoundary {
  mode: 'real' | 'degraded' | 'test-double';
  provider: 'meta-skill-engine-mcp' | 'core-agent' | 'local-agent' | 'fixture';
  reason?: string;
}
```

`KstarAdapter` reports `real` only after the stdio MCP connection passes protocol initialization. Unavailable engine/pending evidence is `degraded`, and injected test adapters are `test-double`.

- [ ] **Step 2: Persist provenance on evidence and patch candidates**

Add `executionId`, `receiptId`, `validationId`, `contrastId`, and boundary metadata to KSTAR evidence and Patch candidate projections. Existing stable evidence IDs and deduplication remain unchanged.

- [ ] **Step 3: Require review before apply**

A Patch candidate can be approved only when:

```text
KSTAR run exists
→ execution record exists
→ validation status is pass or explicitly accepted risk
→ boundary is real or degraded with reviewer note
→ receipt is completed or explicitly marked degraded
```

A `test-double` result cannot authorize a production patch. `evolution.patches.apply` must revalidate the current file before writing.

- [ ] **Step 4: Add end-to-end real-boundary tests**

Keep existing deterministic KSTAR tests, and add a fixture that exercises the actual `McpConnection` protocol boundary using the local Meta Skill Engine executable when its built output exists. Assert that the UI-facing projection says `real`; when the engine is unavailable, assert `degraded` and pending evidence rather than pretending success.

- [ ] **Step 5: Show Mock/Degraded boundaries in the Evolution UI**

Display:

```text
真实 Engine
降级：Engine 不可用，证据已进入 pending log
测试替身：仅测试结果，不可用于批准 Patch
```

The label must accompany KSTAR run, validation, contrast, and patch candidate data.

- [ ] **Step 6: Run GREEN and commit**

```bash
npm run test:js -- \
  test/main/features/p3394/kstar-real-boundary.test.ts \
  test/main/features/p3394/kstar-bus-wake-e2e.test.ts \
  test/main/features/evolution/e2e-kstar.test.ts \
  test/main/features/evolution/patch-service.test.ts

git add src/main/features/p3394 src/main/features/evolution src/main/ipc/index.ts src/renderer/modules/evolution test/main/features/p3394 test/main/features/evolution
git commit -m "feat(p3394): mark real KSTAR boundaries and patch provenance"
```

---

### Task 7: Operational Runbook and Final Acceptance

**Files:**
- Create: `docs/superpowers/specs/2026-07-31-p3394-real-execution-validation-acceptance.md`
- Create: `scripts/smoke-p3394-real-execution.mjs`
- Modify: `package.json` to add `smoke:p3394`
- Test: `test/scripts/smoke-p3394-real-execution.test.ts`

- [ ] **Step 1: Write the smoke-script contract test**

The script must verify that the current user has:

```text
1. A real resolvable session ID
2. A valid collaboration context ID
3. A prepared receipt
4. A Baseline execution record
5. A Treatment execution record
6. A completed receipt
7. A validator result
8. A KSTAR boundary result
9. At least one result/artifact reference
```

It must fail with a specific missing-contract message and never delete user data.

- [ ] **Step 2: Implement the operator smoke command**

Add:

```json
"smoke:p3394": "node scripts/smoke-p3394-real-execution.mjs"
```

The command reads only the current user-scoped local execution records and prints a redacted summary. It must not start a second HTTP server, mutate branches, upload data, or expose credentials.

- [ ] **Step 3: Write the acceptance runbook**

The runbook must include exact commands:

```bash
npm run typecheck
npm run test:js -- test/main/features/p3394 test/main/features/evolution test/main/features/local_agents
npm run builtin:manifest:check
npm run smoke:p3394
```

It must explain the real OpenClaw/Codex opt-in commands, expected `real/degraded/test-double` labels, storage paths, how to inspect events/artifacts, and how to reproduce a denied-context and blocked-validator case.

- [ ] **Step 4: Run the complete verification gate**

```bash
npm test
npm run typecheck
npm run builtin:manifest:check
git diff --check
npm run smoke:p3394
```

Expected: no test failures; real smoke either passes with `real` boundaries or exits nonzero with an explicit environment prerequisite, never a false success.

- [ ] **Step 5: Commit documentation and final acceptance**

```bash
git add docs/superpowers/specs/2026-07-31-p3394-real-execution-validation-acceptance.md scripts/smoke-p3394-real-execution.mjs package.json test/scripts/smoke-p3394-real-execution.test.ts
git commit -m "docs(p3394): define real execution acceptance and smoke verification"
```

---

## Final verification checklist

Before declaring the work complete, verify each statement with fresh command output:

- `P3394Controller` rejects replay and context scope violations before Agent execution.
- Session metadata comes from `session-store`, not only ID prefix parsing.
- Every real Task Agent/Core Agent/OpenClaw/Codex run has an execution record and ordered events.
- Artifacts are linked by validated `{cid, artifactId}` references.
- Baseline and Treatment are separate executions with the same input hash.
- Context Reuse Receipt is immutable, scope-bound, and visible in the Evolution UI.
- Validator/scanner reports distinguish `pass`, `risk`, `blocked`, and `degraded`.
- Patch approval cannot be authorized solely by a `test-double` result.
- Real KSTAR MCP, degraded KSTAR, and test doubles are visibly distinguishable.
- OpenClaw/Codex real smoke is either proven or explicitly skipped for a named unavailable binary.
- No raw prompts, tokens, credentials, or unredacted expert signal content enters logs or receipts.
- No new HTTP server, port, parallel dispatch path, or unauthorized process spawn was added.

## Plan self-review

- **Coverage:** All six requested outcomes are covered by Tasks 1–6; Task 7 adds an executable acceptance runbook.
- **Boundaries:** P3394 admission remains in the Group Chat bus; CLI spawning remains in `features/local_agents/runner.ts`; MCP spawning remains in `features/connectors/mcp-client.ts`/the existing KSTAR factory; quality scanning reuses `src/main/quality`.
- **Persistence:** Receipts and execution records stay under user-scoped `local/kstar`; user memory and skill assets remain in their existing domains.
- **Placeholder scan:** No TODO/TBD/“implement later” steps are used; every task includes exact files, interfaces, tests, commands, and expected behavior.
- **Risk control:** Test-double paths are explicitly labeled and cannot approve production patches; real smoke tests are opt-in and report missing binary prerequisites instead of pretending success.
