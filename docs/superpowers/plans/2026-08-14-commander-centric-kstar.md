# Commander-Centric KStar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Make the existing Commander session the only LLM responsible for KStar routing and Forecast candidate generation, while keeping KStar persistence, approval, validation, scoring, recovery, and Marketplace update monotonicity host-enforced.

**Architecture:** User messages always enter the normal Commander turn. A Commander-only `kstar_control` tool performs explicit lifecycle mutations; no tool call means ordinary conversation and therefore zero KStar writes. Projection confirmation resumes the same persistent Commander session with a bounded control envelope, and Forecast candidates submitted by that Commander are validated, rescored, and persisted by the host. Marketplace reconciliation uses one pure comparison policy that permits only monotonic content updates while allowing metadata-only changes.

**Tech Stack:** Electron main process, TypeScript 6, Vitest 4, core-agent `AgentTool`, JSON-file KStar/Recall stores, group-chat persistent sessions, npm packaging scripts.

---

## Scope and File Map

### New focused modules

- `src/main/features/kstar/control-types.ts` — untrusted Commander tool input, structured result/error codes, bounded audit receipt types.
- `src/main/features/kstar/control-service.ts` — host-owned lifecycle transitions, idempotency, Projection binding, Forecast commit, finish, and abandon operations.
- `src/main/features/kstar/control-tool.ts` — Commander-only `AgentTool` wrapper; binds user/conversation/project/model/tool scope outside model-supplied arguments.
- `src/main/features/kstar/commander-context.ts` — reads only the current conversation’s KStar facts and renders the bounded prompt block.
- `src/main/features/kstar/forecast-commit.ts` — prepares frozen K/S/T context, validates Commander candidates, recomputes scores, selects deterministically, and persists the Forecast.
- `src/main/features/kstar/projection-decision-service.ts` — confirms/rejects Projection decisions, resumes the same Commander session, and translates legacy pending dispatch markers.
- `src/main/features/marketplace-update-policy.ts` — pure semantic-version/freshness comparison shared by Agent and Skill reconciliation.

### Existing modules changed

- `src/main/features/group_chat/bus.ts` — remove synchronous pre-router/message withholding; inject context/tool; expose internal Commander continuation.
- `src/main/features/group_chat/state.ts` — keep legacy `pending_projection_dispatch` readable and support idempotent recovery/clearing.
- `src/main/model/client.ts` and `src/main/model/core-agent/client.ts` — expose the resolved Commander model/profile/tool catalog to a host callback after the single runner is built.
- `src/main/prompts/chat_commander.md` — document when to omit/call `kstar_control`, approval behavior, and empty `expectedTools` semantics.
- `src/main/features/kstar/requirement-types.ts` and `requirement-store.ts` — retain schema version 1 while accepting optional bounded control receipts.
- `src/main/features/recall/world-model-scoring.ts` and `world-model.ts` — retain deterministic validation/scoring/storage; remove the independent runner path.
- `src/main/features/kstar/requirement-state.ts` — retain episode/wake attachment helpers but remove automatic user-message routing.
- `src/main/features/kstar/requirement-router.ts` — delete after all active callers and legacy tests are removed.
- `src/main/features/kstar/world-model-bridge.ts` — temporarily delegate callers to host Forecast commit during Task 1, then delete in Task 7 after caller migration.
- `src/main/features/kstar/pre-execution-service.ts` — delete in Task 5 after IPC callers move to `projection-decision-service.ts`.
- `src/main/ipc/index.ts` — wire confirm/reject/retry to the decision service.
- `src/main/features/marketplace_reconcile.ts` — apply monotonic content decision to server catalog updates and disk pull detection.
- `src/main/model/core-agent/client.ts` and `src/main/util/boot_init.ts` — suppress expected cancellation warning and avoid reporting aborted background work as a completed slow task.

### Tests added or rewritten

- `test/main/features/kstar/forecast-commit.test.ts`
- `test/main/features/kstar/control-service.test.ts`
- `test/main/features/kstar/control-tool.test.ts`
- `test/main/features/kstar/commander-context.test.ts`
- `test/main/features/kstar/projection-decision-service.test.ts`
- `test/main/features/group_chat/kstar-commander-centric.test.ts`
- `test/main/features/marketplace-update-policy.test.ts`
- focused updates to existing Recall, IPC, group-chat, Marketplace, client-stream, boot-init, and static architecture tests listed in the tasks below.

---

### Task 1: Accept Tool-Free Candidates and Create the Host Forecast Commit Boundary

**Files:**
- Modify: `src/main/features/recall/world-model-scoring.ts`
- Create: `src/main/features/kstar/forecast-commit.ts`
- Test: `test/main/features/recall/world-model-scoring.test.ts`
- Test: `test/main/features/kstar/forecast-commit.test.ts`
- Modify: `test/main/features/recall/world-model.test.ts`
- Modify: `test/main/features/kstar/world-model-bridge.test.ts`

- [ ] **Step 1: Write the failing collection-semantics tests**

Add tests proving `expectedTools: []` is valid while the field remains mandatory and typed:

```ts
it('accepts a candidate whose expectedTools array is empty', () => {
  const candidate = validCandidate({ expectedTools: [] });
  expect(validateWorldModelCandidate(candidate, context(), 0).aHat.expectedTools).toEqual([]);
});

it.each([
  ['missing', undefined],
  ['not an array', 'read_file'],
  ['malformed item', [42]],
])('rejects expectedTools when %s', (_label, expectedTools) => {
  const candidate = validCandidate();
  if (expectedTools === undefined) delete (candidate as Record<string, unknown>).expectedTools;
  else (candidate as Record<string, unknown>).expectedTools = expectedTools;
  expect(() => validateWorldModelCandidate(candidate, context(), 0))
    .toThrow('invalid_candidate_expected_tools');
});

it('rejects a non-empty unavailable tool', () => {
  expect(() => validateWorldModelCandidate(
    validCandidate({ expectedTools: ['made_up_tool'] }),
    context({ allowedTools: new Set(['read_file']) }),
    0,
  )).toThrow('unavailable_tool:made_up_tool');
});
```

- [ ] **Step 2: Run the focused validator test and verify RED**

Run:

```bash
node scripts/run-tests.mjs run test/main/features/recall/world-model-scoring.test.ts
```

Expected: the empty-array case fails with `invalid_candidate_expected_tools`; the missing/non-array cases continue to fail.

- [ ] **Step 3: Make only `expectedTools` allow an empty array**

Change the intervention validator to use the existing `allowEmpty` parameter only for tools:

```ts
function intervention(
  raw: Record<string, unknown>,
  context: WorldModelCandidateValidationContext,
): WorldModelIntervention {
  const expectedTools = texts(
    raw.expectedTools,
    'expected_tools',
    MAX_TOOLS,
    120,
    true,
  );
  if (context.allowedTools) {
    for (const tool of expectedTools) {
      if (!context.allowedTools.has(tool)) throw new Error(`unavailable_tool:${tool}`);
    }
  }
  return {
    plan: texts(raw.plan, 'plan', MAX_PLAN, 1_000),
    expectedTools,
    expectedActors: texts(raw.expectedActors, 'expected_actors', MAX_ACTORS, 120),
  };
}
```

Do not change non-empty requirements for `plan`, `expectedActors`, or `acceptanceSignals`.

- [ ] **Step 4: Write failing host-commit tests**

Create tests around this contract:

```ts
export interface CommitForecastInput {
  taskRunId: string;
  requirementId: string;
  projectionId: string;
  candidates: unknown[];
  allowedToolNames: ReadonlySet<string>;
  workspaceId?: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
}

export async function commitCommanderForecast(
  userId: string,
  input: CommitForecastInput,
): Promise<WorldModelForecastRecord>;
```

Test all of the following:

