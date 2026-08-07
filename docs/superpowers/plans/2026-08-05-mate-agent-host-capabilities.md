# Mate Agent Host Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Add Mate-owned Office, Browser, and bounded Multi-Agent Coordinator capabilities to the isolated Native Runtime through a Main-side host-tool protocol.

**Architecture:** Extend the existing Runtime JSONL worker protocol with a reverse `host_tool_call`/`host_tool_result` request-response path. The Worker remains limited to the Native kernel; Main owns OfficeCLI, Electron BrowserWindow, and child-task scheduling. Each capability has a Mate-owned adapter, user/session scope, bounded results, cancellation, and focused tests.

**Tech Stack:** TypeScript, Electron BrowserWindow, existing OfficeCLI wrapper, existing Mate Task/Session/Event stores, Vitest, current JSONL Runtime worker.

---

## Task 1: Establish the host-tool protocol and writable runtime scope

**Files:**
- Modify: `src/main/features/mate_agent_runtime/protocol.ts`
- Modify: `src/main/features/mate_agent_runtime/index.ts`
- Modify: `src/main/features/mate_agent_runtime/worker-process.ts`
- Modify: `src/main/features/mate_agent_runtime/worker.ts`
- Modify: `src/main/features/mate_agent_runtime/worker-entry.ts`
- Modify: `src/main/features/mate_agent_runtime/kernel/types.ts`
- Modify: `src/main/features/mate_agent_runtime/kernel/tools/runner.ts`
- Create: `src/main/features/mate_agent_runtime/kernel/tools/host-tools.ts`
- Create: `test/main/features/mate_agent_runtime/host-tools.test.ts`
- Create: `test/main/features/mate_agent_runtime/worker-host-protocol.test.ts`

- [ ] **Step 1: Write failing protocol tests.** Assert that version 2 accepts `host_tool_call`/`host_tool_result`, the Worker host client correlates concurrent call ids, abort rejects a pending call, unknown messages do not enter the run queue, and the default Runtime facade resolves a user's workspace as an allowed root.
- [ ] **Step 2: Run the protocol tests to verify the red state.**

```bash
npm run test:js -- test/main/features/mate_agent_runtime/host-tools.test.ts test/main/features/mate_agent_runtime/worker-host-protocol.test.ts
```

Expected: FAIL because host envelopes, host client, and writable-root plumbing do not exist.
- [ ] **Step 3: Implement the minimal protocol.** Add `RuntimeHostToolCall`, `RuntimeHostToolResult`, `RuntimeHostToolName`, and protocol version 2. Add `hostToolHandler` to `RuntimeWorkerServiceOptions`; when Main receives a host call, dispatch it with the pending run's request and write exactly one result. Add Worker-side `createRuntimeHostToolClient` and route its result lines separately from event envelopes.
- [ ] **Step 4: Expose host tools in the Kernel.** Add `kind: 'host'` entries and a runner branch that calls the injected host client. Pass `working_dir` as both the validated read root and writable root only after Main normalization; keep the default policy read-only until a host adapter explicitly requires output.
- [ ] **Step 5: Run the protocol tests and typecheck.**

```bash
npm run test:js -- test/main/features/mate_agent_runtime/host-tools.test.ts test/main/features/mate_agent_runtime/worker-host-protocol.test.ts
npm run typecheck
```

Expected: all focused tests pass and typecheck exits 0.

## Task 2: Add Office host adapter

**Files:**
- Create: `src/main/features/mate_agent_backend/office-adapter.ts`
- Modify: `src/main/features/mate_agent_backend/types.ts`
- Modify: `src/main/features/mate_agent_backend/paths.ts`
- Modify: `src/main/features/mate_agent_runtime/kernel/tools/catalog.ts`
- Modify: `src/main/features/mate_agent_backend/index.ts`
- Modify: `src/main/features/mate_agent_runtime/worker-process.ts`
- Create: `test/main/features/mate_agent_backend/office-adapter.test.ts`
- Create: `test/main/features/mate_agent_runtime/kernel/office-tool-contract.test.ts`

- [ ] **Step 1: Write failing Office tests.** Cover `.docx/.xlsx/.pptx` allowlist, `isPathAllowed` on every input/output, operation validation, create/edit/render argv and stdin, `closeOfficeFile` in success/failure/abort, missing engine, and bounded result text. Use injected `runOfficeCli`, `closeOfficeFile`, and clock/temp roots; do not invoke a real binary.
- [ ] **Step 2: Run Office tests to verify red.**

