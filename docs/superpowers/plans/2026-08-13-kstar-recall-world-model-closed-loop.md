# KSTAR / Recall World-Model Closed Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Make a confirmed Recall Projection the sole, version-frozen K used by both the pre-execution World Model and Commander, then add bounded K/S/T provenance, scored forecast alternatives, richer ΔA/ΔR reconciliation, and causal learning provenance.

**Architecture:** Keep the existing Electron single-process boundaries: Group Chat Bus remains the only dispatch choke point, Recall owns projection/asset data, KSTAR owns task lifecycle, and the world-model bridge connects them. Move forecasting from preview creation to projection confirmation, persist a typed pending-dispatch state machine, pass one committed projection through Forecast and QueueItem provenance, and keep ordinary non-KSTAR automatic Recall unchanged.

**Tech Stack:** TypeScript, Node/Electron main process, JSON/JSONL storage, Vitest through `node scripts/run-tests.mjs`, in-process `#core-agent` runner with tools disabled.

**Design:** `docs/superpowers/specs/2026-08-13-kstar-recall-world-model-closed-loop-design.md`

---

## File map

### New focused modules

- `src/main/features/kstar/pre-execution-service.ts` — orchestrates projection confirmation, Forecast creation, Requirement binding, pending-dispatch state transitions, retry, and resume.
- `src/main/features/recall/projection-knowledge.ts` — validates a confirmed Projection and loads the exact frozen asset versions as bounded World Model/Commander K.
- `src/main/features/recall/world-model-scoring.ts` — pure candidate validation, deterministic score recomputation, tie-breaking, and selection.
- `src/main/features/recall/world-model-reconciliation.ts` — pure ΔA/ΔR detail computation and evidence-based attribution.

### Existing modules to modify

- `src/main/features/recall/context-projection.ts` — committed Projection invariant and frozen version validation.
- `src/main/features/recall/world-model-types.ts` — bounded K/S/T, candidates, causal links, score, provenance, and reconciliation types.
- `src/main/features/recall/world-model.ts` — multi-candidate parsing/simulation/persistence; delegate scoring/reconciliation to pure modules.
- `src/main/features/kstar/world-model-bridge.ts` — consume committed Projection only and persist full provenance.
- `src/main/features/kstar/requirement-state.ts` — preview only; no pre-confirmation Forecast.
- `src/main/features/kstar/requirement-store.ts` / `requirement-types.ts` — projection/forecast lookup and data validation.
- `src/main/features/group_chat/state.ts` — pending pre-execution state machine.
- `src/main/features/group_chat/bus.ts` — attach projection/forecast provenance to the resumed QueueItem; forbid resume before ready.
- `src/main/features/recall/prompt-injection.ts` — explicit committed Projection path that disables automatic/history projection lookup for KSTAR turns.
- `src/main/ipc/index.ts` — confirmation and retry invoke handlers use the pre-execution orchestrator.
- `src/renderer/modules/recall-projection-card.js` and locales — show Forecast failure and retry without claiming execution started.
- `src/main/features/kstar/types.ts`, `episode-builder.ts`, `task-closure.ts` — actual action trace and Forecast provenance.
- `src/main/features/kstar/review-inference.ts`, `requirement-closure.ts`, `task-aggregate.ts`, `recall-bridge.ts` — richer reconciliation and learning provenance.
- `src/main/features/recall/candidate-service.ts` — persist validated learning provenance; promotion still requires explicit user `causalRule`.

---

## Task 1: Freeze confirmed Projection as a reusable knowledge boundary

**Files:**
- Create: `src/main/features/recall/projection-knowledge.ts`
- Modify: `src/main/features/recall/context-projection.ts`
- Modify: `src/main/features/recall/index.ts`
- Test: `test/main/features/recall/context-projection.test.ts`
- Test: `test/main/features/recall/projection-knowledge.test.ts`

- [ ] **Step 1: Write failing tests for committed Projection invariants**

Add tests that prove:

```ts
it('freezes asset ids and exact versions when a preview is confirmed', async () => {
  const preview = await projection.previewContextProjection(USER, input);
  const confirmed = await projection.confirmContextProjection(USER, preview.id);
  expect(confirmed.status).toBe('confirmed');
  expect(confirmed.assetIds).toEqual(preview.assetIds);
  expect(confirmed.assetVersions).toEqual(preview.assetVersions);
});

it('rejects confirmation when a selected asset version changed', async () => {
  const preview = await projection.previewContextProjection(USER, input);
  await assets.updateAbilityAsset(USER, preview.assetIds[0], {
    statement: 'changed after preview', actor: 'user', reason: 'test drift',
  });
  await expect(projection.confirmContextProjection(USER, preview.id))
    .rejects.toThrow(/projection_asset_version_changed/);
});

it('loads only the exact assets frozen by a confirmed projection', async () => {
  const knowledge = await loadCommittedProjectionKnowledge(USER, confirmed.id);
  expect(knowledge.abilityAssetRefs).toEqual(confirmed.assetIds);
  expect(knowledge.assetVersions).toEqual(confirmed.assetVersions);
  expect(knowledge.abilityAssets.map((asset) => asset.id)).not.toContain(unprojected.id);
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/context-projection.test.ts \
  test/main/features/recall/projection-knowledge.test.ts
```