```ts
it('requires a confirmed Projection owned by the active Requirement', async () => {
  const seeded = await seedForecastBoundary({ projectionStatus: 'preview' });
  await expect(commitCommanderForecast('user-a', seeded.input))
    .rejects.toMatchObject({ code: 'kstar_projection_not_confirmed' });
  expect(await readAllForecasts('user-a')).toEqual([]);
});

it('accepts candidates, recomputes totals, and keeps tool-free plans', async () => {
  const seeded = await seedForecastBoundary({ projectionStatus: 'confirmed' });
  const first = candidate({
    id: 'path-a',
    expectedTools: [],
    score: { goalFit: 1, feasibility: 1, observability: 1, causalSupport: 1, riskPenalty: 0, total: 0 },
  });
  const second = candidate({ id: 'path-b', expectedTools: ['read_file'] });
  const record = await commitCommanderForecast('user-a', {
    ...seeded.input,
    candidates: [first, second],
    allowedToolNames: new Set(['read_file']),
  });
  expect(record.forecast.candidates[0].aHat.expectedTools).toEqual([]);
  expect(record.forecast.candidates[0].score.total).toBe(1);
  expect(record.forecast.selectedCandidateId).toBe('path-a');
});

it.each([
  ['made_up_tool', 'kstar_unavailable_tool'],
  ['rule:not-frozen', 'kstar_invalid_rule_ref'],
] as const)('maps %s to %s without persisting', async (invalidRef, code) => {
  const seeded = await seedForecastBoundary({ projectionStatus: 'confirmed' });
  const bad = invalidRef.startsWith('rule:')
    ? candidate({ causalLinks: [{ interventionIndex: 0, mechanism: 'x', ruleRefs: [invalidRef], assumptions: [] }] })
    : candidate({ expectedTools: [invalidRef] });
  await expect(commitCommanderForecast('user-a', {
    ...seeded.input,
    candidates: [bad, candidate({ id: 'path-b' })],
    allowedToolNames: new Set(['read_file']),
  })).rejects.toMatchObject({ code });
  expect(await readAllForecasts('user-a')).toEqual([]);
});

it('uses stable modelOrder tie-breaking', async () => {
  const seeded = await seedForecastBoundary({ projectionStatus: 'confirmed' });
  const score = { goalFit: 0.8, feasibility: 0.8, observability: 0.8, causalSupport: 0.8, riskPenalty: 0.2, total: 0 };
  const record = await commitCommanderForecast('user-a', {
    ...seeded.input,
    candidates: [candidate({ id: 'first', score }), candidate({ id: 'second', score })],
    allowedToolNames: new Set(),
  });
  expect(record.forecast.selectedCandidateId).toBe('first');
});
```

- [ ] **Step 5: Run the new host-commit tests and verify RED**

Run:

```bash
node scripts/run-tests.mjs run test/main/features/kstar/forecast-commit.test.ts
```

Expected: module-not-found or missing-export failure for `commitCommanderForecast`.

- [ ] **Step 6: Implement the host Forecast commit service without building a runner**

The implementation must:

```ts
const ERROR_CODES = {
  invalidCandidate: 'kstar_invalid_candidate',
  unavailableTool: 'kstar_unavailable_tool',
  invalidRuleRef: 'kstar_invalid_rule_ref',
  projectionNotConfirmed: 'kstar_projection_not_confirmed',
  persistenceFailed: 'kstar_persistence_failed',
} as const;

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
```

Then:

1. load `loadCommittedProjectionKnowledge(userId, input.projectionId)`;
2. verify the Requirement exists, owns the Projection, and belongs to `taskRunId`;
3. assemble the same bounded K/S/T provenance currently assembled in `world-model-bridge.ts`;
4. compute deterministic risk hits with `applyCausalRules`;
5. require `candidates.length` in `[2, 4]`;
6. validate each candidate with `validateWorldModelCandidate` using `new Set(input.allowedToolNames)` and frozen rule refs;
7. translate `unavailable_tool:*` and `invalid_rule_ref:*` to the stable public codes above;
8. select with `selectWorldModelCandidate`;
9. build and save `WorldModelForecastRecord` with existing `buildWorldModelForecastRecord` and `saveWorldModelForecast`;
10. update the Requirement’s `forecastId` only after Forecast persistence succeeds.

The module must not import `buildRunner`, `chatWithModel`, `streamChatWithModel`, credentials, or provider selection.

- [ ] **Step 7: Run Forecast tests and verify GREEN**

Run:

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/world-model-scoring.test.ts \
  test/main/features/kstar/forecast-commit.test.ts \
  test/main/features/recall/world-model.test.ts \
  test/main/features/kstar/world-model-bridge.test.ts
```

Expected: all listed files pass.

- [ ] **Step 8: Commit Task 1**

```bash
git add \
  src/main/features/recall/world-model-scoring.ts \
  src/main/features/kstar/forecast-commit.ts \
  test/main/features/recall/world-model-scoring.test.ts \
  test/main/features/kstar/forecast-commit.test.ts \
  test/main/features/recall/world-model.test.ts \
  test/main/features/kstar/world-model-bridge.test.ts
git commit -m "feat: add host-validated commander forecasts"
```

---

### Task 2: Add Explicit KStar Control Types, Receipts, and Lifecycle Transitions

**Files:**
- Create: `src/main/features/kstar/control-types.ts`
- Create: `src/main/features/kstar/control-service.ts`
- Modify: `src/main/features/kstar/requirement-types.ts`
- Modify: `src/main/features/kstar/requirement-store.ts`
- Modify: `src/main/features/kstar/index.ts`
- Test: `test/main/features/kstar/control-service.test.ts`
- Modify: `test/main/features/kstar/requirement-store.test.ts`

- [ ] **Step 1: Define and test the untrusted input envelope**

Use this exact public shape:

```ts
export type KstarControlOperation =
  | 'upsert_state'
  | 'request_projection'
  | 'commit_forecast'
  | 'finish'
  | 'abandon';

export interface KstarControlInput {
  operation: KstarControlOperation;
  idempotencyKey: string;
  task?: {
    operation: 'keep' | 'create' | 'update' | 'close';
    taskId?: string;
    title?: string;
    closeReason?: string;
  };
  requirement?: {
    operation: 'keep' | 'create' | 'update' | 'close';
    requirementId?: string;
    goalText?: string;
    expectedResult?: KstarExpectedResult;
  };
  projection?: {
    requirementId: string;
    purpose: string;
    taskText?: string;
  };
  forecast?: {
    taskRunId: string;
    requirementId: string;
    projectionId: string;
    candidates: unknown[];
    constraints?: string[];
    acceptanceCriteria?: string[];
  };
  result?: {
    finalStatus?: 'completed' | 'failed' | 'cancelled';
    finalText?: string;
    producedFiles?: string[];
    acceptanceEvidence?: string[];
    closeReason?: string;
  };
}
```

Define stable results:

```ts
export type KstarControlResult =
  | { ok: true; status: 'state_committed'; taskId: string; requirementId: string; replayed?: boolean }
  | { ok: true; status: 'confirmation_required'; taskId: string; requirementId: string; projectionId: string; replayed?: boolean }
  | { ok: true; status: 'forecast_committed'; taskId: string; requirementId: string; projectionId: string; forecastId: string; selectedCandidateId: string; replayed?: boolean }
  | { ok: true; status: 'finished' | 'abandoned'; taskId: string; requirementId?: string; replayed?: boolean }
  | { ok: false; code: 'kstar_control_invalid_input' | 'kstar_projection_not_confirmed' | 'kstar_invalid_candidate' | 'kstar_unavailable_tool' | 'kstar_invalid_rule_ref' | 'kstar_persistence_failed'; message: string };
```

- [ ] **Step 2: Write failing state-transition and idempotency tests**

Cover:

```ts
it('creates and idempotently replays explicit state', async () => {
  const context = hostContext({ conversationId: 'cid-a', sourceMessageId: 'msg-a' });
  const input = createStateInput({ idempotencyKey: 'turn-a:create' });
  const first = await executeKstarControl(context, input);
  const second = await executeKstarControl(context, input);
  expect(first).toMatchObject({ ok: true, status: 'state_committed' });
  expect(second).toMatchObject({ ok: true, status: 'state_committed', replayed: true });
  expect(await listKstarTasks('user-a')).toHaveLength(1);
  expect(await listKstarRequirements('user-a')).toHaveLength(1);
});

it('rejects an arbitrary task id and conflicting idempotency replay', async () => {
  const context = hostContext({ conversationId: 'cid-a' });
  await expect(executeKstarControl(context, updateStateInput({ taskId: 'kst-other' })))
    .resolves.toMatchObject({ ok: false, code: 'kstar_control_invalid_input' });
  await executeKstarControl(context, createStateInput({ idempotencyKey: 'same-key' }));
  await expect(executeKstarControl(context, abandonInput({ idempotencyKey: 'same-key' })))
    .resolves.toMatchObject({ ok: false, code: 'kstar_control_invalid_input' });
});

