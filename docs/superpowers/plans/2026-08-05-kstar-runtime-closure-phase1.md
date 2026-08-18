# KSTAR Runtime Closure Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Persist evidence-backed KSTAR episodes for Mate Agent Runtime and group-chat task runs, create conservative post-task reviews, and bridge only reviewable learning proposals into pending Recall candidates.

**Architecture:** Add a user-scoped `features/kstar/` protocol layer under `<uid>/cloud/kstar/`. Runtime and group-chat completion hooks pass bounded execution facts into one idempotent closure service; storage and extraction stay outside IPC and renderer code. Recall remains the only candidate/AbilityAsset lifecycle, and promotion remains an explicit existing user action.

**Tech Stack:** Electron main process, Node.js/TypeScript, JSON storage helpers, group-chat terminal event bus, Vitest through `npm run test:js` / `npm test`.

---

## File map

**Create**
- `src/main/features/kstar/types.ts` — schema v1 DTOs for episodes, reviews, extraction runs, and capture inputs.
- `src/main/features/kstar/paths.ts` — safe cloud-domain KSTAR paths resolved from `userId` at call time.
- `src/main/features/kstar/episode-store.ts` — validated, idempotent JSON record persistence and degraded listing.
- `src/main/features/kstar/episode-builder.ts` — pure Runtime/group-chat fact normalization into K/S/T/A/R.
- `src/main/features/kstar/review-service.ts` — conservative initial review and explicit review persistence.
- `src/main/features/kstar/extraction-service.ts` — bounded deterministic candidate proposal policy.
- `src/main/features/kstar/recall-bridge.ts` — pending-only mapping through `saveRecallCandidate`.
- `src/main/features/kstar/task-closure.ts` — orchestration and non-fatal group terminal subscription.
- `src/main/features/kstar/index.ts` — public feature exports.
- `test/main/features/kstar/episode-store.test.ts`
- `test/main/features/kstar/episode-builder.test.ts`
- `test/main/features/kstar/review-extraction.test.ts`
- `test/main/features/kstar/task-closure.test.ts`

**Modify**
- `src/main/features/cogseed_runtime/index.ts` — collect bounded run events and invoke KSTAR closure after terminal persistence without changing the result stream.
- `test/main/features/cogseed_runtime/facade.test.ts` — prove completed/failed capture and non-fatal capture errors.
- `src/main/index.ts` — start and stop the group terminal KSTAR subscriber beside the existing terminal notification subscriber.

## Design decisions locked by this plan

1. Record IDs are derived from the upstream run id when available (`kse-<runId>`, `ksr-<episodeId>`, `ksx-<episodeId>`), making retries idempotent.
2. `r.status` is stored as `completed | failed | cancelled | waiting_input` so successful, failed, and interrupted runs are distinguishable without inferring from text.
3. Automatic reviews are deliberately conservative: missing expectation/verification evidence yields `outcome: unclear`, `attribution: unclear`, and unknown deltas.
4. Automatic extraction emits at most three proposals and normally emits none. A successful multi-tool workflow or an explicit high-confidence review gap is required.
5. Recall evidence uses the existing source taxonomy with `{ kind: 'execution', id: episode.id }`; no new Recall source kind is introduced.
6. The bridge calls `saveRecallCandidate` only. It never calls `promoteRecallCandidate`.
7. Capture errors are logged as warnings and swallowed after the user-visible task terminal event/run metadata has been persisted.

---

### Task 1: KSTAR schema, paths, and validated record store

**Files:**
- Create: `src/main/features/kstar/types.ts`
- Create: `src/main/features/kstar/paths.ts`
- Create: `src/main/features/kstar/episode-store.ts`
- Test: `test/main/features/kstar/episode-store.test.ts`

- [x] **Step 1: Write failing store tests**

Cover write/read, idempotent retry, per-user isolation, safe segment rejection, and list behavior that skips corrupt/future-schema files while retaining healthy records.

```ts
const episode = sampleEpisode({ id: 'kse-run-a', ownerId: 'kstar-user-a' });
await writeKstarEpisode('kstar-user-a', episode);
expect(await readKstarEpisode('kstar-user-a', episode.id)).toEqual(episode);
expect(await listKstarEpisodes('kstar-user-b')).toEqual([]);
expect(() => kstarEpisodePath('kstar-user-a', '../escape')).toThrow(/invalid/i);
```

- [x] **Step 2: Run the test and verify RED**

Run: `npm run test:js -- test/main/features/kstar/episode-store.test.ts`
Expected: FAIL because `features/kstar/episode-store` does not exist.

- [x] **Step 3: Implement minimal schema and store**

Use schema interfaces shaped like:

