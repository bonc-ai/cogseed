# Mate Agent Native Kernel Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking via update_plan.

**Goal:** Add the first Mate Agent Native Kernel layer: stable kernel types, default config, a local-only Runtime session store, request-id ledger, and import-boundary tests without changing UI or replacing the current core-agent executor.

**Architecture:** Create `src/main/features/cogseed_runtime/kernel/` with a narrow `index.ts` factory and internal `types.ts`, `config.ts`, and `session-store.ts`. Phase 1 does not execute models or tools; it creates the native data contract and storage boundary that later phases will use.

**Tech Stack:** Electron main TypeScript, existing `paths.ts`, `storage.ts`, JSONL files, Vitest via `npm run test:js`.

---

## File Structure

- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/types.ts`
  - Owns Native Kernel request/event/session/policy types. Must not import `#core-agent`.
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/config.ts`
  - Owns default kernel config, concurrency config, and tool policy defaults.
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/session-store.ts`
  - Owns native Runtime session header/history and request ledger under `<uid>/local/cogseed_runtime/`.
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/index.ts`
  - Exposes `createCogSeedAgentKernel` factory and prevents deep imports from becoming the app-level contract.
- Create: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/types-config.test.ts`
  - Verifies default policy/config and no forbidden fields.
- Create: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/session-store.test.ts`
  - Verifies local-only session storage, headers, ledger idempotency, legacy session handling, and concurrency safety.
- Create: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/import-boundary.test.ts`
  - Verifies kernel files do not import `features/group_chat`, `#core-agent`, or `model/client`.

---

### Task 1: Kernel Types and Config

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/types.ts`
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/config.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/types-config.test.ts`

- [x] **Step 1: Write the failing test**

Create `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/types-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUNTIME_CONCURRENCY,
  DEFAULT_RUNTIME_KERNEL_CONFIG,
  DEFAULT_RUNTIME_TOOL_POLICY,
} from '../../../../../src/main/features/cogseed_runtime/kernel/config';

import type {
  RuntimeKernelEvent,
  RuntimeKernelRequest,
  RuntimeToolPolicy,
} from '../../../../../src/main/features/cogseed_runtime/kernel/types';

describe('Mate Agent Runtime native kernel config', () => {
  it('starts from least-privilege tool policy', () => {
    expect(DEFAULT_RUNTIME_TOOL_POLICY).toEqual({
      fileRead: 'explicit_roots',
      fileWrite: 'none',
      shell: 'none',
      skillRun: 'none',
      network: 'none',
      connectors: 'none',
    } satisfies RuntimeToolPolicy);
  });

  it('defines explicit execution bounds', () => {
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.idleTimeoutMs).toBe(30 * 60 * 1000);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.streamIdleTimeoutMs).toBe(3 * 60 * 1000);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds).toBe(80);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.maxModelRetries).toBe(2);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.allowWriteToolsByDefault).toBe(false);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.allowShellByDefault).toBe(false);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.allowSkillRunByDefault).toBe(false);
  });

  it('serializes one run per runtime session by default', () => {
    expect(DEFAULT_RUNTIME_CONCURRENCY).toEqual({
      maxConcurrentRuns: 3,
      maxConcurrentRunsPerUser: 2,
      maxConcurrentRunsPerSession: 1,
    });
  });

  it('keeps kernel request/event contracts free of Mate Agent conversation identity', () => {
    const request: RuntimeKernelRequest = {
      userId: 'u1',
      requestId: 'req-a',
      runtimeSessionId: 'mruntime-a',
      task: 'Do work',
      context: [],
      attachments: [],
      readOnlyRoots: [],
      writableRoots: [],
      toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
    };
    const event: RuntimeKernelEvent = {
      type: 'started',
      requestId: request.requestId,
      runtimeSessionId: request.runtimeSessionId,
    };
    expect(JSON.stringify(request)).not.toContain('cid');
    expect(JSON.stringify(event)).not.toContain('gconv');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/types-config.test.ts --maxWorkers=1
```