it('moves finish into the existing closure pipeline', async () => {
  const seeded = await seedOpenControlState();
  const result = await executeKstarControl(seeded.context, finishInput({ idempotencyKey: 'finish-a' }));
  expect(result).toMatchObject({ ok: true, status: 'finished' });
  expect(await readKstarTask('user-a', seeded.task.id)).toMatchObject({ status: 'closing' });
  expect(await readKstarRequirement('user-a', seeded.requirement.id)).toMatchObject({ status: 'waiting_review' });
});

it('abandons without creating a replacement task', async () => {
  const seeded = await seedOpenControlState();
  await executeKstarControl(seeded.context, abandonInput({ idempotencyKey: 'abandon-a' }));
  expect(await readConversationTaskState('user-a', 'cid-a')).toMatchObject({
    currentTaskId: undefined,
    currentRequirementId: undefined,
    taskComplete: false,
  });
  expect(await listKstarTasks('user-a')).toHaveLength(1);
});
```

- [ ] **Step 3: Run control-service tests and verify RED**

```bash
node scripts/run-tests.mjs run test/main/features/kstar/control-service.test.ts
```

Expected: missing module/exports.

- [ ] **Step 4: Extend schema-version-1 state with bounded receipts**

Add optional receipts without changing `schemaVersion: 1`:

```ts
export interface KstarControlReceipt {
  idempotencyKey: string;
  inputHash: string;
  operation: KstarControlOperation;
  actor: 'commander';
  conversationId: string;
  taskId?: string;
  requirementId?: string;
  projectionId?: string;
  forecastId?: string;
  status: 'ok' | 'rejected' | 'failed';
  result: Exclude<KstarControlResult, { ok: false }> | Extract<KstarControlResult, { ok: false }>;
  createdAt: string;
}

export interface KstarConversationTaskStateRecord extends KstarJsonRecord {
  // existing fields remain unchanged
  controlReceipts?: KstarControlReceipt[];
}
```

Parser rules in `requirement-store.ts`:

- max 100 receipts;
- `idempotencyKey` max 160 characters and restricted to `[A-Za-z0-9_.:-]`;
- `inputHash` exactly 64 lowercase hex characters;
- IDs must pass `safeId`;
- unknown/malformed receipt rows are dropped, not allowed to make legacy state unreadable;
- new writes keep only the most recent 100 receipts.

- [ ] **Step 5: Implement `executeKstarControl` with host-bound scope**

Use a context that cannot be model-supplied:

```ts
export interface KstarControlHostContext {
  userId: string;
  conversationId: string;
  sourceMessageId?: string;
  workspaceId?: string;
  allowedToolNames: ReadonlySet<string>;
  model?: {
    providerId?: string;
    modelId?: string;
    profileId?: string;
    entryId?: string;
  };
  postProjectionCard?: (projectionId: string) => Promise<void>;
}

export async function executeKstarControl(
  context: KstarControlHostContext,
  rawInput: unknown,
): Promise<KstarControlResult>;
```

Implementation rules:

- normalize and bound all strings before hashing;
- hash canonical normalized JSON with SHA-256;
- check an existing receipt before mutation;
- resolve current Task/Requirement from the persisted conversation state;
- never trust a submitted owner/conversation/workspace ID;
- `create` requires no currently open Task unless the submitted task operation closes it in the same transaction;
- `update`/`keep`/`close` IDs must match current persisted IDs;
- `finish` sets Requirement to `waiting_review`, Task to `closing`, `requirementJustClosed`, and `taskComplete: true`; existing closure listeners remain responsible for Episode/Review/Recall derivation;
- `abandon` sets active Requirement/Task to `abandoned`, clears current pointers, and does not create a replacement;
- save a bounded receipt only after the corresponding mutation/result is stable;
- log only operation/result plus masked IDs.

- [ ] **Step 6: Run state and service tests and verify GREEN**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar/control-service.test.ts \
  test/main/features/kstar/requirement-store.test.ts \
  test/main/features/kstar/requirement-closure.test.ts \
  test/main/features/kstar/task-closure.test.ts
```

Expected: all listed files pass and legacy schema-1 fixtures still load.

- [ ] **Step 7: Commit Task 2**

```bash
git add \
  src/main/features/kstar/control-types.ts \
  src/main/features/kstar/control-service.ts \
  src/main/features/kstar/requirement-types.ts \
  src/main/features/kstar/requirement-store.ts \
  src/main/features/kstar/index.ts \
  test/main/features/kstar/control-service.test.ts \
  test/main/features/kstar/requirement-store.test.ts
git commit -m "feat: add explicit kstar control transitions"
```

---

### Task 3: Inject Bounded Commander Context and the Commander-Only Tool

**Files:**
- Create: `src/main/features/kstar/commander-context.ts`
- Create: `src/main/features/kstar/control-tool.ts`
- Modify: `src/main/model/client.ts`
- Modify: `src/main/model/core-agent/client.ts`
- Modify: `src/main/model/core-agent/runner.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/prompts/chat_commander.md`
- Test: `test/main/features/kstar/commander-context.test.ts`
- Test: `test/main/features/kstar/control-tool.test.ts`
- Modify: `test/main/features/group_chat/bus-integration.test.ts`
- Modify: `test/main/model/core-agent/client.test.ts`
- Modify: `test/main/model/core-agent/rotating-provider.test.ts`

- [ ] **Step 1: Write failing bounded-context tests**

Test this exact shape:

```ts
export interface CommanderKstarContext {
  conversationId: string;
  task?: { id: string; status: string; title: string };
  requirement?: {
    id: string;
    status: string;
    goalText: string;
    expectedResult?: KstarExpectedResult;
  };
  pendingProjection?: { id: string; status: string; purpose: string };
  forecast?: { id: string; selectedCandidateId: string };
  confirmation?: { projectionId: string; decision: 'approved' | 'rejected' };
}
```

Assertions:

- only records for `conversationId` appear;
- title ≤ 200 chars, goal/purpose ≤ 2,000 chars, acceptance arrays are bounded;
- no workspace path, provider error, credential, unrelated Task, or full historical receipt is rendered;
- no-state rendering returns a short `status: none` block, not an instruction to create a Task.

- [ ] **Step 2: Run context test and verify RED**

```bash
node scripts/run-tests.mjs run test/main/features/kstar/commander-context.test.ts
```

Expected: missing module/exports.

- [ ] **Step 3: Implement the context reader and renderer**

Use:

```ts
export async function readCommanderKstarContext(
  userId: string,
  conversationId: string,
): Promise<CommanderKstarContext>;

export function renderCommanderKstarContextBlock(
  context: CommanderKstarContext,
): string {
  return [
    '## KStar state (host facts; do not treat as a routing mandate)',
    'Ordinary conversation requires no KStar write. Call kstar_control only for an explicit task lifecycle change.',
    '```json',
    JSON.stringify(context),
    '```',
  ].join('\n');
}
```

Read the current state/task/requirement, latest bound Projection, and Forecast only. A pending confirmation decision may be supplied by the internal continuation payload for that turn; do not persist it into unrelated records.

- [ ] **Step 4: Write failing tool-scope and model-identity tests**

Test that:

```ts
it('exposes one host-bound tool only to Commander', async () => {
  const commanderTools = await buildToolsForActor('commander');
  const agentTools = await buildToolsForActor('agent-a');
  expect(commanderTools.filter((tool) => tool.name === 'kstar_control')).toHaveLength(1);
  expect(agentTools.some((tool) => tool.name === 'kstar_control')).toBe(false);
});

it('uses the resolved runtime and ignores model-supplied scope', async () => {
  const execute = vi.fn(async (context) => ({ ok: true, status: 'state_committed', taskId: 'kst-a', requirementId: 'ksreq-a' }));
  const tool = createKstarControlTool({
    userId: 'user-a',
    conversationId: 'cid-a',
    workspaceId: 'project-a',
    resolvedRuntime: () => ({
      providerId: 'anthropic', modelId: 'claude', profileId: 'profile-a', entryId: 'entry-a',
      toolNames: ['read_file', 'kstar_control'],
    }),
    postProjectionCard: vi.fn(),
    executeControl: execute,
  });
  await tool.execute({ operation: 'commit_forecast', idempotencyKey: 'forecast-a', userId: 'spoof', allowedToolNames: ['made_up'] } as never);
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({
    userId: 'user-a', conversationId: 'cid-a', workspaceId: 'project-a',
    allowedToolNames: new Set(['read_file', 'kstar_control']),
    model: expect.objectContaining({ profileId: 'profile-a', entryId: 'entry-a' }),
  }), expect.anything());
});