```ts
export interface KstarEpisodeRecord extends KstarJsonRecord {
  sessionId: string;
  taskRunId?: string;
  requestId?: string;
  runtimeSessionId?: string;
  k: { memoryRefs: string[]; contextRefs: string[]; abilityAssetRefs: string[]; promptContextSummary?: string };
  s: { conversationSummary?: string; workspaceId?: string; workingDir?: string; modelProfile?: string };
  t: { userGoal: string; normalizedTask?: string; constraints: string[] };
  a: { plan?: unknown; toolCalls: KstarToolCall[]; agentActions: KstarAgentAction[] };
  r: { status: KstarTaskStatus; finalText?: string; producedFiles: string[]; verification?: unknown; failureKind?: string; failureCode?: string };
  evidenceRefs: CognitionSourceRef[];
  createdAt: string;
  updatedAt: string;
}
```

Resolve paths with `userCloudRoot(userId)` and validate every segment with `safeId`. Persist with `writeJson` under `fileEditLock`; validate schema, owner, id, required arrays/objects on read. `listKstarEpisodes` reads each file independently and skips malformed records.

- [x] **Step 4: Run focused test and verify GREEN**

Run: `npm run test:js -- test/main/features/kstar/episode-store.test.ts`
Expected: PASS.

---

### Task 2: Pure episode builders for Runtime and group chat

**Files:**
- Create: `src/main/features/kstar/episode-builder.ts`
- Test: `test/main/features/kstar/episode-builder.test.ts`

- [x] **Step 1: Write failing builder tests**

Test a completed Runtime run with tool-call/tool-result events, a failed/cancelled run, and a group task whose messages are bounded to the terminal event time window.

```ts
const episode = buildRuntimeKstarEpisode({
  userId: 'user-a',
  runId: 'run-a',
  request,
  events: [toolCallEvent, toolResultEvent, completedResult],
  createdAt: '2026-08-05T00:00:00.000Z',
});
expect(episode.a.toolCalls).toEqual([expect.objectContaining({ name: 'read_file', status: 'ok' })]);
expect(episode.r.status).toBe('completed');
expect(episode.evidenceRefs).toContainEqual(expect.objectContaining({ kind: 'execution', id: 'run-a' }));
```

- [x] **Step 2: Run the test and verify RED**

Run: `npm run test:js -- test/main/features/kstar/episode-builder.test.ts`
Expected: FAIL because the builder module does not exist.

- [x] **Step 3: Implement bounded normalization**

Add pure functions:

```ts
buildRuntimeKstarEpisode(input: RuntimeKstarEpisodeInput): KstarEpisodeRecord
buildGroupKstarEpisode(input: GroupKstarEpisodeInput): KstarEpisodeRecord
```

Compact task/final text and summaries, redact source excerpts through Recall normalization, deduplicate produced files, summarize tool argument keys rather than persisting raw values, and represent each group actor reply as an `agentAction`. Do not persist full attachment contents or system prompts.

- [x] **Step 4: Run focused test and verify GREEN**

Run: `npm run test:js -- test/main/features/kstar/episode-builder.test.ts`
Expected: PASS.

---

### Task 3: Conservative review, extraction, and Recall bridge

**Files:**
- Create: `src/main/features/kstar/review-service.ts`
- Create: `src/main/features/kstar/extraction-service.ts`
- Create: `src/main/features/kstar/recall-bridge.ts`
- Test: `test/main/features/kstar/review-extraction.test.ts`

- [x] **Step 1: Write failing review/extraction tests**

Prove these invariants:

```ts
expect(createInitialKstarReview(unverifiedEpisode)).toMatchObject({
  deltaR: 'unknown', deltaA: 'unknown', outcome: 'unclear', attribution: 'unclear'
});
expect(proposeKstarCandidates(unverifiedEpisode, unclearReview)).toEqual([]);
expect(proposeKstarCandidates(successfulTwoToolEpisode, unclearReview)).toHaveLength(1);
```

Also persist an explicit high-confidence `skill_gap` review, bridge its proposal, assert the Recall record is `pending`, and assert no AbilityAsset file exists.

- [x] **Step 2: Run the test and verify RED**

Run: `npm run test:js -- test/main/features/kstar/review-extraction.test.ts`
Expected: FAIL because review/extraction modules do not exist.

- [x] **Step 3: Implement review and proposal policy**

`createInitialKstarReview` returns unknown/unclear unless explicit verification evidence supports a stronger classification. `saveKstarReview` validates confidence in `[0,1]`, finite numeric deltas, bounded rationale, and episode ownership.

`proposeKstarCandidates` returns at most three `KstarCandidateProposal` objects. Emit a `skill_method` proposal for a completed, error-free workflow with at least two distinct tool calls; emit a gap proposal only for confidence `>= 0.7` and non-unclear attribution. Every proposal carries an execution source ref to the episode.

`saveKstarCandidateProposals` maps proposals through:

```ts
await saveRecallCandidate(userId, {
  judgment: proposal.judgment,
  summary: proposal.summary,
  uncertainty: proposal.uncertainty,
  suggestedType: proposal.suggestedType,
  suggestedScope: proposal.suggestedScope,
  sourceRefs: proposal.sourceRefs,
});
```

Never import or invoke `promoteRecallCandidate`.

- [x] **Step 4: Run focused test and verify GREEN**

