# Mate Agent Runtime Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking via update_plan.

**Goal:** Build the first backend-only Mate Agent Runtime boundary: explicit runtime requests, local-only runtime sessions, a stdio worker process, and a facade that never consumes Mate Agent transcripts or the group-chat bus.

**Architecture:** Add `features/mate_agent_runtime/` as the owning facade and protocol layer. Extend the existing path/session chokepoints so `mruntime-*` sessions route to `<uid>/local/mate_runtime/`, then run the worker through one controlled spawn helper and an injectable core-agent executor.

**Tech Stack:** Electron main process TypeScript, Node child-process stdio JSONL, existing `storage.ts`, `paths.ts`, `path-sandbox.ts`, Vitest via `npm run test:js`.

---

### Task 1: Runtime path and session routing

**Files:**
- Modify: `src/main/paths.ts`
- Modify: `src/main/model/core-agent/session-store.ts`
- Test: `test/main/features/mate_agent_runtime/session-routing.test.ts`

- [x] **Step 1: Write failing tests**

```ts
expect(paths.mateRuntimeSessionFile(uid, 'mruntime-demo')).toBe(path.join(paths.userLocalRoot(uid), 'mate_runtime', 'sessions', 'mruntime-demo.jsonl'));
expect(resolveSessionPath(uid, 'mruntime-demo')).toBe(paths.mateRuntimeSessionFile(uid, 'mruntime-demo'));
expect(memoryScopeForSession('mruntime-demo', 'agent1')).toBeNull();
```

- [x] **Step 2: Run test to verify failure**

Run: `npm run test:js -- run test/main/features/mate_agent_runtime/session-routing.test.ts --maxWorkers=1`
Expected: FAIL because runtime path helpers and `mruntime` session kind do not exist.

- [x] **Step 3: Implement routing**

Add path helpers under `local/mate_runtime/{sessions,conversations,memory,contexts,runs}` and teach `session-store.ts` that `mruntime` is a known local-only kind routed to `mateRuntimeSessionFile` with no cross-session memory scope.

- [x] **Step 4: Run test to verify pass**

Run: `npm run test:js -- run test/main/features/mate_agent_runtime/session-routing.test.ts --maxWorkers=1`
Expected: PASS.

### Task 2: Runtime request protocol and sandbox validation

**Files:**
- Create: `src/main/features/mate_agent_runtime/protocol.ts`
- Test: `test/main/features/mate_agent_runtime/protocol.test.ts`

- [x] **Step 1: Write failing tests**

```ts
const normalized = normalizeRuntimeRunRequest(uid, raw, { allowedRoots: [allowed] });
expect(normalized.ok).toBe(true);
expect(normalized.request.runtime_session_id.startsWith('mruntime-')).toBe(true);
expect(normalizeRuntimeRunRequest(uid, { ...raw, cid: 'gconv-a' }, { allowedRoots: [allowed] }).ok).toBe(false);
```

- [x] **Step 2: Run test to verify failure**

Run: `npm run test:js -- run test/main/features/mate_agent_runtime/protocol.test.ts --maxWorkers=1`
Expected: FAIL because `protocol.ts` does not exist.

- [x] **Step 3: Implement protocol**

Implement stable protocol version, `RuntimeRunRequest`, `RuntimeEnvelope`, `normalizeRuntimeRunRequest`, and guards that reject caller-supplied `cid`, cloud chat/session paths, invalid ids, and attachment/context file paths outside explicit allowed roots.

- [x] **Step 4: Run test to verify pass**

Run: `npm run test:js -- run test/main/features/mate_agent_runtime/protocol.test.ts --maxWorkers=1`
Expected: PASS.

### Task 3: Runtime store and stdio worker lifecycle