it('returns only the structured public error', async () => {
  const tool = controlToolWithResult({ ok: false, code: 'kstar_control_invalid_input', message: 'invalid request' });
  const result = await tool.execute({ operation: 'upsert_state', idempotencyKey: 'bad' });
  expect(result).toEqual({
    content: JSON.stringify({ ok: false, code: 'kstar_control_invalid_input', message: 'invalid request' }),
    isError: true,
  });
  expect(result.content).not.toContain('stack');
});
```

- [ ] **Step 5: Add a runner-resolved host callback to the model contract**

Extend `ChatOptions`:

```ts
export interface ChatResolvedRuntime {
  providerId: string;
  modelId: string;
  profileId?: string;
  entryId?: string;
  toolNames: string[];
}

onResolvedRuntime?: (runtime: ChatResolvedRuntime) => void;
```

Immediately after `buildRunner` resolves and before invoking the runner, publish the initial candidate plus the final tool catalog:

```ts
const publishResolvedRuntime = (runtime: Omit<ChatResolvedRuntime, 'toolNames'>): void => {
  try {
    opts.onResolvedRuntime?.({
      ...runtime,
      toolNames: toolDefs.map((tool) => tool.name),
    });
  } catch (error) {
    log.warn('resolved runtime callback failed', { error: logErrorSummary(error) });
  }
};

publishResolvedRuntime({
  providerId,
  modelId,
  ...(profileId ? { profileId } : {}),
  ...(entryId ? { entryId } : {}),
});
```

Extend `BuildRunnerParams.onCandidateChosen` and the rotating-provider adapter to include the winning `entryId`:

```ts
onCandidateChosen?: (info: {
  profileId: string;
  providerId: string;
  modelId: string;
  entryId?: string;
}) => void;
```

When the rotating provider chooses the candidate that actually owns the request, call `publishResolvedRuntime(info)` before model events/tool calls are delivered. The `kstar_control` resolver therefore observes the real provider/model/profile/entry, not merely the primary candidate. The callback is observational only; it never constructs another runner or re-resolves credentials.

- [ ] **Step 6: Implement the Commander-only `kstar_control` tool**

Add an internal rollout gate in `control-tool.ts`:

```ts
export function isCommanderCentricKstarEnabled(): boolean {
  return process.env.ORKAS_COMMANDER_CENTRIC_KSTAR === '1';
}
```

Task 3 tests set the variable to `1`; production remains on the old path until Task 4 removes pre-routing. Task 4 changes the function to `process.env.ORKAS_COMMANDER_CENTRIC_KSTAR !== '0'`, making Commander-centric behavior the default while retaining a kill switch that does not restore deleted legacy routing.

Factory contract:

```ts
export function createKstarControlTool(options: {
  userId: string;
  conversationId: string;
  sourceMessageId?: string;
  workspaceId?: string;
  resolvedRuntime: () => ChatResolvedRuntime | null;
  postProjectionCard: (projectionId: string) => Promise<void>;
}): AgentTool;
```

Tool schema must expose only the fields from `KstarControlInput`; it must not expose `userId`, `conversationId`, provider credentials, local paths, or an allowed-tools override.

`execute` calls `executeKstarControl` with:

```ts
allowedToolNames: new Set(options.resolvedRuntime()?.toolNames || []),
model: options.resolvedRuntime() || undefined,
```

Return JSON content with `isError: true` only when `result.ok === false`.

- [ ] **Step 7: Wire context and tool into Commander construction**

In `buildCommanderSystemPrompt`, append the rendered KStar fact block before the volatile datetime tail. In `buildCommanderExtraTools`, push `kstar_control` only for the formal Commander path; `space_builder`, named Agents, CLI Agents, and anonymous workers receive none.

Add prompt rules:

```text
- Greetings, thanks, acknowledgements, punctuation-only messages, emoji, and ordinary discussion do not require kstar_control.
- Call kstar_control only when you intend to create, update, close, forecast, finish, or abandon a tracked task.
- request_projection pauses privileged execution until the host reports an approved decision.
- After approval, submit two to four candidates with commit_forecast.
- expectedTools may be [] when no tool is required. Never invent a placeholder tool.
```

- [ ] **Step 8: Run context/tool/model wiring tests and verify GREEN**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar/commander-context.test.ts \
  test/main/features/kstar/control-tool.test.ts \
  test/main/model/core-agent/client.test.ts \
  test/main/features/group_chat/bus-integration.test.ts
```

Expected: all listed files pass; recorded Commander tool definitions include `kstar_control` once and agent definitions do not.

- [ ] **Step 9: Commit Task 3**

```bash
git add \
  src/main/features/kstar/commander-context.ts \
  src/main/features/kstar/control-tool.ts \
  src/main/model/client.ts \
  src/main/model/core-agent/client.ts \
  src/main/model/core-agent/runner.ts \
  src/main/features/group_chat/bus.ts \
  src/main/prompts/chat_commander.md \
  test/main/features/kstar/commander-context.test.ts \
  test/main/features/kstar/control-tool.test.ts \
  test/main/features/group_chat/bus-integration.test.ts \
  test/main/model/core-agent/client.test.ts \
  test/main/model/core-agent/rotating-provider.test.ts
git commit -m "feat: expose kstar control to commander"
```

---