Expected: FAIL because `loadCommittedProjectionKnowledge` and stable error codes do not exist, and current confirmation can fill missing versions rather than requiring a frozen map.

- [ ] **Step 3: Implement committed Projection validation**

In `context-projection.ts`:

```ts
export function isCommittedProjection(
  projection: ContextProjectionRecord,
): boolean {
  return projection.status === 'confirmed';
}

export async function validateCommittedProjectionAssetVersions(
  userId: string,
  projection: ContextProjectionRecord,
): Promise<Record<string, string>> {
  if (!isCommittedProjection(projection)) throw projectionError('projection_not_committed');
  if (!projection.assetVersions) throw projectionError('projection_versions_missing');
  // Require one and only one frozen version for every assetId.
  // Read each asset, require active, require exact version, and re-check eligibility/source availability.
}
```

Use errors with a `code` property and stable messages:

```ts
function projectionError(code: ProjectionKnowledgeErrorCode): Error & { code: ProjectionKnowledgeErrorCode } {
  return Object.assign(new Error(code), { code });
}
```

`confirmContextProjection` must validate the Preview’s existing `assetVersions`; it must not silently synthesize missing versions for new strong-consistency confirmations.

- [ ] **Step 4: Implement bounded knowledge loading**

In `projection-knowledge.ts`, define:

```ts
export interface CommittedProjectionKnowledge {
  projectionId: string;
  projectionConfirmedAt: string;
  workspaceId?: string;
  abilityAssetRefs: string[];
  abilityAssets: WorldModelAbilityAsset[];
  assetVersions: Record<string, string>;
  rules: WorldModelCausalRuleRef[];
}

export async function loadCommittedProjectionKnowledge(
  userId: string,
  projectionId: string,
): Promise<CommittedProjectionKnowledge>;
```

Load only `projection.assetIds`, require exact versions, truncate `statement` to 2,000 characters, cap assets at 12, cap evidence refs at 20, and generate stable rule refs:

```text
rule:<assetId>:<assetVersion>
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/context-projection.test.ts \
  test/main/features/recall/projection-knowledge.test.ts
npm run typecheck
```

Expected: both test files pass and typecheck exits 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add \
  src/main/features/recall/context-projection.ts \
  src/main/features/recall/projection-knowledge.ts \
  src/main/features/recall/index.ts \
  test/main/features/recall/context-projection.test.ts \
  test/main/features/recall/projection-knowledge.test.ts
git commit -m "feat: freeze committed recall projection knowledge"
```

---

## Task 2: Move Forecast creation after confirmation and block dispatch until ready

**Files:**
- Create: `src/main/features/kstar/pre-execution-service.ts`
- Modify: `src/main/features/kstar/requirement-state.ts`
- Modify: `src/main/features/kstar/requirement-store.ts`
- Modify: `src/main/features/kstar/requirement-types.ts`
- Modify: `src/main/features/group_chat/state.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/ipc/index.ts`
- Test: `test/main/features/kstar/requirement-state.test.ts`
- Test: `test/main/features/kstar/pre-execution-service.test.ts`
- Test: `test/main/features/group_chat/kstar-preview-trigger.test.ts`
- Test: `test/main/ipc/recall.test.ts`

- [ ] **Step 1: Write failing tests for post-confirm Forecast timing**

Add tests proving:

```ts
it('creates only a preview at the task boundary and does not forecast before confirmation', async () => {
  const routed = await routeKstarUserMessage(USER, input);
  expect(routed.projectionPreviewCreated).toEqual({ projectionId: 'proj-a' });
  expect(worldModel.runWorldModelAtBoundary).not.toHaveBeenCalled();
  expect(routed.currentRequirement.forecastId).toBeUndefined();
});

it('keeps pending dispatch when Forecast fails', async () => {
  await expect(confirmProjectionAndPrepareDispatch(USER, { cid, projectionId }))
    .rejects.toMatchObject({ code: 'model_not_configured' });
  expect((await readState(USER, cid)).pending_projection_dispatch).toMatchObject({
    status: 'world_model_failed', projectionId,
  });
  expect(commanderDispatchCount()).toBe(0);
});