**Files:**
- Create: `src/main/features/mate_agent_runtime/store.ts`
- Create: `src/main/features/mate_agent_runtime/worker.ts`
- Create: `src/main/features/mate_agent_runtime/worker-entry.ts`
- Create: `src/main/features/mate_agent_runtime/worker-process.ts`
- Create: `bin/mate-runtime-worker.cjs`
- Test: `test/main/features/mate_agent_runtime/store.test.ts`
- Test: `test/main/features/mate_agent_runtime/worker-process.test.ts`

- [x] **Step 1: Write failing tests**

```ts
await appendRuntimeRunEvent(uid, 'run1', { type: 'event', request_id: 'req1', runtime_session_id: 'mruntime-a', status: 'started' });
expect(fs.existsSync(path.join(paths.userLocalRoot(uid), 'mate_runtime', 'runs', 'run1', 'events.jsonl'))).toBe(true);
const service = createRuntimeWorkerService({ spawnWorker: fakeSpawn });
const events = await collect(service.run(request));
expect(events.find(e => e.type === 'result')?.request_id).toBe('req-A');
```

- [x] **Step 2: Run tests to verify failure**

Run: `npm run test:js -- run test/main/features/mate_agent_runtime/store.test.ts test/main/features/mate_agent_runtime/worker-process.test.ts --maxWorkers=1`
Expected: FAIL because store and worker process files do not exist.

- [x] **Step 3: Implement store and worker service**

Persist runtime run metadata/events under `local/mate_runtime/runs`; implement JSONL handshake, request/response correlation, cancel, restart after exit, and protocol version rejection in `worker-process.ts`; implement `worker.ts` with an injectable executor and an echo executor used only under `ORKAS_MATE_RUNTIME_TEST_ECHO=1`.

- [x] **Step 4: Run tests to verify pass**

Run: `npm run test:js -- run test/main/features/mate_agent_runtime/store.test.ts test/main/features/mate_agent_runtime/worker-process.test.ts --maxWorkers=1`
Expected: PASS.

### Task 4: Facade and core-agent adapter

**Files:**
- Create: `src/main/features/mate_agent_runtime/core-executor.ts`
- Create: `src/main/features/mate_agent_runtime/index.ts`
- Test: `test/main/features/mate_agent_runtime/facade.test.ts`

- [x] **Step 1: Write failing tests**

```ts
const runtime = createMateAgentRuntime({ worker: fakeWorker, projectResult: fakeProjector });
const events = await collect(runtime.run(uid, { task: 'Summarize only this text', context: [{ type: 'text', content: 'A' }] }));
expect(fakeWorker.seen[0]).not.toHaveProperty('cid');
expect(fakeProjector.calls[0].text).toBe('done');
```

- [x] **Step 2: Run test to verify failure**

Run: `npm run test:js -- run test/main/features/mate_agent_runtime/facade.test.ts --maxWorkers=1`
Expected: FAIL because facade does not exist.

- [x] **Step 3: Implement facade and adapter**

Expose `runMateAgentRuntime`/`createMateAgentRuntime`, normalize input at entry, assign `mruntime-*` and `req-*` ids, stream worker events, persist run events, and project final text back only through an optional caller-provided projector. Implement the default executor by calling `streamChatWithModel` with `sessionId=runtime_session_id`, no `cid`, no group-chat tools, explicit message built from task/context, and read-only roots from validated attachments/context files.

- [x] **Step 4: Run test to verify pass**

Run: `npm run test:js -- run test/main/features/mate_agent_runtime/facade.test.ts --maxWorkers=1`
Expected: PASS.

### Task 5: Integration verification

**Files:**
- No new files unless tests reveal a defect.

- [x] **Step 1: Run Runtime test set**

Run: `npm run test:js -- run test/main/features/mate_agent_runtime --maxWorkers=1`
Expected: all Runtime tests pass.

- [x] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no TypeScript errors.

- [x] **Step 3: Run full test command if practical**

Run: `npm test`
Expected: pass, or document unrelated local resource failures with concrete failing files.