### Task 4: Remove Pre-Commander Routing and Prove Ordinary Conversation Makes Zero Writes

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/kstar/requirement-state.ts`
- Delete: `src/main/features/kstar/requirement-router.ts`
- Delete: `test/main/features/kstar/requirement-router.test.ts`
- Rewrite: `test/main/features/group_chat/kstar-preview-trigger.test.ts` as `test/main/features/group_chat/kstar-commander-centric.test.ts`
- Modify: `test/main/features/kstar/requirement-state.test.ts`
- Modify: `test/static/kstar-single-core.test.ts`

- [ ] **Step 1: Write failing end-to-end routing tests**

Use the programmable Commander stream and a temp workspace. For each ordinary input, script a normal final reply with no tool calls:

```ts
it.each(['你好', '谢谢', '好的', '...', '👍'])('%s reaches Commander and writes no KStar records', async (text) => {
  // enqueue user text, wait for Commander final, inspect chat and KStar directories
});
```

Assert:

- one Commander turn ran;
- the Commander received the original visible text;
- the normal reply persisted;
- no Task, Requirement, Projection, Forecast, or pending projection dispatch was created;
- an already-open Task remains byte-for-byte unchanged when the Commander answers without a control call.

Also test a mixed message:

```ts
it('tracks a mixed greeting and task only when Commander calls kstar_control', async () => {
  // script upsert_state tool call followed by reply; assert records created once
});
```

- [ ] **Step 2: Run the new group-chat test and verify RED**

```bash
node scripts/run-tests.mjs run test/main/features/group_chat/kstar-commander-centric.test.ts
```

Expected: current bus withholds/routes ordinary text and creates KStar state.

- [ ] **Step 3: Delete the synchronous route/gate block from `enqueue`**

Remove all of the following behavior:

- the dynamic import and call of `routeKstarUserMessage`;
- the local `projectionPreviewCreated` gate variable;
- the `to = [USER_ID]` withholding assignment;
- the `setPendingProjectionDispatch` write;
- the `postProjectionCardMessage` call owned by `enqueue`.

User routing remains the ordinary group-chat rule (`user -> Commander` unless the explicit floor/mention chooses another actor). KStar bookkeeping failures can no longer suppress a normal Commander turn because there is no KStar write before that turn.

Enable the new path by changing `isCommanderCentricKstarEnabled` to return true unless `ORKAS_COMMANDER_CENTRIC_KSTAR` is exactly `0`. The disabled state omits `kstar_control`; it never reinstates the deleted router or message gate.

- [ ] **Step 4: Remove automatic routing APIs while retaining attachment helpers**

In `requirement-state.ts`, keep:

```ts
bindKstarRequirementWakeRequest
attachKstarEpisodeToCurrentRequirement
```

Remove:

```ts
KstarUserMessageContext
KstarRouteUserMessageResult
KstarRequirementStateOptions
routeKstarUserMessage
```

Delete `requirement-router.ts` and its tests. Keep `KstarRequirementIntent` in `requirement-types.ts` with a `@deprecated legacy audit vocabulary` comment for schema/source compatibility; no new runtime code may import or write it.

- [ ] **Step 5: Add static architecture assertions**

Update `test/static/kstar-single-core.test.ts` to assert:

```ts
expect(busSource).not.toContain('routeKstarUserMessage');
expect(productionKstarSources).not.toMatch(/buildRunner\s*\(/);
expect(productionKstarSources).not.toMatch(/routeRequirementIntent\s*\(/);
expect(fs.existsSync(requirementRouterPath)).toBe(false);
```

Exclude `review-inference.ts` from this static assertion. The approved scope removes independent turn routing and Forecast generation; the existing post-execution Review inference service remains unchanged and stays covered by `review-inference.test.ts`.

- [ ] **Step 6: Run routing/state/static tests and verify GREEN**

```bash
node scripts/run-tests.mjs run \
  test/main/features/group_chat/kstar-commander-centric.test.ts \
  test/main/features/kstar/requirement-state.test.ts \
  test/main/features/kstar/lifecycle-adapter.test.ts \
  test/main/features/kstar/task-closure.test.ts \
  test/static/kstar-single-core.test.ts
```

Expected: all listed files pass and ordinary messages produce zero KStar writes.

- [ ] **Step 7: Commit Task 4**

```bash
git add -A \
  src/main/features/group_chat/bus.ts \
  src/main/features/kstar/requirement-state.ts \
  src/main/features/kstar/requirement-router.ts \
  test/main/features/group_chat/kstar-preview-trigger.test.ts \
  test/main/features/group_chat/kstar-commander-centric.test.ts \
  test/main/features/kstar/requirement-router.test.ts \
  test/main/features/kstar/requirement-state.test.ts \
  test/static/kstar-single-core.test.ts
git commit -m "refactor: remove pre-commander kstar routing"
```

---

### Task 5: Resume Projection Decisions in the Same Commander Session and Recover Legacy Pending State

**Files:**
- Create: `src/main/features/kstar/projection-decision-service.ts`
- Delete: `src/main/features/kstar/pre-execution-service.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/group_chat/state.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `test/main/ipc/recall.test.ts`
- Create: `test/main/features/kstar/projection-decision-service.test.ts`
- Delete: `test/main/features/kstar/pre-execution-service.test.ts`
- Modify: `test/main/features/recall/context-projection-confirm-wake.test.ts`

- [ ] **Step 1: Write failing approval/rejection/session tests**

Cover:

```ts
it('approves once and resumes the same Commander session', async () => {
  const seeded = await seedPendingProjection({ status: 'preview' });
  const first = await confirmProjectionAndResumeCommander('user-a', { cid: 'cid-a', projectionId: seeded.projection.id });
  const second = await confirmProjectionAndResumeCommander('user-a', { cid: 'cid-a', projectionId: seeded.projection.id });
  expect(first.resumed).toBe(true);
  expect(second.resumed).toBe(false);
  expect(recordedSessionIds).toEqual([buildGconvSessionId('cid-a')]);
});

it('rejects without creating a Forecast', async () => {
  const seeded = await seedPendingProjection({ status: 'preview' });
  await rejectProjectionAndResumeCommander('user-a', { cid: 'cid-a', projectionId: seeded.projection.id, note: 'not now' });
  expect(recordedControlMessages[0]).toMatchObject({ decision: 'rejected', projectionId: seeded.projection.id });
  expect(await readAllForecasts('user-a')).toEqual([]);
});

it.each(['world_model_failed', 'forecasting', 'ready_to_dispatch'] as const)(
  'translates legacy %s into one Commander continuation',
  async (status) => {
    await seedLegacyPending({ status, forecastId: status === 'ready_to_dispatch' ? 'wmf-a' : undefined });
    expect(await recoverLegacyPendingProjectionDispatch('user-a', 'cid-a')).toBe('resumed');
    expect(await recoverLegacyPendingProjectionDispatch('user-a', 'cid-a')).toBe('none');
    expect(runWorldModelMock).not.toHaveBeenCalled();
  },
);

it('leaves legacy waiting_confirmation pending', async () => {
  await seedLegacyPending({ status: 'waiting_confirmation' });
  expect(await recoverLegacyPendingProjectionDispatch('user-a', 'cid-a')).toBe('waiting_confirmation');
  expect(recordedControlMessages).toEqual([]);
});
```

- [ ] **Step 2: Run the decision-service tests and verify RED**

```bash
node scripts/run-tests.mjs run test/main/features/kstar/projection-decision-service.test.ts
```

Expected: missing module/exports.

- [ ] **Step 3: Add a bounded internal Commander continuation adapter**

Expose in `bus.ts`:

```ts
export async function enqueueCommanderControlMessage(input: {
  userId: string;
  cid: string;
  displayText: string;
  control: {
    type: 'kstar_projection_decision';
    projectionId: string;
    decision: 'approved' | 'rejected';
    confirmedSnapshot?: { assetIds: string[]; ruleRefs: string[] };
    legacy?: { requirementId?: string; taskRunId?: string; forecastId?: string; originalText?: string };
  };
}): Promise<void> {
  await enqueue({
    uid: input.userId,
    cid: input.cid,
    fromActorId: USER_ID,
    text: input.displayText,
    model_text: [
      '<kstar-control>',
      JSON.stringify(input.control),
      'Continue in this same Commander session. Do not reclassify the original message. Do not perform privileged execution unless decision is approved.',
      '</kstar-control>',
    ].join('\n'),
    forceTo: [COMMANDER_ID],
    dispatch: true,
    skipKstarRouting: true, // retained temporarily only for legacy callers; becomes dead after Task 7
  });
}
```

The control JSON is bounded and contains no paths, prompt text, credentials, or raw errors.

- [ ] **Step 4: Implement decision and legacy recovery service**

Public API:

```ts
export async function confirmProjectionAndResumeCommander(
  userId: string,
  input: { cid: string; projectionId: string },
): Promise<{ projection: ContextProjectionRecord; resumed: boolean }>;

export async function rejectProjectionAndResumeCommander(
  userId: string,
  input: { cid: string; projectionId: string; note?: string },
): Promise<{ projection: ContextProjectionRecord; resumed: boolean }>;

export async function retryProjectionInCommander(
  userId: string,
  input: { cid: string; projectionId: string },
): Promise<{ projection: ContextProjectionRecord; resumed: boolean }>;

export async function recoverLegacyPendingProjectionDispatch(
  userId: string,
  cid: string,
): Promise<'none' | 'waiting_confirmation' | 'resumed'>;
```

Rules:

- approval uses `confirmContextProjection`, then `loadCommittedProjectionKnowledge` to build `assetIds`/`ruleRefs`;
- no Forecast model is called;
- rejection uses the existing Projection reject operation and resumes with `decision:'rejected'`;
- use a persisted KStar control receipt or a dedicated bounded state marker keyed by `projectionId:decision` to prevent duplicate enqueue;
- `world_model_failed` and `forecasting` legacy states resume Commander with the original text and confirmed Projection context;
- `ready_to_dispatch` includes legacy `forecastId`, clears the marker, and lets Commander continue/synthesize instead of replaying a hidden original turn through a separate path;
- malformed legacy markers remain readable but are not executed; return `none` and log a bounded code.

- [ ] **Step 5: Rewire IPC handlers**

Use:

```ts
'recall.projections.confirm': async ({ projectionId, cid } = {}, ctx) => ({
  ok: true,
  ...(await confirmProjectionAndResumeCommander(ctx.userId, { projectionId, cid })),
}),
'recall.projections.retryForecast': async ({ projectionId, cid } = {}, ctx) => ({
  ok: true,
  ...(await retryProjectionInCommander(ctx.userId, { projectionId, cid })),
}),
'recall.projections.reject': async ({ projectionId, cid, note } = {}, ctx) => ({
  ok: true,
  ...(await rejectProjectionAndResumeCommander(ctx.userId, { projectionId, cid, note })),
}),
```

Preserve the renderer-visible response envelope `{ ok: true, projection, resumed }`. Remove expectations for a Forecast in the confirm response.

- [ ] **Step 6: Invoke idempotent legacy recovery on conversation status/read**

At the group-chat runtime status/read boundary, call `recoverLegacyPendingProjectionDispatch(userId, cid)` best-effort. It must:

- leave `waiting_confirmation` unchanged;
- resume confirmed/failed/ready legacy states once;
- never mutate unrelated user history or current non-KStar tasks;
- never start a new LLM runner itself; it only queues the existing Commander worker.

- [ ] **Step 7: Run decision/IPC/Recall tests and verify GREEN**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar/projection-decision-service.test.ts \
  test/main/features/recall/context-projection-confirm-wake.test.ts \
  test/main/ipc/recall.test.ts \
  test/main/features/group_chat/kstar-commander-centric.test.ts
```

Expected: all listed files pass; tests observe the same Commander session ID and no World Model runner invocation.

- [ ] **Step 8: Commit Task 5**

```bash
git add \
  src/main/features/kstar/projection-decision-service.ts \
  src/main/features/kstar/pre-execution-service.ts \
  src/main/features/group_chat/bus.ts \
  src/main/features/group_chat/state.ts \
  src/main/ipc/index.ts \
  test/main/ipc/recall.test.ts \
  test/main/features/kstar/projection-decision-service.test.ts \
  test/main/features/kstar/pre-execution-service.test.ts \
  test/main/features/recall/context-projection-confirm-wake.test.ts
git commit -m "feat: resume kstar approval in commander session"
```

---

### Task 6: Enforce Approval at Privileged Dispatch and Preserve Terminal Provenance

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/kstar/task-closure.ts`
- Modify: `src/main/features/kstar/episode-builder.ts`
- Modify: `test/main/features/group_chat/bus-integration.test.ts`
- Modify: `test/main/features/kstar/task-closure.test.ts`
- Modify: `test/main/features/kstar/episode-builder.test.ts`

- [ ] **Step 1: Write failing privileged-effect tests**

Test:

```ts
it('blocks privileged dispatch but preserves an ordinary reply while approval is pending', async () => {
  const seeded = await seedControlledConversation({ projectionStatus: 'preview' });
  const result = await callCommanderTool('dispatch_to', { to: 'agent-a', message: 'change files' });
  expect(JSON.parse(result.content)).toMatchObject({ ok: false, error_code: 'kstar_projection_not_confirmed' });
  expect(await runCommanderFinal('I need your approval before execution.')).toContain('approval');
  expect(await readGroupMessages('user-a', seeded.cid)).toContainEqual(expect.objectContaining({ from: 'commander' }));
});

it('stamps verified Projection and Forecast provenance after approval', async () => {
  const seeded = await seedControlledConversation({ projectionStatus: 'confirmed', forecastId: 'wmf-a' });
  await callCommanderTool('dispatch_to', { to: 'agent-a', message: 'perform approved work' });
  expect(recordedTerminalEvent).toMatchObject({
    projection_id: seeded.projection.id,
    forecast_id: 'wmf-a',
    logical_run_id: seeded.task.id,
  });
});

it('keeps finish evidence idempotent for closure capture', async () => {
  const seeded = await seedCompletedControlledRun();
  await finishControlledTask(seeded, { producedFiles: ['report.md'], acceptanceEvidence: ['test passed'] });
  await finishControlledTask(seeded, { producedFiles: ['report.md'], acceptanceEvidence: ['test passed'] });
  expect(await listEpisodes('user-a')).toHaveLength(1);
  expect(await listReviews('user-a')).toHaveLength(1);
  expect((await listEpisodes('user-a'))[0]).toMatchObject({ r: { producedFiles: ['report.md'] } });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node scripts/run-tests.mjs run \
  test/main/features/group_chat/bus-integration.test.ts \
  test/main/features/kstar/task-closure.test.ts \
  test/main/features/kstar/episode-builder.test.ts
```

Expected: at least the new approval guard/provenance assertions fail.

- [ ] **Step 3: Add a host-side approval guard immediately before privileged dispatch**

The guard receives persisted IDs, not model claims:

```ts
async function assertKstarPrivilegedExecutionAllowed(
  userId: string,
  cid: string,
): Promise<{ projectionId?: string; forecastId?: string }> {
  const lifecycle = await readKstarTaskLifecycle(userId, cid);
  if (!lifecycle.requirement?.projectionId) return {};
  if (lifecycle.projection?.status !== 'confirmed') {
    throw Object.assign(new Error('KStar Projection is not confirmed.'), {
      code: 'kstar_projection_not_confirmed',
    });
  }
  if (!lifecycle.requirement.forecastId) {
    throw Object.assign(new Error('KStar Forecast is not committed.'), {
      code: 'kstar_projection_not_confirmed',
    });
  }
  return {
    projectionId: lifecycle.projection.id,
    forecastId: lifecycle.requirement.forecastId,
  };
}
```

Call it in the actual dispatch execution path only when the active KStar control operation marked the proposed action as approval-required. Do not globally block unrelated tools or ordinary chat merely because an old Projection exists.

- [ ] **Step 4: Thread verified provenance through the existing terminal path**

Reuse `kstarTerminalProvenance` and task-run terminal events. The host guard’s verified IDs populate:

```ts
{
  logicalRunId: task.id,
  projectionId,
  forecastId,
}
```

Do not accept these IDs from model tool arguments. Closure capture continues to attach Episodes with `attachKstarEpisodeToCurrentRequirement` and reconciles Forecast/Review with existing services.

- [ ] **Step 5: Run approval/provenance tests and verify GREEN**

```bash
node scripts/run-tests.mjs run \
  test/main/features/group_chat/bus-integration.test.ts \
  test/main/features/kstar/task-closure.test.ts \
  test/main/features/kstar/episode-builder.test.ts \
  test/main/features/kstar/review-inference.test.ts
```

Expected: all listed files pass.

- [ ] **Step 6: Commit Task 6**

```bash
git add \
  src/main/features/group_chat/bus.ts \
  src/main/features/kstar/task-closure.ts \
  src/main/features/kstar/episode-builder.ts \
  test/main/features/group_chat/bus-integration.test.ts \
  test/main/features/kstar/task-closure.test.ts \
  test/main/features/kstar/episode-builder.test.ts
git commit -m "fix: enforce kstar approval before dispatch"
```

---

### Task 7: Remove Independent Router/Forecast Runners and Dead Withholding State

**Files:**
- Modify: `src/main/features/recall/world-model.ts`
- Delete: `src/main/features/kstar/world-model-bridge.ts`
- Modify: `src/main/features/kstar/index.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/group_chat/state.ts`
- Modify: `test/main/features/recall/world-model.test.ts`
- Modify: `test/main/features/kstar/world-model-bridge.test.ts`
- Modify: `test/static/kstar-single-core.test.ts`

- [ ] **Step 1: Write failing no-independent-runner assertions**

Add a static scan over active routing/Forecast production files:

```ts
const forbidden = [
  'src/main/features/kstar/requirement-router.ts',
  'src/main/features/recall/world-model.ts',
  'src/main/features/kstar/world-model-bridge.ts',
];
for (const relative of forbidden) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  expect(source).not.toMatch(/\bbuildRunner\s*\(/);
  expect(source).not.toMatch(/\bchatWithModel\s*\(/);
  expect(source).not.toMatch(/\bstreamChatWithModel\s*\(/);
}
```

Add a model call-count integration test proving one Commander runner build for a task-control turn and one additional build only when the same Commander session is resumed after approval; no `kstar-forecast-*` or router session IDs appear.

- [ ] **Step 2: Run static/integration tests and verify RED**

```bash
node scripts/run-tests.mjs run \
  test/static/kstar-single-core.test.ts \
  test/main/features/group_chat/kstar-commander-centric.test.ts
```

Expected: `world-model.ts` still imports/calls `buildRunner`.

- [ ] **Step 3: Remove the cognitive simulation path from `world-model.ts`**

Keep only host-owned pieces used by the new commit service:

```ts
applyCausalRules
collectWorldSnapshot
saveWorldModelForecast
readWorldModelForecast
buildWorldModelForecastRecord
reconcileWorldModel export
```

Delete:

```ts
forecastSystemPrompt
parseForecastCandidates
SimulateWorldOptions
simulateWorld
buildRunner import
hasConfiguredModel import
```

Update unit tests to exercise `commitCommanderForecast` rather than injecting a fake independent model.

- [ ] **Step 4: Remove dead pre-execution Forecast APIs and flags**

Delete these symbols and their obsolete compatibility modules:

```ts
runWorldModelAtBoundary
confirmProjectionAndPrepareDispatch
retryProjectionForecast
resumePendingProjectionDispatch
skipKstarRouting
committedProjectionId/forecastId fields used only by the withheld-message replay path
```

Retain `committedProjectionId`/`forecastId` only where still required for Recall prompt citations and verified terminal provenance. Remove `pending_projection_dispatch` writes from new runtime code, but keep the state reader and recovery adapter until one release has passed.

- [ ] **Step 5: Run all KStar/Recall/group-chat tests and verify GREEN**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar \
  test/main/features/recall \
  test/main/features/group_chat \
  test/main/features/group-chat \
  test/static/kstar-single-core.test.ts
```

Expected: zero failed tests; no test observes router or Forecast runner session IDs.

- [ ] **Step 6: Commit Task 7**

```bash
git add -A \
  src/main/features/recall/world-model.ts \
  src/main/features/kstar/world-model-bridge.ts \
  src/main/features/kstar/index.ts \
  src/main/features/group_chat/bus.ts \
  src/main/features/group_chat/state.ts \
  test/main/features/recall/world-model.test.ts \
  test/main/features/kstar/world-model-bridge.test.ts \
  test/static/kstar-single-core.test.ts
git commit -m "refactor: remove independent kstar model runners"
```

---

### Task 8: Make Marketplace Agent and Skill Content Updates Monotonic

**Files:**
- Create: `src/main/features/marketplace-update-policy.ts`
- Modify: `src/main/features/marketplace_reconcile.ts`
- Test: `test/main/features/marketplace-update-policy.test.ts`
- Modify: `test/main/features/marketplace_reconcile.test.ts`

- [ ] **Step 1: Write failing pure policy tests**

Define:

```ts
export type MarketplaceContentDecision =
  | { action: 'replace_content'; reason: 'newer_version' | 'newer_freshness' }
  | { action: 'preserve_content'; reason: 'older_version' | 'stale_freshness' | 'unparsable_version' };

export function decideMarketplaceContentUpdate(
  local: { version: string; published_at: number; updated_at?: number },
  server: { version: string; published_at: number; updated_at?: number },
): MarketplaceContentDecision;
```

Test this matrix for both Agent and Skill callers:

```ts
it.each([
  ['1.0.3', 100, '1.0.4', 90, 'replace_content', 'newer_version'],
  ['1.0.4', 100, '1.0.4', 101, 'replace_content', 'newer_freshness'],
  ['1.0.4', 100, '1.0.3', 999, 'preserve_content', 'older_version'],
  ['1.0.4', 100, '1.0.4', 100, 'preserve_content', 'stale_freshness'],
  ['1.0.4', 100, '1.0.4', 99, 'preserve_content', 'stale_freshness'],
  ['custom-a', 100, 'custom-b', 200, 'preserve_content', 'unparsable_version'],
] as const)(
  'local %s@%s versus server %s@%s -> %s/%s',
  (localVersion, localFreshness, serverVersion, serverFreshness, action, reason) => {
    expect(decideMarketplaceContentUpdate(
      { version: localVersion, published_at: localFreshness },
      { version: serverVersion, published_at: serverFreshness },
    )).toEqual({ action, reason });
  },
);
```

Also cover `v1.2.3`, prerelease ordering, and `updated_at ?? published_at` freshness fallback.

- [ ] **Step 2: Run policy tests and verify RED**

```bash
node scripts/run-tests.mjs run test/main/features/marketplace-update-policy.test.ts
```

Expected: missing module/exports.

- [ ] **Step 3: Implement strict semantic comparison**

Use a small local parser rather than an undeclared transitive dependency:

```ts
interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
```

Comparison rules follow SemVer precedence: numeric major/minor/patch, release > prerelease, numeric prerelease identifiers < non-numeric identifiers, then identifier count. Unequal strings that do not both parse return `unparsable_version`; exact equal strings may still compare freshness.

- [ ] **Step 4: Write failing reconcile tests for downgrade and metadata-only updates**

Add Agent and Skill cases:

```ts
it.each(['agent', 'skill'] as const)('does not downgrade %s content', async (kind) => {
  const seeded = await seedInstalledMarketplaceItem(kind, { version: '1.0.4', updated_at: 100 });
  serverCatalog.set(seeded.id, { version: '1.0.3', published_at: 1, updated_at: 999, status: 'approved' });
  await reconcileInstalls('u1');
  expect(await readInstalledContent(kind, seeded.id)).toBe(seeded.content);
  expect(await readInstallVersion(kind, seeded.id)).toEqual({ version: '1.0.4', freshness: 100 });
});

it('applies metadata-only changes while preserving content fields', async () => {
  const seeded = await seedInstalledMarketplaceItem('agent', { version: '1.0.4', updated_at: 100, status: 'draft' });
  serverCatalog.set(seeded.id, {
    version: '1.0.3', published_at: 1, updated_at: 999,
    status: 'approved', default_install: true, min_app_version: '2.0.0',
  });
  await reconcileInstalls('u1');
  expect(await readAgentInstall(seeded.id)).toMatchObject({
    version: '1.0.4', updated_at: 100, status: 'approved', default_install: true, min_app_version: '2.0.0',
  });
});

it('pulls a same-version newer republish exactly once', async () => {
  const seeded = await seedInstalledMarketplaceItem('skill', { version: '1.0.4', updated_at: 100 });
  serverCatalog.set(seeded.id, { version: '1.0.4', published_at: 1, updated_at: 101 });
  await reconcileInstalls('u1');
  expect(bundleRequestsFor(seeded.id)).toHaveLength(1);
  expect(await readInstallVersion('skill', seeded.id)).toEqual({ version: '1.0.4', freshness: 101 });
});

it('skips unparsable unequal versions with a bounded log', async () => {
  const seeded = await seedInstalledMarketplaceItem('skill', { version: 'custom-a', updated_at: 100 });
  serverCatalog.set(seeded.id, { version: 'custom-b', published_at: 1, updated_at: 200 });
  await reconcileInstalls('u1');
  expect(bundleRequestsFor(seeded.id)).toEqual([]);
  expect(logger.info).toHaveBeenCalledWith('marketplace content update skipped', expect.objectContaining({ reason: 'unparsable_version' }));
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain(seeded.absolutePath);
});
```

- [ ] **Step 5: Apply the same decision helper to catalog update and needs-pull paths**

In the server catalog update loop:

```ts
const decision = decideMarketplaceContentUpdate(a, server);
const contentChanged = decision.action === 'replace_content';
const nextContent = contentChanged
  ? { version: server.version, published_at: server.published_at, updated_at: server.updated_at }
  : { version: a.version, published_at: a.published_at, updated_at: a.updated_at };
```

Apply the identical code path for Skills. Non-content fields (`default_install`, status, min app version, Agent private-skills URL) may update while `nextContent` preserves local fields. `_agentNeedsPull` and `_skillNeedsPull` must return true only for `replace_content` or genuinely missing/changed dependent content; an older server row must never cause a pull.

Log:

```ts
log.info('marketplace content update skipped', {
  kind: 'agent' | 'skill',
  id: maskId(id),
  reason: decision.reason,
});
```

Do not log local paths or full metadata documents.

- [ ] **Step 6: Run policy and reconcile tests and verify GREEN**

```bash
node scripts/run-tests.mjs run \
  test/main/features/marketplace-update-policy.test.ts \
  test/main/features/marketplace_reconcile.test.ts \
  test/main/features/marketplace_installs.test.ts \
  test/main/features/builtin_marketplace.test.ts
```

Expected: all listed files pass; downgrade fixtures preserve local `version` and freshness for both kinds.

- [ ] **Step 7: Commit Task 8**

```bash
git add \
  src/main/features/marketplace-update-policy.ts \
  src/main/features/marketplace_reconcile.ts \
  test/main/features/marketplace-update-policy.test.ts \
  test/main/features/marketplace_reconcile.test.ts
git commit -m "fix: prevent marketplace content downgrades"
```

---

### Task 9: Remove Benign Cancellation and Aborted-Task Warning Noise

**Files:**
- Modify: `src/main/model/core-agent/client.ts`
- Modify: `src/main/util/boot_init.ts`
- Test: `test/main/model/core-agent/client.test.ts`
- Create or modify: `test/main/util/boot-init.test.ts`

- [ ] **Step 1: Write failing stream-return logging tests**

Test `stopStreamOnAbort`:

```ts
it('does not warn for expected return cleanup after completion', async () => {
  const controller = new AbortController();
  const events = asyncIterable({ values: ['final'], returnError: Object.assign(new Error('closed'), { name: 'AbortError' }) });
  expect(await collect(stopStreamOnAbort(events, controller.signal, 'test'))).toEqual(['final']);
  controller.abort();
  await flushPromises();
  expect(logger.warn).not.toHaveBeenCalledWith('abortable stream return failed', expect.anything());
});

it('warns for an unexpected active-stream return failure', async () => {
  const controller = new AbortController();
  const events = blockingAsyncIterable({ returnError: new Error('cleanup broke') });
  const pending = collect(stopStreamOnAbort(events, controller.signal, 'test'));
  controller.abort();
  await pending;
  await flushPromises();
  expect(logger.warn).toHaveBeenCalledWith('abortable stream return failed', expect.objectContaining({ label: 'test' }));
});
```

Track whether the iterator returned `done: true` or the consumer observed a terminal event before abort cleanup.

- [ ] **Step 2: Write failing boot task timing tests**

Test:

```ts
it('logs slow only for completed tasks', async () => {
  vi.setSystemTime(0);
  await runBootTaskForTest('completed', async () => { vi.setSystemTime(SLOW_WARN_MS + 1); });
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('task slow'));

  logger.warn.mockClear();
  const controller = new AbortController();
  await runBootTaskForTest('aborted', async (signal) => {
    controller.abort();
    vi.setSystemTime(SLOW_WARN_MS + 1);
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }, { signal: controller.signal });
  expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('task slow'));
});