Expected: FAIL with module-not-found for `kernel/config` or `kernel/types`.

- [x] **Step 3: Add `types.ts`**

Create `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/types.ts`:

```ts
import type { RuntimeAttachment, RuntimeContextItem } from '../protocol';

export type RuntimeKernelEventType =
  | 'started'
  | 'model_delta'
  | 'tool_call'
  | 'tool_result'
  | 'result'
  | 'error'
  | 'cancelled';

export interface RuntimeToolPolicy {
  fileRead: 'none' | 'explicit_roots';
  fileWrite: 'none' | 'explicit_writable_roots';
  shell: 'none' | 'low_risk_only' | 'allow_with_confirmation';
  skillRun: 'none' | 'allowlisted_skills';
  network: 'none';
  connectors: 'none';
}

export interface RuntimeKernelRequest {
  userId: string;
  requestId: string;
  runtimeSessionId: string;
  task: string;
  context: RuntimeContextItem[];
  attachments: RuntimeAttachment[];
  readOnlyRoots: string[];
  writableRoots: string[];
  toolPolicy: RuntimeToolPolicy;
  agentId?: string;
  modelProfile?: string;
  workingDir?: string;
}

export interface RuntimeKernelEvent {
  type: RuntimeKernelEventType;
  requestId: string;
  runtimeSessionId: string;
  text?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeKernelRunOptions {
  signal?: AbortSignal | null;
  kernelMode?: 'native' | 'core' | 'shadow';
  fallbackOnNativeError?: boolean;
}

export interface RuntimeKernelSessionSummary {
  runtimeSessionId: string;
  version: number;
  kernel: 'cogseed-agent-native';
  recordCount: number;
  lastRequestId?: string;
}
```

- [x] **Step 4: Add `config.ts`**

Create `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/config.ts`:

```ts
import type { RuntimeToolPolicy } from './types';

export const DEFAULT_RUNTIME_KERNEL_CONFIG = Object.freeze({
  idleTimeoutMs: 30 * 60 * 1000,
  streamIdleTimeoutMs: 3 * 60 * 1000,
  maxToolRounds: 80,
  maxModelRetries: 2,
  requestLedgerRetentionMs: 14 * 24 * 60 * 60 * 1000,
  maxInlineToolResultChars: 24_000,
  maxPromptContextChars: 120_000,
  maxMemoryInjectionChars: 12_000,
  allowWriteToolsByDefault: false,
  allowShellByDefault: false,
  allowSkillRunByDefault: false,
});

export const DEFAULT_RUNTIME_CONCURRENCY = Object.freeze({
  maxConcurrentRuns: 3,
  maxConcurrentRunsPerUser: 2,
  maxConcurrentRunsPerSession: 1,
});

export const DEFAULT_RUNTIME_TOOL_POLICY: RuntimeToolPolicy = Object.freeze({
  fileRead: 'explicit_roots',
  fileWrite: 'none',
  shell: 'none',
  skillRun: 'none',
  network: 'none',
  connectors: 'none',
});
```

- [x] **Step 5: Run test to verify it passes**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/types-config.test.ts --maxWorkers=1
```

Expected: PASS.

### Task 2: Native Runtime Session Store

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/session-store.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/session-store.test.ts`

- [x] **Step 1: Write the failing test**