```bash
npm run test:js -- test/main/features/mate_agent_backend/office-adapter.test.ts test/main/features/mate_agent_runtime/kernel/office-tool-contract.test.ts
```

Expected: FAIL because the Mate Office adapter and host catalog entries are absent.
- [ ] **Step 3: Implement `office-adapter.ts`.** Export `createMateOfficeAdapter` with `run(name, input, scope, opts)`. Normalize paths before checking existence, reject unsupported extensions and malformed batch operations, call only `runOfficeCli` with argv arrays, use temporary output paths under a scoped root, and close resident files in `finally`.
- [ ] **Step 4: Register the adapter through the host router.** Wire Office names to the adapter without importing any `src/main/model/core-agent/*` module. Make host tool definitions available to the model with descriptions that require `office_read` before edit and never expose raw argv.
- [ ] **Step 5: Run the focused Office tests and typecheck.**

```bash
npm run test:js -- test/main/features/mate_agent_backend/office-adapter.test.ts test/main/features/mate_agent_runtime/kernel/office-tool-contract.test.ts
npm run typecheck
```

Expected: all Office tests pass and typecheck exits 0.

## Task 3: Add Browser host adapter

**Files:**
- Create: `src/main/features/mate_agent_backend/browser-manager.ts`
- Create: `src/main/features/mate_agent_backend/browser-adapter.ts`
- Create: `src/main/features/mate_agent_runtime/kernel/tools/browser-tool-contract.ts`
- Modify: `src/main/features/mate_agent_runtime/kernel/tools/catalog.ts`
- Modify: `src/main/features/mate_agent_backend/index.ts`
- Modify: `src/main/features/mate_agent_runtime/worker-process.ts`
- Create: `test/main/features/mate_agent_backend/browser-manager.test.ts`
- Create: `test/main/features/mate_agent_runtime/kernel/browser-tool-contract.test.ts`

- [ ] **Step 1: Write failing Browser tests.** Verify secure BrowserWindow preferences, http/https-only navigation, credential/private/unsupported URL rejection, bounded snapshot and numeric refs, ref invalidation after navigation, click/type input restrictions, screenshot writable-root checks, WAF refusal, abort, and disposal.
- [ ] **Step 2: Run Browser tests to verify red.**

```bash
npm run test:js -- test/main/features/mate_agent_backend/browser-manager.test.ts test/main/features/mate_agent_runtime/kernel/browser-tool-contract.test.ts
```

Expected: FAIL because the Manager, adapter, and catalog tools are absent.
- [ ] **Step 3: Implement the BrowserWindow manager.** Use an injected window factory in tests and dynamic Electron import in production. Create one hidden window per `(userId, runtimeSessionId)`, isolate it with a temporary partition and sandboxed webPreferences, and dispose it on terminal/cancel/shutdown.
- [ ] **Step 4: Implement safe actions.** Use a fixed in-page script for visible text and refs; accept only numeric refs for click/type, only bounded text, and `capturePage` for screenshot. Reject WAF challenge text with `E_BROWSER_WAF_USER_ACTION_REQUIRED`; never return HTML, cookies, or arbitrary JavaScript execution.
- [ ] **Step 5: Register Browser names with the host router and run focused tests.**

```bash
npm run test:js -- test/main/features/mate_agent_backend/browser-manager.test.ts test/main/features/mate_agent_runtime/kernel/tools/browser-tool-contract.test.ts
npm run typecheck
```

Expected: all Browser tests pass and typecheck exits 0.

## Task 4: Add Coordinator storage and bounded task APIs

**Files:**
- Modify: `src/main/paths.ts`
- Modify: `src/main/features/mate_agent_backend/paths.ts`
- Modify: `src/main/features/mate_agent_backend/types.ts`
- Create: `src/main/features/mate_agent_backend/coordination-store.ts`
- Create: `src/main/features/mate_agent_backend/coordinator.ts`
- Modify: `src/main/features/mate_agent_backend/task-store.ts`
- Modify: `src/main/features/mate_agent_backend/runtime-controller.ts`
- Modify: `src/main/features/mate_agent_backend/index.ts`
- Create: `test/main/features/mate_agent_backend/coordinator.test.ts`

- [ ] **Step 1: Write failing coordinator tests.** Cover creation keyed to a parent task, idempotent request claims, four-child budget, depth one, user scope, child status summaries, and cancellation through an injected controller. Assert no import or call to `group_chat`.
- [ ] **Step 2: Run coordinator tests to verify red.**

```bash
npm run test:js -- test/main/features/mate_agent_backend/coordinator.test.ts
```