it('uses slice exceeded as the single warning for a slice abort', async () => {
  await runBootTaskForTest('slice', waitForAbort, { maxSliceMs: 10 });
  expect(logger.warn.mock.calls.filter(([message]) => String(message).includes('task slice exceeded'))).toHaveLength(1);
  expect(logger.warn.mock.calls.some(([message]) => String(message).includes('task slow'))).toBe(false);
});
```

- [ ] **Step 3: Run log tests and verify RED**

```bash
node scripts/run-tests.mjs run \
  test/main/model/core-agent/client.test.ts \
  test/main/util/boot-init.test.ts
```

Expected: current code warns on `iterator.return` rejection and reports aborted work as slow.

- [ ] **Step 4: Suppress only expected cleanup failures**

In `stopStreamOnAbort`, treat `AbortError`, an already-aborted signal, or cleanup after a completed iterator as expected. Keep warnings for unexpected errors while the stream is otherwise active. The warning payload remains redacted with `logErrorSummary`.

- [ ] **Step 5: Report slow only for completed background tasks**

Track:

```ts
let completed = false;
let aborted = false;
try {
  await Promise.resolve(t.fn(controller.signal));
  completed = !controller.signal.aborted && !t.signal?.aborted;
} catch (err) {
  aborted = controller.signal.aborted
    || t.signal?.aborted === true
    || (err as Error)?.name === 'AbortError';
  if (!aborted) {
    log.warn(`task threw phase=${phase} name=${t.name}: ${(err as Error).message}`);
  }
} finally {
  if (sliceTimer) clearTimeout(sliceTimer);
  t.signal?.removeEventListener('abort', abortFromTask);
}
const ms = Date.now() - t0;
if (completed && ms > SLOW_WARN_MS) {
  log.warn(`task slow phase=${phase} name=${t.name} ms=${ms}`);
}
```

The `task slice exceeded` warning remains the single warning for slice-driven aborts.

- [ ] **Step 6: Run log tests and verify GREEN**

```bash
node scripts/run-tests.mjs run \
  test/main/model/core-agent/client.test.ts \
  test/main/util/boot-init.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 7: Commit Task 9**