Create `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/session-store.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as paths from '../../../../../src/main/paths';
import {
  appendNativeSessionRecord,
  claimRuntimeRequest,
  createNativeRuntimeSession,
  readNativeRuntimeSession,
  runtimeRequestLedgerFile,
} from '../../../../../src/main/features/cogseed_runtime/kernel/session-store';

const UID = 'native-kernel-session-user';

afterEach(() => {
  fs.rmSync(paths.userRoot(UID), { recursive: true, force: true });
});

describe('native Runtime session store', () => {
  it('creates a native header under local/cogseed_runtime/sessions', async () => {
    const sid = 'mruntime-native1';
    await createNativeRuntimeSession(UID, sid, '2026-08-04T00:00:00');

    const file = paths.cogseedRuntimeSessionFile(UID, sid);
    expect(file).toBe(path.join(paths.userLocalRoot(UID), 'cogseed_runtime', 'sessions', `${sid}.jsonl`));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(paths.userSessionFile(UID, sid))).toBe(false);

    const session = await readNativeRuntimeSession(UID, sid);
    expect(session.header).toEqual({
      type: 'session_header',
      version: 1,
      kernel: 'cogseed-agent-native',
      runtime_session_id: sid,
      created_at: '2026-08-04T00:00:00',
    });
    expect(session.records).toHaveLength(1);
  });

  it('appends native records after the header', async () => {
    const sid = 'mruntime-native2';
    await createNativeRuntimeSession(UID, sid, '2026-08-04T00:00:00');
    await appendNativeSessionRecord(UID, sid, {
      type: 'turn',
      request_id: 'req-turn1',
      role: 'user',
      content: 'hello',
      created_at: '2026-08-04T00:00:01',
    });

    const session = await readNativeRuntimeSession(UID, sid);
    expect(session.records).toEqual([
      expect.objectContaining({ type: 'session_header' }),
      expect.objectContaining({ type: 'turn', request_id: 'req-turn1', role: 'user', content: 'hello' }),
    ]);
  });

  it('claims request ids idempotently', async () => {
    const first = await claimRuntimeRequest(UID, 'mruntime-native3', 'req-dup', 'run-a', '2026-08-04T00:00:00');
    const second = await claimRuntimeRequest(UID, 'mruntime-native3', 'req-dup', 'run-b', '2026-08-04T00:00:01');

    expect(first).toEqual({ claimed: true });
    expect(second).toEqual({ claimed: false, existingRunId: 'run-a', status: 'running' });
    expect(fs.existsSync(runtimeRequestLedgerFile(UID))).toBe(true);
  });

  it('rejects invalid runtime session ids', async () => {
    await expect(createNativeRuntimeSession(UID, 'gconv-not-runtime', '2026-08-04T00:00:00')).rejects.toThrow(/invalid runtime session id/);
    await expect(createNativeRuntimeSession(UID, '../escape', '2026-08-04T00:00:00')).rejects.toThrow(/invalid runtime session id/);
  });

  it('refuses to treat legacy core-agent-shaped mruntime files as native history', async () => {
    const sid = 'mruntime-legacy';
    const file = paths.cogseedRuntimeSessionFile(UID, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ role: 'user', content: 'legacy core-agent line' }) + '\n');

    await expect(readNativeRuntimeSession(UID, sid)).rejects.toThrow(/legacy core-agent runtime session/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/session-store.test.ts --maxWorkers=1
```

Expected: FAIL with module-not-found for `kernel/session-store`.

- [x] **Step 3: Add native session store implementation**

Create `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/session-store.ts` with these exports:

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  cogseedRuntimeRoot,
  cogseedRuntimeSessionFile,
} from '../../../paths';
import { appendJsonl, readJson, safeId, writeJson } from '../../../storage';

export interface NativeRuntimeSessionHeader {
  type: 'session_header';
  version: 1;
  kernel: 'cogseed-agent-native';
  runtime_session_id: string;
  created_at: string;
}

export interface NativeRuntimeTurnRecord {
  type: 'turn';
  request_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  created_at: string;
}

export type NativeRuntimeSessionRecord = NativeRuntimeSessionHeader | NativeRuntimeTurnRecord;

export interface NativeRuntimeSessionReadResult {
  header: NativeRuntimeSessionHeader;
  records: NativeRuntimeSessionRecord[];
}

interface RequestLedgerEntry {
  request_id: string;
  runtime_session_id: string;
  run_id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  claimed_at: string;
}