Expected: FAIL because coordination records, links, and APIs are absent.
- [ ] **Step 3: Implement the store and record shape.** Add `<uid>/cloud/mate_agent/coordinations`, `mate-coord-*` validation, atomic JSON writes, and optional `coordinationId`, `parentTaskId`, and `coordinationDepth` on tasks. Keep ordinary task creation unchanged when no coordinator metadata is passed.
- [ ] **Step 4: Implement bounded coordinator methods.** `delegate` validates explicit task/context and creates a child through `MateRuntimeController`; `tasks` reads only linked children; `cancel` rejects unlinked ids and calls `cancelMateTask`. Enforce `maxChildren=4` and child `coordinationDepth=1` without wall-clock timeouts.
- [ ] **Step 5: Run coordinator tests and typecheck.**

```bash
npm run test:js -- test/main/features/mate_agent_backend/coordinator.test.ts
npm run typecheck
```

Expected: all coordinator tests pass and typecheck exits 0.

## Task 5: Wire host router and parent cancellation

**Files:**
- Create: `src/main/features/mate_agent_backend/host-tool-router.ts`
- Modify: `src/main/features/mate_agent_runtime/worker-process.ts`
- Modify: `src/main/features/mate_agent_backend/runtime-controller.ts`
- Modify: `src/main/features/mate_agent_backend/index.ts`
- Create: `test/main/features/mate_agent_backend/host-tool-router.test.ts`
- Create: `test/main/features/mate_agent_backend/coordinator-integration.test.ts`

- [ ] **Step 1: Write failing router integration tests.** Assert routing to Office/Browser/Coordinator, unknown host tool denial, result caps, user/session scope, parent cancellation of active children, and Browser disposal after terminal events.
- [ ] **Step 2: Run router tests to verify red.**

```bash
npm run test:js -- test/main/features/mate_agent_backend/host-tool-router.test.ts test/main/features/mate_agent_backend/coordinator-integration.test.ts
```

Expected: FAIL because the router and lifecycle hooks are absent.
- [ ] **Step 3: Implement `createMateHostToolRouter`.** Dispatch only the allowlisted host names, pass the pending Runtime request scope into adapters, and return stable error strings through the existing result-cap utility. Use lazy imports for the shared controller to avoid Runtime ↔ Backend module cycles.
- [ ] **Step 4: Add lifecycle hooks.** On terminal Runtime events dispose Browser sessions and ask Coordinator to cancel active children when the parent task is cancelled. Do not create duplicate task/event scheduling paths; all tasks go through `MateRuntimeController` and all events go through `appendMateTaskEvent`.
- [ ] **Step 5: Run the focused backend/runtime suite.**

```bash
npm run test:js -- test/main/features/mate_agent_backend test/main/features/mate_agent_runtime test/main/ipc/mate-agent-backend.test.ts
npm run typecheck
```

Expected: focused suite passes with the existing Phase 1 tests unchanged.

## Task 6: Add smoke coverage and final verification

**Files:**
- Modify: `scripts/smoke-mate-agent-native.mjs`
- Create: `scripts/smoke-mate-agent-host-capabilities.mjs`
- Create: `test/main/features/mate_agent_backend/host-capability-boundary.test.ts`
- Modify: `AGENTS.md` only if the boundary test demonstrates a new approved choke point.

- [ ] **Step 1: Write the boundary test.** Assert Mate imports only `features/office/office_engine.ts` as generic infrastructure, never Core Office/Group Chat modules; Browser uses the injected Main factory; Worker spawn remains only in `worker-process.ts`.
- [ ] **Step 2: Implement deterministic host-capability smoke.** Use injected fake OfficeCLI and fake BrowserWindow, run a parent task that delegates one child, exercise office read and browser snapshot through host calls, cancel a second parent, and assert ordered host/task events and cleanup. No API key, network, or real OfficeCLI is required.
- [ ] **Step 3: Run complete verification.**

```bash
git diff --check
npm run typecheck
npm run test:js -- test/main/features/mate_agent_runtime test/main/features/mate_agent_backend test/main/ipc/mate-agent-backend.test.ts
npm test
node scripts/smoke-mate-agent-native.mjs
node scripts/smoke-mate-agent-host-capabilities.mjs
```

Expected: exit code 0; no failed tests; resource Python tests remain green; both smoke scripts report `{"ok":true}`.
- [ ] **Step 4: Audit changes.** Confirm no new npm dependency, no new HTTP server, no direct Orkas Group Chat/Core business import, no raw browser storage in results, and no files outside Mate-owned paths. Record any environment-specific limitation rather than claiming support.