Run: `npm run test:js -- test/main/features/kstar/review-extraction.test.ts`
Expected: PASS.

---

### Task 4: Idempotent closure orchestration and Mate Agent Runtime hook

**Files:**
- Create: `src/main/features/kstar/task-closure.ts`
- Create: `src/main/features/kstar/index.ts`
- Modify: `src/main/features/cogseed_runtime/index.ts`
- Test: `test/main/features/kstar/task-closure.test.ts`
- Modify: `test/main/features/cogseed_runtime/facade.test.ts`

- [x] **Step 1: Write failing closure/runtime tests**

Test `captureRuntimeKstarClosure` creates episode → review → extraction record in order, retrying the same run reuses the same ids, and the Runtime facade supplies terminal facts after storing its run metadata.

Add a failure injection:

```ts
const runtime = createCogSeedAgentRuntime({
  worker,
  captureClosure: async () => { throw new Error('capture unavailable'); },
});
expect((await collect(runtime.run('user-a', { task: 'Do work' }))).at(-1)?.status).toBe('completed');
expect((await readRuntimeRunMeta('user-a', runId))?.status).toBe('completed');
```

- [x] **Step 2: Run tests and verify RED**

Run: `npm run test:js -- test/main/features/kstar/task-closure.test.ts test/main/features/cogseed_runtime/facade.test.ts`
Expected: FAIL because the closure API and Runtime hook are missing.

- [x] **Step 3: Implement closure and best-effort Runtime capture**

Expose:

```ts
captureRuntimeKstarClosure(input): Promise<KstarClosureResult>
captureGroupKstarClosure(input): Promise<KstarClosureResult>
```

Each operation writes the episode first, then initial review, then pending Recall candidates, then an extraction-run record. In Runtime, collect only `tool_call`, `tool_result`, terminal result/error/cancel events. Persist terminal Runtime metadata before awaiting capture. Catch capture errors, log `warn` with ids/status only, and do not alter or duplicate yielded runtime envelopes.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `npm run test:js -- test/main/features/kstar/task-closure.test.ts test/main/features/cogseed_runtime/facade.test.ts`
Expected: PASS.

---

### Task 5: Group-chat terminal capture and application lifecycle wiring

**Files:**
- Modify: `src/main/features/kstar/task-closure.ts`
- Modify: `src/main/index.ts`
- Modify: `test/main/features/kstar/task-closure.test.ts`

- [x] **Step 1: Write failing subscriber tests**

Inject a fake `subscribeTaskTerminals` and `readMessages` implementation. Assert one completed event produces one episode, duplicate delivery is idempotent, waiting/failed/cancelled statuses are represented, and loader/capture failures are swallowed after a warning.

```ts
const stop = startGroupKstarClosure({ subscribe, readMessages, capture: captureSpy });
listener!(terminalEvent);
await flushPromises();
expect(captureSpy).toHaveBeenCalledWith(expect.objectContaining({ event: terminalEvent }));
stop();
```

- [x] **Step 2: Run focused test and verify RED**

Run: `npm run test:js -- test/main/features/kstar/task-closure.test.ts`
Expected: FAIL because `startGroupKstarClosure` does not exist.

- [x] **Step 3: Implement subscriber and wire start/stop**

The subscriber reads at most 500 visible group messages, filters to `started_at_ms <= ts <= finished_at_ms` with a small persistence tolerance, and calls the shared group closure. In `src/main/index.ts`, start it after IPC/app setup beside `startTaskNotifications`, and stop it on `before-quit`. The callback must launch a caught promise; it must never block or throw into `bus.ts` terminal dispatch.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `npm run test:js -- test/main/features/kstar/task-closure.test.ts`
Expected: PASS.

---

### Task 6: Verification and regression review

**Files:**
- Review all files above; no new production behavior unless a failing verification test proves it is needed.

- [x] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [x] **Step 2: Run all KSTAR/Recall/Runtime/group terminal focused tests**

Run:

```bash
npm run test:js -- \
  test/main/features/kstar \
  test/main/features/recall \
  test/main/features/cogseed_runtime/facade.test.ts \
  test/main/features/group_chat/bus-integration.test.ts
```

Expected: PASS.

- [x] **Step 3: Run the project test command**

Run: `npm test`
Expected: PASS. If an unrelated pre-existing failure appears, preserve the exact failure output and confirm the focused KSTAR suite remains green.

- [x] **Step 4: Inspect the final diff**

Run: `git diff --check && git status --short`
Expected: no whitespace errors; only intended KSTAR integration files plus the pre-existing Recall/Evolution worktree changes.

## Verification contract

- **Failing proof:** each production task begins with a focused test that fails because the API/behavior is absent.
- **Minimal change:** no renderer dashboard, IPC expansion, evolution trigger, automatic AbilityAsset promotion, HTTP server, or new dependency.
- **Green proof:** focused suites, typecheck, and `npm test` outputs are recorded.
- **Next skill:** `$superpower-executing-plans` for inline execution in this same task, followed by `$superpower-review` and `$superpower-verification`.