it('resumes exactly once after Forecast is persisted', async () => {
  const result = await confirmProjectionAndPrepareDispatch(USER, { cid, projectionId });
  expect(result.forecastId).toMatch(/^wf-/);
  expect(commanderDispatchCount()).toBe(1);
  await expect(retryProjectionForecast(USER, { cid, projectionId }))
    .resolves.toMatchObject({ resumed: false, forecastId: result.forecastId });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar/requirement-state.test.ts \
  test/main/features/kstar/pre-execution-service.test.ts \
  test/main/features/group_chat/kstar-preview-trigger.test.ts \
  test/main/ipc/recall.test.ts
```

Expected: FAIL because Forecast currently runs inside `previewTaskBoundary`, pending dispatch has no status, and confirm IPC resumes directly.

- [ ] **Step 3: Remove Forecast from preview creation**

Change `previewTaskBoundary` to return only:

```ts
Promise<{ projectionId: string; shouldPostCard: boolean } | undefined>
```

Delete the `runWorldModelAtBoundary` call from `requirement-state.ts`. Keep `requirement.projectionId` and append to `projectionIds`; do not set `forecastId` there.

Add Requirement lookup:

```ts
export async function findKstarRequirementByProjection(
  userId: string,
  conversationId: string,
  projectionId: string,
): Promise<KstarRequirementRecord>;
```

Require exactly one match.

- [ ] **Step 4: Add typed pending-dispatch state**

In `group_chat/state.ts`, replace the old shape with:

```ts
pending_projection_dispatch?: {
  projectionId: string;
  requirementId: string;
  taskRunId: string;
  userMessageId: string;
  userMessageText: string;
  status: 'waiting_confirmation' | 'forecasting' | 'world_model_failed' | 'ready_to_dispatch';
  forecastId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};
```

Add one atomic updater:

```ts
export async function updatePendingProjectionDispatch(
  userId: string,
  cid: string,
  update: (current: PendingProjectionDispatch) => PendingProjectionDispatch,
): Promise<StateFile>;
```

Sanitize all new fields when reading state. New previews begin at `waiting_confirmation`.

- [ ] **Step 5: Implement the pre-execution orchestrator**

Create `pre-execution-service.ts` with:

```ts
export async function confirmProjectionAndPrepareDispatch(
  userId: string,
  input: { cid: string; projectionId: string },
): Promise<{
  projection: ContextProjectionRecord;
  forecast: WorldModelForecastRecord;
  resumed: boolean;
}>;

export async function retryProjectionForecast(
  userId: string,
  input: { cid: string; projectionId: string },
): Promise<{ forecast: WorldModelForecastRecord; resumed: boolean }>;
```

Order must be:

```text
validate pending identity
→ confirm/read confirmed Projection
→ pending=forecasting
→ find Requirement
→ runWorldModelAtBoundary(committedProjectionId)
→ persist requirement.forecastId
→ pending=ready_to_dispatch + forecastId
→ resumePendingProjectionDispatch
```

On error, set `world_model_failed` with stable code/message and rethrow. If an already valid Requirement Forecast exists for the same Projection, return it and do not create another Forecast.

- [ ] **Step 6: Make resume require ready state**

`resumePendingProjectionDispatch` must:

```ts
if (pending.status !== 'ready_to_dispatch' || !pending.forecastId) {
  return false;
}
```

Only then clear pending and enqueue the hidden internal dispatch with:

```ts
committedProjectionId: pending.projectionId,
forecastId: pending.forecastId,
kstarTerminalProvenance: {
  logicalRunId: pending.taskRunId,
  projectionId: pending.projectionId,
  forecastId: pending.forecastId,
},
skipKstarRouting: true,
```

Extend `EnqueueParams`, QueueItem, and task-run provenance with `committedProjectionId` / `forecastId` as internal fields; persist only host-approved citations and terminal provenance, not raw pending state.

- [ ] **Step 7: Route confirm and retry IPC through the orchestrator**

Replace direct confirm/resume in `ipc/index.ts`:

```ts
'recall.projections.confirm': async ({ projectionId, cid } = {}, ctx) => {
  if (!safeId(projectionId) || !safeId(cid)) throw new Error('invalid projection confirm');
  return { ok: true, ...(await confirmProjectionAndPrepareDispatch(ctx.userId, { cid, projectionId })) };
},

'recall.projections.retryForecast': async ({ projectionId, cid } = {}, ctx) => {
  if (!safeId(projectionId) || !safeId(cid)) throw new Error('invalid projection retry');
  return { ok: true, ...(await retryProjectionForecast(ctx.userId, { cid, projectionId })) };
},
```

Non-KSTAR projection confirmations without a pending dispatch keep a separate explicit storage-only handler if required by existing Recall screens; do not make `cid` optional for the KSTAR card action.

- [ ] **Step 8: Run tests and typecheck**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar/requirement-state.test.ts \
  test/main/features/kstar/pre-execution-service.test.ts \
  test/main/features/group_chat/kstar-preview-trigger.test.ts \
  test/main/ipc/recall.test.ts
npm run typecheck
```

Expected: all listed tests pass and typecheck exits 0.

- [ ] **Step 9: Commit Task 2**

```bash
git add \
  src/main/features/kstar/pre-execution-service.ts \
  src/main/features/kstar/requirement-state.ts \
  src/main/features/kstar/requirement-store.ts \
  src/main/features/kstar/requirement-types.ts \
  src/main/features/group_chat/state.ts \
  src/main/features/group_chat/bus.ts \
  src/main/ipc/index.ts \
  test/main/features/kstar/requirement-state.test.ts \
  test/main/features/kstar/pre-execution-service.test.ts \
  test/main/features/group_chat/kstar-preview-trigger.test.ts \
  test/main/ipc/recall.test.ts
git commit -m "feat: forecast confirmed projection before dispatch"
```

---

## Task 3: Make Commander use exactly the Forecast Projection

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/recall/prompt-injection.ts`
- Modify: `src/main/features/group_chat/visibility.ts`
- Test: `test/main/features/recall/prompt-injection.test.ts`
- Test: `test/main/features/group_chat/recall-prompt-injection.test.ts`
- Test: `test/main/features/group_chat/kstar-preview-trigger.test.ts`

- [ ] **Step 1: Write failing tests for K equality**

```ts
it('injects only the explicitly committed projection for a KSTAR turn', async () => {
  const context = await buildRecallTurnPromptContext(USER, {
    cid, taskRunId, taskText,
    committedProjectionId: projectionA.id,
  });
  expect(context.citations.every((c) => c.projectionId === projectionA.id)).toBe(true);
  expect(context.citations.map((c) => c.assetId)).toEqual(projectionA.assetIds);
  expect(context.promptBlock).not.toContain(assetFromProjectionB.statement);
});

it('does not create an automatic projection when committedProjectionId is present', async () => {
  await buildRecallTurnPromptContext(USER, { cid, taskRunId, taskText, committedProjectionId });
  expect(createAutomaticContextProjection).not.toHaveBeenCalled();
});

it('rejects injection when the projection version no longer matches', async () => {
  await expect(buildRecallTurnPromptContext(USER, input)).rejects.toThrow(/projection_asset_version_changed/);
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/prompt-injection.test.ts \
  test/main/features/group_chat/recall-prompt-injection.test.ts \
  test/main/features/group_chat/kstar-preview-trigger.test.ts
```

Expected: FAIL because current prompt injection scans message-history projections and creates an automatic Projection.

- [ ] **Step 3: Add the explicit projection path**

Extend `RecallTurnPromptInput` with `committedProjectionId?: string`. When present:

```ts
const knowledge = await loadCommittedProjectionKnowledge(userId, input.committedProjectionId);
return buildPromptContextForCommittedKnowledge(knowledge);
```

Do not call `projectionIdsForConversation` or `createAutomaticContextProjection` in this branch. Build citations from frozen `assetVersions`, not current unvalidated versions.

Keep the existing manual/history + automatic path only when `committedProjectionId` is absent.

- [ ] **Step 4: Thread projection provenance into the worker turn**

Extend QueueItem with:

```ts
committedProjectionId?: string;
forecastId?: string;
```

The resumed dispatch sets these fields. `runTurn` passes `item.committedProjectionId` into `buildRecallTurnPromptContext`. Persisted `recall_citations` remain the execution proof; add `forecast_id?: string` to `RecallMessageCitation` so every citation can be joined to the Forecast.

- [ ] **Step 5: Run tests and typecheck**

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/prompt-injection.test.ts \
  test/main/features/group_chat/recall-prompt-injection.test.ts \
  test/main/features/group_chat/kstar-preview-trigger.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit Task 3**

```bash
git add \
  src/main/features/group_chat/bus.ts \
  src/main/features/group_chat/visibility.ts \
  src/main/features/recall/prompt-injection.ts \
  test/main/features/recall/prompt-injection.test.ts \
  test/main/features/group_chat/recall-prompt-injection.test.ts \
  test/main/features/group_chat/kstar-preview-trigger.test.ts
git commit -m "feat: inject the forecast projection into commander"
```

---

## Task 4: Persist bounded complete K/S/T and Forecast provenance

**Files:**
- Modify: `src/main/features/recall/world-model-types.ts`
- Modify: `src/main/features/recall/world-model.ts`
- Modify: `src/main/features/kstar/world-model-bridge.ts`
- Modify: `src/main/features/kstar/requirement-types.ts`
- Modify: `src/main/features/kstar/requirement-store.ts`
- Test: `test/main/features/recall/world-model.test.ts`
- Test: `test/main/features/kstar/world-model-bridge.test.ts`

- [ ] **Step 1: Write failing tests for full provenance**

```ts
it('builds Forecast K only from bounded committed assets', async () => {
  const record = await runWorldModelAtBoundary(USER, {
    committedProjectionId: confirmed.id, ...boundary,
  }, { runSimulation: fakeSimulation });
  expect(record.projectionId).toBe(confirmed.id);
  expect(record.assetVersions).toEqual(confirmed.assetVersions);
  expect(record.input.k.abilityAssets).toHaveLength(confirmed.assetIds.length);
  expect(record.input.k.abilityAssets[0].statement.length).toBeLessThanOrEqual(2000);
});

it('persists a redacted situation without the real workspace path', async () => {
  expect(JSON.stringify(record.input.s)).not.toContain('/Users/');
  expect(record.input.s.environment.workspaceAvailable).toBe(true);
  expect(record.snapshotId).toBe(record.input.s.snapshotId);
});

it('persists constraints and acceptance criteria from the requirement', async () => {
  expect(record.input.t).toMatchObject({
    constraints: ['Do not change the public API'],
    acceptanceCriteria: ['OAuth test passes'],
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/world-model.test.ts \
  test/main/features/kstar/world-model-bridge.test.ts
```

Expected: FAIL because current K contains IDs only, S contains a path-bearing Snapshot, and Forecast has no projection/version/rule provenance.

- [ ] **Step 3: Define bounded K/S/T and Forecast types**

Implement the exact interfaces from design sections 6.1–6.4 in `world-model-types.ts`, including:

```ts
WorldModelAbilityAsset
WorldModelCausalRuleRef
WorldModelKnowledge
WorldModelSituation
WorldModelTask
WorldModelForecastRecord.projectionId
WorldModelForecastRecord.assetVersions
WorldModelForecastRecord.ruleRefs
WorldModelForecastRecord.snapshotId
```

The Snapshot used by deterministic predicates may keep internal workspace path in memory, but `WorldModelSimulationInput.s` and persisted Forecast must not contain it.

- [ ] **Step 4: Rewrite the bridge around committed knowledge**

`runWorldModelAtBoundary` must:

1. `loadCommittedProjectionKnowledge`.
2. Collect latest environment facts.
3. Build redacted `WorldModelSituation`.
4. Build `WorldModelTask` from `taskText`, `constraints`, and `acceptanceCriteria`.
5. Call `simulateWorld`.
6. Persist Forecast provenance.
7. Throw typed errors; do not catch and return `undefined`.

Inject test seams through an optional final argument rather than mocking module internals:

```ts
interface RunWorldModelDependencies {
  runSimulation?: typeof simulateWorld;
  getWorkspaceAvailability?: (...) => Promise<boolean>;
}
```

- [ ] **Step 5: Validate Forecast records on read**

Add a parser/validator that rejects new Forecasts missing projection/version/snapshot provenance. For compatibility, `readWorldModelForecast` may read legacy records and tag them `provenanceComplete: false`; `requirement-closure` must not auto-learn from incomplete records.

- [ ] **Step 6: Run tests and typecheck**

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/world-model.test.ts \
  test/main/features/kstar/world-model-bridge.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit Task 4**

```bash
git add \
  src/main/features/recall/world-model-types.ts \
  src/main/features/recall/world-model.ts \
  src/main/features/kstar/world-model-bridge.ts \
  src/main/features/kstar/requirement-types.ts \
  src/main/features/kstar/requirement-store.ts \
  test/main/features/recall/world-model.test.ts \
  test/main/features/kstar/world-model-bridge.test.ts
git commit -m "feat: persist bounded world-model knowledge and situation"
```

---

## Task 5: Generate, score, and select multiple Forecast candidates

**Files:**
- Create: `src/main/features/recall/world-model-scoring.ts`
- Modify: `src/main/features/recall/world-model-types.ts`
- Modify: `src/main/features/recall/world-model.ts`
- Test: `test/main/features/recall/world-model-scoring.test.ts`
- Test: `test/main/features/recall/world-model.test.ts`

- [ ] **Step 1: Write failing tests for candidate parsing and local selection**

```ts
it('recomputes total locally instead of trusting model total', () => {
  const candidate = scoreWorldModelCandidate(rawCandidate({ total: 1 }));
  expect(candidate.score.total).toBe(0.55); // fixture-derived exact weight result
});

it('selects highest score then lower risk then higher observability', () => {
  expect(selectWorldModelCandidate(candidates).id).toBe('path-b');
});

it('rejects unknown rule refs and unavailable tools', () => {
  expect(() => validateCandidate(raw, context)).toThrow(/invalid_rule_ref|unavailable_tool/);
});

it('parses two to four candidates and freezes the selected pair', async () => {
  const forecast = await simulateWorld(USER, input, snapshot, { runModel });
  expect(forecast.candidates).toHaveLength(3);
  expect(forecast.aHat).toEqual(selected.aHat);
  expect(forecast.rHat).toEqual(selected.rHat);
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/world-model-scoring.test.ts \
  test/main/features/recall/world-model.test.ts
```

- [ ] **Step 3: Implement pure scoring and validation**

In `world-model-scoring.ts` implement:

```ts
export function recomputeCandidateScore(dimensions): WorldModelCandidateScore;
export function validateWorldModelCandidate(raw, context): WorldModelCandidateForecast;
export function selectWorldModelCandidate(candidates): WorldModelCandidateForecast;
```

Weights:

```ts
const total = clamp01(
  goalFit * 0.35 +
  feasibility * 0.25 +
  observability * 0.20 +
  causalSupport * 0.20 -
  riskPenalty * 0.25,
);
```

Require 2–4 candidates, non-empty plan/result/acceptance signals, maximum field counts, allowed tools, and rule refs from K.

- [ ] **Step 4: Update prompt and parser**

Change the World Model system prompt to the multi-candidate schema. Parse strict JSON only. Save structured `causalLinks` and `assumptions`, never free-form hidden reasoning.

For testability, add:

```ts
interface SimulateWorldOptions {
  runModel?: (input: { systemPrompt: string; message: string }) => Promise<string>;
}
```

Production defaults to the in-process `buildRunner` path.

- [ ] **Step 5: Run tests and typecheck**

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/world-model-scoring.test.ts \
  test/main/features/recall/world-model.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit Task 5**

```bash
git add \
  src/main/features/recall/world-model-scoring.ts \
  src/main/features/recall/world-model-types.ts \
  src/main/features/recall/world-model.ts \
  test/main/features/recall/world-model-scoring.test.ts \
  test/main/features/recall/world-model.test.ts
git commit -m "feat: select scored intervention state forecasts"
```

---

## Task 6: Capture actual Group Chat action traces with Forecast provenance

**Files:**
- Modify: `src/main/features/group_chat/visibility.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/kstar/types.ts`
- Modify: `src/main/features/kstar/episode-builder.ts`
- Modify: `src/main/features/kstar/task-closure.ts`
- Test: `test/main/features/kstar/episode-builder.test.ts`
- Test: `test/main/features/kstar/task-closure.test.ts`
- Test: `test/main/features/group_chat/visibility.test.ts`

- [ ] **Step 1: Write failing tests for actual A capture**

```ts
it('builds group Episode tool calls from persisted process tool events', () => {
  const episode = buildGroupKstarEpisode(inputWithProcessEvents);
  expect(episode.a.toolCalls).toEqual([
    expect.objectContaining({ sequence: 0, actor: 'commander', name: 'read_file', status: 'ok' }),
    expect.objectContaining({ sequence: 1, actor: 'commander', name: 'write_file', status: 'error' }),
  ]);
});

it('preserves projection and forecast provenance in the Episode', () => {
  expect(episode).toMatchObject({
    projectionId: 'proj-a', forecastId: 'wf-a',
    k: { abilityAssetRefs: ['asset-a'] },
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar/episode-builder.test.ts \
  test/main/features/kstar/task-closure.test.ts \
  test/main/features/group_chat/visibility.test.ts
```

- [ ] **Step 3: Extend execution/provenance types**

Add `sequence`, `actor`, and action status fields from the design. Add `forecastId?: string` to Group Message/Task Terminal provenance and `KstarEpisodeRecord`. Add `recall_citations`/process to `GroupKstarMessageInput` only as bounded host-owned data.

- [ ] **Step 4: Parse persisted process tool events**

Extract a pure helper from Bus process parsing so `episode-builder.ts` can recognize:

- `tool_call`
- `tool_result`
- tool name
- bounded argument summary
- Actor
- status
- order

Do not add business logic to IPC. Do not copy raw large tool results into Episode.

- [ ] **Step 5: Bind Episode K to actual citations**

From messages within the terminal run, collect `recall_citations` matching terminal `projectionId + forecastId`; write exact asset IDs into `episode.k.abilityAssetRefs`. Reject/ignore citations from another Projection.

- [ ] **Step 6: Run tests and typecheck**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar/episode-builder.test.ts \
  test/main/features/kstar/task-closure.test.ts \
  test/main/features/group_chat/visibility.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit Task 6**

```bash
git add \
  src/main/features/group_chat/visibility.ts \
  src/main/features/group_chat/bus.ts \
  src/main/features/kstar/types.ts \
  src/main/features/kstar/episode-builder.ts \
  src/main/features/kstar/task-closure.ts \
  test/main/features/kstar/episode-builder.test.ts \
  test/main/features/kstar/task-closure.test.ts \
  test/main/features/group_chat/visibility.test.ts
git commit -m "feat: capture kstar action trace provenance"
```

---

## Task 7: Implement detailed ΔA / ΔR reconciliation and attribution

**Files:**
- Create: `src/main/features/recall/world-model-reconciliation.ts`
- Modify: `src/main/features/recall/world-model-types.ts`
- Modify: `src/main/features/recall/world-model.ts`
- Modify: `src/main/features/kstar/review-inference.ts`
- Modify: `src/main/features/kstar/requirement-closure.ts`
- Test: `test/main/features/recall/world-model-reconciliation.test.ts`
- Test: `test/main/features/recall/world-model.test.ts`
- Test: `test/main/features/kstar/review-inference.test.ts`
- Test: `test/main/features/kstar/requirement-closure.test.ts`

- [ ] **Step 1: Write failing tests for detailed ΔA**

Cover:

```ts
it.each([
  ['missing tool', episodeMissingTool, 'execution_gap'],
  ['failed tool', episodeFailedTool, 'execution_gap'],
  ['wrong actor', episodeWrongActor, 'execution_gap'],
  ['wrong order', episodeWrongOrder, 'execution_gap'],
])('%s gates deltaR', (_name, episode, attribution) => {
  const result = reconcileWorldModel(forecast, episode);
  expect(result.deltaA).not.toBe(0);
  expect(result.deltaR).toBe('unknown');
  expect(result.attribution).toBe(attribution);
});
```

Assert `actionDelta` lists exact missing/unexpected/failed evidence.

- [ ] **Step 2: Write failing tests for acceptance-signal ΔR**

Cover:

```ts
it('marks each acceptance signal met, not_met, or unknown', () => {
  expect(result.resultDelta.acceptanceSignals).toEqual([
    { signal: 'tests pass', status: 'met', evidence: expect.any(String) },
    { signal: 'file exists', status: 'not_met', evidence: expect.any(String) },
    { signal: 'external metric improves', status: 'unknown', evidence: expect.any(String) },
  ]);
});

it('does not use finalText alone as success evidence', () => {
  expect(reconcileWorldModel(forecast, finalTextOnlyEpisode).deltaR).toBe('unknown');
});
```

- [ ] **Step 3: Run tests and verify RED**

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/world-model-reconciliation.test.ts \
  test/main/features/recall/world-model.test.ts \
  test/main/features/kstar/review-inference.test.ts \
  test/main/features/kstar/requirement-closure.test.ts
```

- [ ] **Step 4: Implement pure action reconciliation**

In `world-model-reconciliation.ts`, implement normalized tool/actor/order comparisons and proportional `deltaA`. Argument comparison may use only bounded normalized tokens such as tool target basename and command category; never compare or persist secret values.

- [ ] **Step 5: Implement result reconciliation**

Evaluate acceptance signals in this order:

1. Structured verification fields (`passed`, `ok`, `success`, status values, named checks).
2. Predicted file presence in `producedFiles`.
3. Terminal failure/cancellation.
4. Bounded structured tool outcomes.
5. Unknown.

Calculate `deltaR` only from known signal/file checks. If no check is known, return `unknown`.

- [ ] **Step 6: Implement evidence-based attribution**

Use asset types and rule refs from Forecast K:

```text
deltaA non-zero                       → execution_gap
rule evidence contradicts outcome     → rule_gap
template asset selected and mismatch  → template_gap
skill_method selected and failed      → skill_gap
otherwise known negative deltaR        → knowledge_gap
insufficient evidence                  → unclear
```

Keep model Review only as an optional suggestion for cases the local evidence leaves `unclear`; it cannot override `execution_gap` or invent evidence.

- [ ] **Step 7: Wire Review/Requirement closure**

Persist `actionDelta` and `resultDelta` in Requirement PRM Review. Require complete Forecast provenance before automatic learning. Legacy/incomplete Forecasts produce unknown or require user confirmation.

- [ ] **Step 8: Run tests and typecheck**

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/world-model-reconciliation.test.ts \
  test/main/features/recall/world-model.test.ts \
  test/main/features/kstar/review-inference.test.ts \
  test/main/features/kstar/requirement-closure.test.ts
npm run typecheck
```

- [ ] **Step 9: Commit Task 7**

```bash
git add \
  src/main/features/recall/world-model-reconciliation.ts \
  src/main/features/recall/world-model-types.ts \
  src/main/features/recall/world-model.ts \
  src/main/features/kstar/review-inference.ts \
  src/main/features/kstar/requirement-closure.ts \
  test/main/features/recall/world-model-reconciliation.test.ts \
  test/main/features/recall/world-model.test.ts \
  test/main/features/kstar/review-inference.test.ts \
  test/main/features/kstar/requirement-closure.test.ts
git commit -m "feat: reconcile kstar action and result evidence"
```

---

## Task 8: Preserve causal learning provenance through Candidate and promotion

**Files:**
- Modify: `src/main/features/kstar/types.ts`
- Modify: `src/main/features/kstar/task-aggregate.ts`
- Modify: `src/main/features/kstar/recall-bridge.ts`
- Modify: `src/main/features/recall/candidate-service.ts`
- Modify: `src/main/features/recall/asset-service.ts`
- Test: `test/main/features/kstar/task-aggregate.test.ts`
- Test: `test/main/features/kstar/review-extraction.test.ts`
- Test: `test/main/features/recall/candidate-service.test.ts`
- Test: `test/main/features/recall/asset-service.test.ts`

- [ ] **Step 1: Write failing provenance tests**

```ts
it('does not propose a candidate when Forecast provenance is incomplete', () => {
  expect(proposals).toEqual([]);
});

it('stores Projection Forecast Episode and rule refs on the candidate', async () => {
  expect(candidate.learningProvenance).toMatchObject({
    projectionId: 'proj-a', forecastId: 'wf-a', episodeId: 'kse-a',
    attribution: 'rule_gap', ruleRefs: ['rule:asset-a:1'],
  });
});

it('does not create a causalRule unless promotion explicitly supplies one', async () => {
  const promoted = await promoteRecallCandidate(USER, candidate.id, { actor: 'user' });
  expect(promoted.asset.causalRule).toBeUndefined();
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar/task-aggregate.test.ts \
  test/main/features/kstar/review-extraction.test.ts \
  test/main/features/recall/candidate-service.test.ts \
  test/main/features/recall/asset-service.test.ts
```

- [ ] **Step 3: Add learning provenance types and validators**

Define:

```ts
export interface KstarLearningProvenance {
  projectionId: string;
  forecastId: string;
  episodeId: string;
  ruleRefs: string[];
  attribution: KstarAttribution;
  actionDelta?: ActionDeltaDetail;
  resultDelta?: ResultDeltaDetail;
}
```

Add optional `learningProvenance` to `KstarCandidateProposal`, `RecallCandidateRecord`, and `RecallAbilityAssetRecord`. Validate safe IDs, bounded rule refs, and structured delta details.

- [ ] **Step 4: Gate proposal creation**

`proposalFromRequirement` returns `null` unless:

- Requirement has complete Forecast/Projection/Episode provenance.
- Forecast asset versions match Projection.
- Review has a known learning signal or user-confirmed result.
- Evidence refs are non-empty.

Copy the provenance through `saveKstarCandidateProposals`.

- [ ] **Step 5: Preserve governance on promotion**

Promotion copies `learningProvenance` into the Ability Asset. It creates `causalRule` only when caller explicitly passes a validated `options.causalRule`; no automatic rule activation is introduced.

- [ ] **Step 6: Run tests and typecheck**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar/task-aggregate.test.ts \
  test/main/features/kstar/review-extraction.test.ts \
  test/main/features/recall/candidate-service.test.ts \
  test/main/features/recall/asset-service.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit Task 8**

```bash
git add \
  src/main/features/kstar/types.ts \
  src/main/features/kstar/task-aggregate.ts \
  src/main/features/kstar/recall-bridge.ts \
  src/main/features/recall/candidate-service.ts \
  src/main/features/recall/asset-service.ts \
  test/main/features/kstar/task-aggregate.test.ts \
  test/main/features/kstar/review-extraction.test.ts \
  test/main/features/recall/candidate-service.test.ts \
  test/main/features/recall/asset-service.test.ts
git commit -m "feat: preserve causal recall learning provenance"
```

---

## Task 9: Add user-visible Forecast failure and retry

**Files:**
- Modify: `src/renderer/modules/recall-projection-card.js`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/zh-CN.json`
- Modify: `src/main/locales/en.json`
- Modify: `src/main/locales/zh-CN.json`
- Modify: `src/main/ipc/index.ts`
- Test: `test/renderer/recall-projection-card.test.ts`
- Test: `test/main/ipc/recall.test.ts`

- [ ] **Step 1: Write failing renderer and IPC tests**

Cover:

```ts
it('shows forecast failure and does not show execution as started', async () => {
  invoke.mockRejectedValue(Object.assign(new Error('model configuration is required'), {
    code: 'model_not_configured',
  }));
  await clickConfirm();
  expect(card.textContent).toContain('世界模型预测失败，任务尚未开始');
  expect(dispatchCalls).toHaveLength(0);
});

it('retries the same confirmed projection', async () => {
  await clickRetry();
  expect(invoke).toHaveBeenCalledWith('recall.projections.retryForecast', {
    cid: 'cid-a', projectionId: 'proj-a',
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node scripts/run-tests.mjs run \
  test/renderer/recall-projection-card.test.ts \
  test/main/ipc/recall.test.ts
```

- [ ] **Step 3: Implement renderer state**

On confirm:

- Disable controls while Forecast is running.
- Show localized “Generating execution forecast…” progress.
- On typed failure, keep the card terminal confirmation but show “Forecast failed; task has not started.”
- Show Retry only for retryable model/auth/unavailable failures.
- Do not invoke raw resume IPC.

All visible strings must use locale keys and re-render on `i18n-change` using the existing module pattern.

- [ ] **Step 4: Run tests and typecheck**

```bash
node scripts/run-tests.mjs run \
  test/renderer/recall-projection-card.test.ts \
  test/main/ipc/recall.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit Task 9**

```bash
git add \
  src/renderer/modules/recall-projection-card.js \
  src/renderer/locales/en.json \
  src/renderer/locales/zh-CN.json \
  src/main/locales/en.json \
  src/main/locales/zh-CN.json \
  src/main/ipc/index.ts \
  test/renderer/recall-projection-card.test.ts \
  test/main/ipc/recall.test.ts
git commit -m "feat: surface kstar forecast retry state"
```

---

## Task 10: Full verification and real-environment validation

**Files:**
- Modify only if verification reveals a regression.
- Do not stage the existing untracked DOCX or p3394 wake test files unless separately requested.

- [ ] **Step 1: Run focused KSTAR/Recall/Group Chat suites**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar \
  test/main/features/recall \
  test/main/features/group_chat/kstar-preview-trigger.test.ts \
  test/main/features/group_chat/recall-prompt-injection.test.ts \
  test/renderer/recall-projection-card.test.ts \
  test/main/ipc/recall.test.ts
```

Expected: 0 failed tests.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run full project test command**

```bash
npm test
```

Expected: no new failures compared with the recorded develop baseline. If failures exist, classify each by reproducing on the pre-plan commit rather than assuming it is baseline.

- [ ] **Step 4: Inspect the diff and repository state**

```bash
git diff --check
git status --short
git log --oneline --decorate -15
```

Expected: no whitespace errors; only intended implementation files plus the user’s pre-existing untracked files remain.

- [ ] **Step 5: Restart the messaging runtime**

```bash
scripts/restart-mate.sh
```

Confirm startup from:

```bash
DATE=$(date +%F)
tail -n 200 "$HOME/.cogseed/runtime-variants/messaging/data/logs/$DATE.log"
tail -n 200 /tmp/mate-agent-messaging-run.log
```

Expected: app starts without module/type/runtime initialization errors.

- [ ] **Step 6: Verify the real execution gate**

In the running app:

1. Send a new KSTAR task with at least one matching Recall asset.
2. Verify Preview card appears and Commander does not start.
3. Confirm the card with a configured model.
4. Verify Forecast is saved before the hidden Commander dispatch.
5. Verify Commander citations use the same Projection ID and asset versions.
6. Complete the task and inspect Episode/Review records for Forecast/Projection provenance and detailed ΔA/ΔR.
7. Temporarily use an account/profile without a configured model.
8. Confirm another Projection and verify the UI reports Forecast failure and no Commander turn starts.
9. Restore model configuration and use Retry; verify exactly one Commander turn resumes.

- [ ] **Step 7: Commit any verification-only fixes**

If fixes were necessary:

```bash
git add <only verified fix files>
git commit -m "fix: close kstar world-model verification gaps"
```

If no fixes were necessary, do not create an empty commit.

- [ ] **Step 8: Final verification after the last commit**

```bash
npm run typecheck
node scripts/run-tests.mjs run test/main/features/kstar test/main/features/recall
```

Expected: exit code 0 and no failed tests.

---

## Verification summary

The work is complete only when all of these are evidenced:

```text
Projection confirmed before Forecast
Forecast persisted before Commander dispatch
Forecast K equals Commander K by projectionId + assetVersions
No Forecast means no dispatch
Bounded full K/S/T provenance persists without real OS paths
2–4 candidates are validated, locally scored, and deterministically selected
Group Episode contains actual Actor/tool/order/status evidence
ΔA gates ΔR
Acceptance signals have met/not_met/unknown evidence
Candidate provenance links Projection/Forecast/Episode/rules
Causal Rule activation still requires explicit user promotion input
Focused tests, typecheck, full tests, restart, and real environment checks complete
```

**Next skill:** `$superpower-executing-plans` for inline execution in this already-isolated `dev/remove-p3394-kstar` worktree.