```bash
git add \
  src/main/model/core-agent/client.ts \
  src/main/util/boot_init.ts \
  test/main/model/core-agent/client.test.ts \
  test/main/util/boot-init.test.ts
git commit -m "fix: silence expected runtime cancellation logs"
```

---

### Task 10: Full Verification, Packaging, and Live Acceptance

**Files:**
- Verify with: `scripts/package-dev-mac.cjs`
- Verify with: `scripts/verify-packaged-dev.cjs`
- Verify: `docs/superpowers/specs/2026-08-14-commander-centric-kstar-design.md` already says `Approved`
- Add no feature code in this task. Any failure returns to the owning task, begins with a new failing test, and receives a separate fix commit.

- [ ] **Step 1: Verify the approved design status**

Run:

```bash
rg -n '^\*\*Status:\*\* Approved$' docs/superpowers/specs/2026-08-14-commander-centric-kstar-design.md
```

Expected: exactly one matching line. Do not alter design decisions during verification without returning to brainstorming/design review.

- [ ] **Step 2: Run focused suites**

```bash
node scripts/run-tests.mjs run \
  test/main/features/kstar \
  test/main/features/recall \
  test/main/features/group_chat \
  test/main/features/group-chat \
  test/main/features/marketplace-update-policy.test.ts \
  test/main/features/marketplace_reconcile.test.ts \
  test/main/ipc/recall.test.ts \
  test/static/kstar-single-core.test.ts
```