function assertRuntimeSessionId(runtimeSessionId: string): string {
  if (!runtimeSessionId.startsWith('mruntime-') || !safeId(runtimeSessionId)) {
    throw new Error('invalid runtime session id');
  }
  return runtimeSessionId;
}

function assertRuntimeRequestId(requestId: string): string {
  if (!requestId.startsWith('req-') || !safeId(requestId)) {
    throw new Error('invalid runtime request id');
  }
  return requestId;
}

function assertRunId(runId: string): string {
  if (!safeId(runId)) throw new Error('invalid runtime run id');
  return runId;
}

export function runtimeRequestLedgerFile(uid: string): string {
  return path.join(cogseedRuntimeRoot(uid), 'request-ledger.json');
}

async function readLedger(uid: string): Promise<Record<string, RequestLedgerEntry>> {
  const raw = await readJson<Record<string, RequestLedgerEntry>>(runtimeRequestLedgerFile(uid));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export async function claimRuntimeRequest(
  uid: string,
  runtimeSessionId: string,
  requestId: string,
  runId: string,
  claimedAt: string,
): Promise<{ claimed: true } | { claimed: false; existingRunId: string; status: RequestLedgerEntry['status'] }> {
  assertRuntimeSessionId(runtimeSessionId);
  assertRuntimeRequestId(requestId);
  assertRunId(runId);
  const file = runtimeRequestLedgerFile(uid);
  const ledger = await readLedger(uid);
  const existing = ledger[requestId];
  if (existing) return { claimed: false, existingRunId: existing.run_id, status: existing.status };
  ledger[requestId] = {
    request_id: requestId,
    runtime_session_id: runtimeSessionId,
    run_id: runId,
    status: 'running',
    claimed_at: claimedAt,
  };
  await writeJson(file, ledger);
  return { claimed: true };
}

export async function createNativeRuntimeSession(uid: string, runtimeSessionId: string, createdAt: string): Promise<void> {
  assertRuntimeSessionId(runtimeSessionId);
  const file = cogseedRuntimeSessionFile(uid, runtimeSessionId);
  try {
    await fs.access(file);
    await readNativeRuntimeSession(uid, runtimeSessionId);
    return;
  } catch (err) {
    if (!/ENOENT/.test(String((err as NodeJS.ErrnoException).code || ''))) throw err;
  }
  const header: NativeRuntimeSessionHeader = {
    type: 'session_header',
    version: 1,
    kernel: 'cogseed-agent-native',
    runtime_session_id: runtimeSessionId,
    created_at: createdAt,
  };
  await appendJsonl(file, header);
}

export async function appendNativeSessionRecord(uid: string, runtimeSessionId: string, record: NativeRuntimeTurnRecord): Promise<void> {
  assertRuntimeSessionId(runtimeSessionId);
  assertRuntimeRequestId(record.request_id);
  await readNativeRuntimeSession(uid, runtimeSessionId);
  await appendJsonl(cogseedRuntimeSessionFile(uid, runtimeSessionId), record);
}

export async function readNativeRuntimeSession(uid: string, runtimeSessionId: string): Promise<NativeRuntimeSessionReadResult> {
  assertRuntimeSessionId(runtimeSessionId);
  const file = cogseedRuntimeSessionFile(uid, runtimeSessionId);
  const text = await fs.readFile(file, 'utf8');
  const records = text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) as NativeRuntimeSessionRecord[];
  const header = records[0] as NativeRuntimeSessionHeader | undefined;
  if (!header || header.type !== 'session_header' || header.kernel !== 'cogseed-agent-native') {
    throw new Error('legacy core-agent runtime session cannot be read as native history');
  }
  return { header, records };
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/session-store.test.ts --maxWorkers=1
```

Expected: PASS.

### Task 3: Kernel Factory Boundary

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/index.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/import-boundary.test.ts`

- [x] **Step 1: Write the failing boundary test**

Create `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/import-boundary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createCogSeedAgentKernel } from '../../../../../src/main/features/cogseed_runtime/kernel';

const kernelRoot = path.join(process.cwd(), 'src/main/features/cogseed_runtime/kernel');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(abs));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

describe('native Runtime kernel import boundary', () => {
  it('exposes a single factory entrypoint', () => {
    const kernel = createCogSeedAgentKernel();
    expect(typeof kernel.run).toBe('function');
    expect(typeof kernel.cancel).toBe('function');
    expect(typeof kernel.getSession).toBe('function');
  });

  it('does not import group chat, core-agent, or model client from kernel files', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(kernelRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      if (/features\/group_chat|#core-agent|model\/client|model\/core-agent/.test(source)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/import-boundary.test.ts --maxWorkers=1
```

Expected: FAIL with module-not-found for `kernel/index.ts`.

- [x] **Step 3: Add factory entrypoint**

Create `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/index.ts`:

```ts
import type {
  RuntimeKernelEvent,
  RuntimeKernelRequest,
  RuntimeKernelRunOptions,
  RuntimeKernelSessionSummary,
} from './types';
import { readNativeRuntimeSession } from './session-store';

export interface CogSeedAgentKernel {
  run(request: RuntimeKernelRequest, options?: RuntimeKernelRunOptions): AsyncIterable<RuntimeKernelEvent>;
  cancel(requestId: string): Promise<void>;
  getSession(userId: string, runtimeSessionId: string): Promise<RuntimeKernelSessionSummary>;
}

export interface CogSeedAgentKernelDeps {}

async function* unsupportedNativeRun(request: RuntimeKernelRequest): AsyncIterable<RuntimeKernelEvent> {
  yield {
    type: 'error',
    requestId: request.requestId,
    runtimeSessionId: request.runtimeSessionId,
    error: 'native kernel execution loop is not implemented in Phase 1',
    metadata: { code: 'native_kernel_not_ready' },
  };
}

export function createCogSeedAgentKernel(_deps: CogSeedAgentKernelDeps = {}): CogSeedAgentKernel {
  return {
    run: unsupportedNativeRun,
    async cancel(_requestId: string): Promise<void> {},
    async getSession(userId: string, runtimeSessionId: string): Promise<RuntimeKernelSessionSummary> {
      const session = await readNativeRuntimeSession(userId, runtimeSessionId);
      return {
        runtimeSessionId,
        version: session.header.version,
        kernel: session.header.kernel,
        recordCount: session.records.length,
        lastRequestId: [...session.records].reverse().find((record: any) => typeof record.request_id === 'string')?.request_id,
      };
    },
  };
}
```

- [x] **Step 4: Run boundary test to verify it passes**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/import-boundary.test.ts --maxWorkers=1
```

Expected: PASS.

### Task 4: Phase 1 Verification

**Files:**
- No new source files unless tests reveal a defect.

- [x] **Step 1: Run Phase 1 tests**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel --maxWorkers=1
```

Expected: all Phase 1 kernel tests pass.

- [x] **Step 2: Run Runtime tests**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime --maxWorkers=1
```

Expected: all Runtime tests pass, including Phase 0 worker/protocol tests.

- [x] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: no TypeScript errors.

- [x] **Step 4: Run full test command if time permits**

Run:

```bash
npm test
```

Expected: full JS and resource suites pass. If local resource failures occur, record exact failing files and error messages.

---

## Verification

Before claiming Phase 1 complete, run:

```bash
npm run test:js -- test/main/features/cogseed_runtime --maxWorkers=1
npm run typecheck
npm test
```

## Next skill

`$superpower-subagents` is recommended for implementation because Task 1, Task 2, and Task 3 have disjoint files and can be implemented/reviewed in small checkpoints. Inline execution with `$superpower-executing-plans` is acceptable if only one engineer is active in this workspace.