Expected: exit 0, zero failed tests.

- [ ] **Step 3: Run complete JavaScript and resource suites**

```bash
npm run test:js
npm run test:resources
```

Expected: both commands exit 0.

- [ ] **Step 4: Run type, manifest, branch, and diff checks**

```bash
npm run typecheck
npm run builtin:manifest:check
npm run audit:branch
git diff --check
```

Expected: all commands exit 0 and `git diff --check` prints nothing.

- [ ] **Step 5: Build and verify the macOS development package**

```bash
npm run package:dev:mac
npm run verify:package:dev:mac
```

Expected: package creation and packaged launch smoke exit 0. Capture the generated `.app` path and verification log path for the final report.

- [ ] **Step 6: Perform live log acceptance**

Run the packaged app with a clean test user/workspace and capture bounded logs for these four flows:

1. `你好` — normal Commander reply; no Task/Requirement/Projection/Forecast files.
2. `请分析这个项目并给出修复计划` — Commander calls `upsert_state`; Task/Requirement appear.
3. Commander calls `request_projection`; user approves — the next turn uses the same `gconv` session and no `kstar-forecast-*` session appears.
4. Commander submits a valid Forecast with `expectedTools: []` — host persists it and execution/closure provenance includes Projection + Forecast IDs.

Also verify startup reconciliation with local `1.0.4` and server `1.0.3` keeps local Agent and Skill content/version/freshness.

Expected log properties:

```text
kstar.control operation=<op> result=<ok|rejected|failed> cid=<redacted> task=<redacted>
```

No full user text, prompt, absolute path, credentials, or raw provider error is present. No benign `abortable stream return failed` warning appears after normal stream completion, and no aborted boot task is reported as `task slow`.

- [ ] **Step 7: Review branch diff against `develop`**

```bash
git status --short --branch
git diff --stat develop...HEAD
git diff --name-status develop...HEAD
git log --oneline --decorate develop..HEAD
```

Expected: only design/plan and files named in this plan, plus test-driven fixes discovered during verification.

---

## Verification Matrix

| Requirement | Primary proof |
|---|---|
| Ordinary chat creates zero KStar records | `kstar-commander-centric.test.ts` greeting/thanks/ack/punctuation/emoji cases |
| Commander is the only routing/Forecast LLM | static no-runner scan + recorded session IDs/model call counts |
| Same provider/model/profile/tool scope | `onResolvedRuntime` test and control-tool bound context test |
| Explicit state mutation only | `control-service.test.ts` create/update/close/idempotency cases |
| Projection remains host-approved | decision-service + privileged dispatch guard tests |
| Confirmation resumes same session | group-chat recorded `buildGconvSessionId(cid)` calls |
| Tool-free Forecast valid | scoring + forecast-commit tests with `expectedTools: []` |
| Invalid candidate/tool/rule errors remain distinct | forecast-commit error-code tests |
| Legacy pending state readable/recoverable | decision-service legacy matrix |
| Existing Episode/Review/Recall closure preserved | task-closure/episode/review suites |
| Marketplace never downgrades content | pure policy + Agent/Skill reconcile tests |
| Benign warnings removed without hiding real errors | client abort + boot-init timing tests |
| Packaged runtime works | `package:dev:mac`, `verify:package:dev:mac`, live four-flow log acceptance |

## Rollback Boundaries

- Each task ends in an independently revertible commit.
- Task 3 enables the new tool only when `ORKAS_COMMANDER_CENTRIC_KSTAR=1`; Task 4 flips the default so only exact `0` disables it.
- The kill switch disables new `kstar_control` injection only; it must not re-enable the deleted pre-router or independent Forecast runner.
- Legacy state readers remain for one compatibility release even after new writes stop.

## Next Skill

Use `$superpower-executing-plans` for inline execution in this task, or `$superpower-subagents` only if the user explicitly authorizes subagent-driven implementation.
