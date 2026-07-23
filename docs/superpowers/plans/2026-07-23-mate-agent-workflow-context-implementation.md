# Mate Agent Workflow Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Turn the shared-file POC into a first production backend slice for `WorkflowRun`, `SharedTaskContext`, `ContextPatch`, and `Gate` inside Mate Agent group chat.

**Architecture:** Add one focused group-chat collaboration module that stores per-conversation workflow state under the existing conversation layout and exposes pure, tested operations for run creation, step transitions, context patch merging, gate recording, and prompt-ready context summaries. Then integrate the module into `group_chat/bus.ts` at the existing nested dispatch choke points so `dispatch_to`, `hand_off_to`, and named/anonymous `run_worker` create durable step records without changing agent execution semantics.

**Tech Stack:** TypeScript, Node fs promises, existing `storage.ts` JSON helpers, existing `conversationLayout`, Vitest via `npm test` or targeted `npm run test:js -- ...` through the repository test runner.

---

## File Structure

### Create

- `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/collaboration.ts`
  - Owns collaboration data types, storage paths, validators, run/step lifecycle helpers, context patch merge logic, gate recording, and summary rendering.
- `/Users/sudai/Documents/Mate Agent/test/main/features/group_chat/collaboration.test.ts`
  - Unit tests for path placement, run lifecycle, step lifecycle, patch merge, conflict behavior, gate behavior, and summary generation.

### Modify

- `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/bus.ts`
  - Import the collaboration helpers and record workflow steps around existing nested dispatch calls. Do not change dispatch behavior.
- `/Users/sudai/Documents/Mate Agent/docs/superpowers/specs/2026-07-23-mate-agent-multi-agent-collaboration-design.md`
  - Add a short implementation status note after this slice lands.

### Do not modify in this slice

- `/Users/sudai/Documents/Mate Agent/src/main/preload.js`
- `/Users/sudai/Documents/Mate Agent/src/main/ipc/**`
- `/Users/sudai/Documents/Mate Agent/src/renderer/**`
- `/Users/sudai/Documents/Mate Agent/src/main/features/local_agents/runner.ts`
- `/Users/sudai/Documents/Mate Agent/src/main/features/connectors/mcp-client.ts`

Renderer and IPC read APIs are intentionally deferred until backend state is proven.

---

## Task 1: Collaboration Module Types And Storage Paths

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/test/main/features/group_chat/collaboration.test.ts`
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/collaboration.ts`

- [ ] **Step 1: Write failing tests for storage path placement and empty reads**

Create `/Users/sudai/Documents/Mate Agent/test/main/features/group_chat/collaboration.test.ts` with this initial content:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cid-collab';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-collab-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('group_chat collaboration › storage layout', () => {
  it('places workflow state under the conversation group directory', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const paths = c.collaborationPaths(TEST_UID, TEST_CID);
    expect(paths.rootDir).toBe(path.join(tmpDir, 'data', TEST_UID, 'cloud', 'chats', TEST_CID, 'collaboration'));
    expect(paths.runsDir).toBe(path.join(paths.rootDir, 'workflow_runs'));
    expect(paths.contextsDir).toBe(path.join(paths.rootDir, 'workflow_contexts'));
    expect(paths.activeFile).toBe(path.join(paths.rootDir, 'active.json'));
  });

  it('returns null when no active workflow exists', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    await expect(c.readActiveWorkflowRun(TEST_UID, TEST_CID)).resolves.toBeNull();
    await expect(c.readActiveSharedTaskContext(TEST_UID, TEST_CID)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

Expected: FAIL because `src/main/features/group_chat/collaboration.ts` does not exist.

- [ ] **Step 3: Implement types, path helper, and empty reads**

Create `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/collaboration.ts` with this content:

```ts
import * as path from 'node:path';
import { conversationLayout } from '../../util/project-layout';
import { genId12, nowIso, readJson, safeId, writeJson } from '../../storage';

export type WorkflowRunKind = 'discussion' | 'implementation' | 'review' | 'custom';
export type WorkflowRunStatus = 'created' | 'running' | 'blocked' | 'failed' | 'completed' | 'cancelled';
export type WorkflowStepType = 'prompt' | 'discussion_round' | 'implementation' | 'test' | 'review' | 'gate' | 'summary' | 'dispatch';
export type WorkflowStepStatus = 'pending' | 'running' | 'blocked' | 'failed' | 'completed' | 'skipped';
export type GateStatus = 'passed' | 'failed' | 'needs_review';
export type ContextItemSource = 'user' | 'agent' | 'code' | 'artifact' | 'system' | 'spec';
export type ContextConfidence = 'low' | 'medium' | 'high';

export interface CollaborationPaths {
  rootDir: string;
  runsDir: string;
  contextsDir: string;
  activeFile: string;
  runFile(runId: string): string;
  contextFile(contextId: string): string;
}

export interface OutputContract {
  kind: 'analysis' | 'plan' | 'implementation_result' | 'test_result' | 'review_result' | 'discussion_opinion' | 'dispatch_result';
  required_fields: string[];
  optional_fields?: string[];
  artifact_required?: boolean;
}

export interface WorkflowStep {
  id: string;
  run_id: string;
  title: string;
  actor_id: string | null;
  type: WorkflowStepType;
  status: WorkflowStepStatus;
  depends_on: string[];
  expected_output?: OutputContract;
  result_ref?: string;
  result_summary?: string;
  gate_result_id?: string;
  source_tool?: 'dispatch_to' | 'hand_off_to' | 'run_worker';
  started_at?: string;
  completed_at?: string;
}

export interface WorkflowRun {
  version: 1;
  id: string;
  cid: string;
  objective: string;
  kind: WorkflowRunKind;
  status: WorkflowRunStatus;
  phase: string;
  steps: WorkflowStep[];
  context_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ActiveWorkflowFile {
  version: 1;
  run_id: string;
  context_id: string;
  updated_at: string;
}

export interface ContextItem {
  id: string;
  text: string;
  source: ContextItemSource;
  source_ref?: string;
  confidence: ContextConfidence;
  added_by: string;
  created_at: string;
}

export interface DecisionItem extends ContextItem {
  reason?: string;
}

export interface RiskItem extends ContextItem {
  severity: 'low' | 'medium' | 'high';
}

export interface ArtifactRef {
  id: string;
  type: string;
  path?: string;
  summary?: string;
  added_by: string;
  created_at: string;
}

export interface AgentOutputSummary {
  actor_id: string;
  step_id: string;
  summary: string;
  created_at: string;
}

export interface GateCheck {
  name: string;
  status: GateStatus;
  reason?: string;
}

export interface GateResult {
  id: string;
  run_id: string;
  step_id: string;
  name: string;
  status: GateStatus;
  checks: GateCheck[];
  reason?: string;
  created_at: string;
}

export interface SharedTaskContext {
  version: 1;
  id: string;
  cid: string;
  run_id: string;
  objective: string;
  phase: string;
  constraints: ContextItem[];
  facts: ContextItem[];
  decisions: DecisionItem[];
  open_questions: ContextItem[];
  risks: RiskItem[];
  artifacts: ArtifactRef[];
  agent_outputs: Record<string, AgentOutputSummary>;
  gates: GateResult[];
  updated_at: string;
}

export function collaborationPaths(uid: string, cid: string): CollaborationPaths {
  const groupDir = conversationLayout(uid, cid).groupDir;
  const rootDir = path.join(groupDir, 'collaboration');
  const runsDir = path.join(rootDir, 'workflow_runs');
  const contextsDir = path.join(rootDir, 'workflow_contexts');
  return {
    rootDir,
    runsDir,
    contextsDir,
    activeFile: path.join(rootDir, 'active.json'),
    runFile(runId: string) {
      if (!safeId(runId)) throw new Error('invalid workflow run id');
      return path.join(runsDir, `${runId}.json`);
    },
    contextFile(contextId: string) {
      if (!safeId(contextId)) throw new Error('invalid workflow context id');
      return path.join(contextsDir, `${contextId}.json`);
    },
  };
}

function validActiveFile(value: unknown): value is ActiveWorkflowFile {
  const item = value as Partial<ActiveWorkflowFile>;
  return item?.version === 1 && safeId(item.run_id) && safeId(item.context_id);
}

function validRun(value: unknown): value is WorkflowRun {
  const item = value as Partial<WorkflowRun>;
  return item?.version === 1 && safeId(item.id) && typeof item.cid === 'string' && safeId(item.context_id) && Array.isArray(item.steps);
}

function validContext(value: unknown): value is SharedTaskContext {
  const item = value as Partial<SharedTaskContext>;
  return item?.version === 1 && safeId(item.id) && typeof item.cid === 'string' && safeId(item.run_id) && Array.isArray(item.facts);
}

export async function readWorkflowRun(uid: string, cid: string, runId: string): Promise<WorkflowRun | null> {
  if (!safeId(runId)) return null;
  const raw = await readJson<unknown>(collaborationPaths(uid, cid).runFile(runId));
  return validRun(raw) ? raw : null;
}

export async function readSharedTaskContext(uid: string, cid: string, contextId: string): Promise<SharedTaskContext | null> {
  if (!safeId(contextId)) return null;
  const raw = await readJson<unknown>(collaborationPaths(uid, cid).contextFile(contextId));
  return validContext(raw) ? raw : null;
}

export async function readActiveWorkflowRun(uid: string, cid: string): Promise<WorkflowRun | null> {
  const active = await readJson<unknown>(collaborationPaths(uid, cid).activeFile);
  if (!validActiveFile(active)) return null;
  return readWorkflowRun(uid, cid, active.run_id);
}

export async function readActiveSharedTaskContext(uid: string, cid: string): Promise<SharedTaskContext | null> {
  const active = await readJson<unknown>(collaborationPaths(uid, cid).activeFile);
  if (!validActiveFile(active)) return null;
  return readSharedTaskContext(uid, cid, active.context_id);
}

export const __collaborationInternals = { validActiveFile, validRun, validContext };
```

- [ ] **Step 4: Run the tests**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

Expected: PASS for the two storage layout tests.

---

## Task 2: Create WorkflowRun And SharedTaskContext Lifecycle

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/test/main/features/group_chat/collaboration.test.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/collaboration.ts`

- [ ] **Step 1: Add failing lifecycle tests**

Append this test block to `/Users/sudai/Documents/Mate Agent/test/main/features/group_chat/collaboration.test.ts`:

```ts
describe('group_chat collaboration › workflow lifecycle', () => {
  it('creates an active workflow run with an empty shared context', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const created = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Coordinate Hermes and Codex',
      kind: 'discussion',
      created_by: 'commander',
    });

    expect(created.run.status).toBe('running');
    expect(created.run.phase).toBe('created');
    expect(created.run.context_id).toBe(created.context.id);
    expect(created.context.objective).toBe('Coordinate Hermes and Codex');
    expect(created.context.facts).toEqual([]);

    const activeRun = await c.readActiveWorkflowRun(TEST_UID, TEST_CID);
    const activeContext = await c.readActiveSharedTaskContext(TEST_UID, TEST_CID);
    expect(activeRun?.id).toBe(created.run.id);
    expect(activeContext?.id).toBe(created.context.id);
  });

  it('reuses the active running workflow for ensureActiveWorkflowRun', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const first = await c.ensureActiveWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'First objective',
      kind: 'custom',
      created_by: 'commander',
    });
    const second = await c.ensureActiveWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Second objective',
      kind: 'custom',
      created_by: 'commander',
    });
    expect(second.run.id).toBe(first.run.id);
    expect(second.context.id).toBe(first.context.id);
    expect(second.run.objective).toBe('First objective');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

Expected: FAIL because `createWorkflowRun` and `ensureActiveWorkflowRun` are not implemented.

- [ ] **Step 3: Add lifecycle functions**

Append these exports to `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/collaboration.ts`:

```ts
export interface CreateWorkflowRunInput {
  objective: string;
  kind?: WorkflowRunKind;
  created_by: string;
}

export async function createWorkflowRun(
  uid: string,
  cid: string,
  input: CreateWorkflowRunInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext }> {
  const now = nowIso();
  const runId = `wf-${genId12()}`;
  const contextId = `wctx-${genId12()}`;
  const objective = String(input.objective || '').trim() || 'Multi-agent collaboration';
  const run: WorkflowRun = {
    version: 1,
    id: runId,
    cid,
    objective,
    kind: input.kind || 'custom',
    status: 'running',
    phase: 'created',
    steps: [],
    context_id: contextId,
    created_by: String(input.created_by || 'commander'),
    created_at: now,
    updated_at: now,
  };
  const context: SharedTaskContext = {
    version: 1,
    id: contextId,
    cid,
    run_id: runId,
    objective,
    phase: run.phase,
    constraints: [],
    facts: [],
    decisions: [],
    open_questions: [],
    risks: [],
    artifacts: [],
    agent_outputs: {},
    gates: [],
    updated_at: now,
  };
  const paths = collaborationPaths(uid, cid);
  await writeJson(paths.runFile(runId), run);
  await writeJson(paths.contextFile(contextId), context);
  await writeJson(paths.activeFile, { version: 1, run_id: runId, context_id: contextId, updated_at: now } satisfies ActiveWorkflowFile);
  return { run, context };
}

export async function ensureActiveWorkflowRun(
  uid: string,
  cid: string,
  input: CreateWorkflowRunInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext }> {
  const run = await readActiveWorkflowRun(uid, cid);
  if (run && run.status === 'running') {
    const context = await readSharedTaskContext(uid, cid, run.context_id);
    if (context) return { run, context };
  }
  return createWorkflowRun(uid, cid, input);
}
```

- [ ] **Step 4: Run lifecycle tests**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

Expected: PASS for storage layout and lifecycle tests.

---

## Task 3: WorkflowStep Recording And Gate Results

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/test/main/features/group_chat/collaboration.test.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/collaboration.ts`

- [ ] **Step 1: Add failing step/gate tests**

Append this test block:

```ts
describe('group_chat collaboration › steps and gates', () => {
  it('starts and completes a dispatch step with a passing evidence gate', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Coordinate agents',
      kind: 'discussion',
      created_by: 'commander',
    });

    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Ask reviewer',
      actor_id: 'reviewer',
      type: 'dispatch',
      source_tool: 'dispatch_to',
    });
    expect(step.status).toBe('running');

    const completed = await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, {
      status: 'completed',
      result_summary: 'Reviewer found no blockers.',
    });
    expect(completed.status).toBe('completed');

    const gate = await c.recordGateResult(TEST_UID, TEST_CID, run.id, step.id, {
      name: 'dispatch_result_present',
      status: 'passed',
      checks: [{ name: 'result_summary_present', status: 'passed' }],
    });
    expect(gate.status).toBe('passed');

    const next = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(next?.steps[0].gate_result_id).toBe(gate.id);
    const context = await c.readActiveSharedTaskContext(TEST_UID, TEST_CID);
    expect(context?.gates.map((g) => g.id)).toContain(gate.id);
  });

  it('records failed steps without marking the whole run completed', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { run } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Coordinate agents',
      kind: 'discussion',
      created_by: 'commander',
    });
    const step = await c.startWorkflowStep(TEST_UID, TEST_CID, run.id, {
      title: 'Ask tester',
      actor_id: 'tester',
      type: 'dispatch',
      source_tool: 'run_worker',
    });
    await c.completeWorkflowStep(TEST_UID, TEST_CID, run.id, step.id, {
      status: 'failed',
      result_summary: 'Tester failed to run.',
    });
    const next = await c.readWorkflowRun(TEST_UID, TEST_CID, run.id);
    expect(next?.status).toBe('running');
    expect(next?.steps[0].status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

Expected: FAIL because step/gate functions are not implemented.

- [ ] **Step 3: Implement run mutation helper, step lifecycle, and gate recording**

Append these functions to `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/collaboration.ts`:

```ts
async function writeRun(uid: string, cid: string, run: WorkflowRun): Promise<WorkflowRun> {
  await writeJson(collaborationPaths(uid, cid).runFile(run.id), run);
  return run;
}

async function writeContext(uid: string, cid: string, context: SharedTaskContext): Promise<SharedTaskContext> {
  await writeJson(collaborationPaths(uid, cid).contextFile(context.id), context);
  return context;
}

export interface StartWorkflowStepInput {
  title: string;
  actor_id: string | null;
  type?: WorkflowStepType;
  depends_on?: string[];
  expected_output?: OutputContract;
  source_tool?: 'dispatch_to' | 'hand_off_to' | 'run_worker';
}

export async function startWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  input: StartWorkflowStepInput,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  const now = nowIso();
  const step: WorkflowStep = {
    id: `wstep-${genId12()}`,
    run_id: run.id,
    title: String(input.title || 'Agent step'),
    actor_id: input.actor_id || null,
    type: input.type || 'dispatch',
    status: 'running',
    depends_on: input.depends_on || [],
    expected_output: input.expected_output,
    source_tool: input.source_tool,
    started_at: now,
  };
  run.steps.push(step);
  run.phase = step.type;
  run.updated_at = now;
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    context.phase = run.phase;
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  return step;
}

export interface CompleteWorkflowStepInput {
  status: Extract<WorkflowStepStatus, 'completed' | 'blocked' | 'failed' | 'skipped'>;
  result_summary?: string;
  result_ref?: string;
}

export async function completeWorkflowStep(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  input: CompleteWorkflowStepInput,
): Promise<WorkflowStep> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('workflow step not found');
  const now = nowIso();
  step.status = input.status;
  step.result_summary = input.result_summary;
  step.result_ref = input.result_ref;
  step.completed_at = now;
  run.updated_at = now;
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context && input.result_summary && step.actor_id) {
    context.agent_outputs[step.id] = {
      actor_id: step.actor_id,
      step_id: step.id,
      summary: input.result_summary,
      created_at: now,
    };
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  return step;
}

export interface RecordGateResultInput {
  name: string;
  status: GateStatus;
  checks: GateCheck[];
  reason?: string;
}

export async function recordGateResult(
  uid: string,
  cid: string,
  runId: string,
  stepId: string,
  input: RecordGateResultInput,
): Promise<GateResult> {
  const run = await readWorkflowRun(uid, cid, runId);
  if (!run) throw new Error('workflow run not found');
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('workflow step not found');
  const now = nowIso();
  const gate: GateResult = {
    id: `wgate-${genId12()}`,
    run_id: run.id,
    step_id: step.id,
    name: String(input.name || 'gate'),
    status: input.status,
    checks: input.checks || [],
    reason: input.reason,
    created_at: now,
  };
  step.gate_result_id = gate.id;
  run.updated_at = now;
  await writeRun(uid, cid, run);
  const context = await readSharedTaskContext(uid, cid, run.context_id);
  if (context) {
    context.gates.push(gate);
    context.updated_at = now;
    await writeContext(uid, cid, context);
  }
  return gate;
}
```

- [ ] **Step 4: Run step/gate tests**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

Expected: PASS for storage, lifecycle, step, and gate tests.

---

## Task 4: ContextPatch Merge And Summary Rendering

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/test/main/features/group_chat/collaboration.test.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/collaboration.ts`

- [ ] **Step 1: Add failing patch and summary tests**

Append this test block:

```ts
describe('group_chat collaboration › context patches', () => {
  it('merges facts, proposed decisions, risks, open questions, and artifacts', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Shared state design',
      kind: 'discussion',
      created_by: 'commander',
    });

    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'reviewer',
      facts_add: [{ text: 'events.jsonl is append-only', source: 'agent', confidence: 'high' }],
      decisions_proposed: [{ text: 'Use JSONL as the source of truth', source: 'agent', confidence: 'high', reason: 'It avoids snapshot overwrite loss.' }],
      risks_add: [{ text: 'Markdown snapshots can go stale', source: 'agent', confidence: 'medium', severity: 'medium' }],
      open_questions_add: [{ text: 'Do we need a helper command?', source: 'agent', confidence: 'medium' }],
      artifacts_add: [{ id: 'artifact-1', type: 'research_note', path: 'docs/research/tutti-agent-communication.md', summary: 'Tutti research note' }],
    });

    expect(updated.facts.map((item) => item.text)).toContain('events.jsonl is append-only');
    expect(updated.decisions.map((item) => item.text)).toContain('Use JSONL as the source of truth');
    expect(updated.risks[0].severity).toBe('medium');
    expect(updated.open_questions[0].text).toBe('Do we need a helper command?');
    expect(updated.artifacts[0].id).toBe('artifact-1');
  });

  it('keeps conflicting decisions out of decisions and records them as open questions', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Conflict handling',
      kind: 'discussion',
      created_by: 'commander',
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'agent-a',
      decisions_proposed: [{ text: 'Do not use Redis for local POC', source: 'agent', confidence: 'high' }],
    });
    const updated = await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'agent-b',
      decisions_proposed: [{ text: 'Use Redis for local POC', source: 'agent', confidence: 'high', conflicts_with: ['Do not use Redis for local POC'] }],
    });
    expect(updated.decisions.map((item) => item.text)).toEqual(['Do not use Redis for local POC']);
    expect(updated.open_questions.some((item) => item.text.includes('Conflicting decision proposed'))).toBe(true);
  });

  it('builds a compact shared context summary', async () => {
    const c = await import('../../../../src/main/features/group_chat/collaboration');
    const { context } = await c.createWorkflowRun(TEST_UID, TEST_CID, {
      objective: 'Summarize context',
      kind: 'discussion',
      created_by: 'commander',
    });
    await c.applyContextPatch(TEST_UID, TEST_CID, context.id, {
      added_by: 'agent-a',
      facts_add: [{ text: 'Fact A', source: 'agent', confidence: 'high' }],
      decisions_proposed: [{ text: 'Decision A', source: 'agent', confidence: 'high' }],
    });
    const summary = await c.buildSharedContextSummary(TEST_UID, TEST_CID, context.id);
    expect(summary).toContain('Objective: Summarize context');
    expect(summary).toContain('- Fact A');
    expect(summary).toContain('- Decision A');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

Expected: FAIL because patch/summary functions are not implemented.

- [ ] **Step 3: Add patch draft types and merge implementation**

Append this code to `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/collaboration.ts`:

```ts
export interface ContextItemDraft {
  text: string;
  source?: ContextItemSource;
  source_ref?: string;
  confidence?: ContextConfidence;
}

export interface DecisionDraft extends ContextItemDraft {
  reason?: string;
  conflicts_with?: string[];
}

export interface RiskDraft extends ContextItemDraft {
  severity?: 'low' | 'medium' | 'high';
}

export interface ArtifactRefDraft {
  id?: string;
  type: string;
  path?: string;
  summary?: string;
}

export interface ContextPatch {
  added_by: string;
  summary?: string;
  facts_add?: ContextItemDraft[];
  decisions_proposed?: DecisionDraft[];
  risks_add?: RiskDraft[];
  open_questions_add?: ContextItemDraft[];
  artifacts_add?: ArtifactRefDraft[];
  obsolete_item_ids?: string[];
}

function contextItemFromDraft(draft: ContextItemDraft, addedBy: string): ContextItem {
  return {
    id: `witem-${genId12()}`,
    text: String(draft.text || '').trim(),
    source: draft.source || 'agent',
    source_ref: draft.source_ref,
    confidence: draft.confidence || 'medium',
    added_by: addedBy,
    created_at: nowIso(),
  };
}

function hasText(items: Array<{ text: string }>, text: string): boolean {
  return items.some((item) => item.text.trim().toLowerCase() === text.trim().toLowerCase());
}

export async function applyContextPatch(
  uid: string,
  cid: string,
  contextId: string,
  patch: ContextPatch,
): Promise<SharedTaskContext> {
  const context = await readSharedTaskContext(uid, cid, contextId);
  if (!context) throw new Error('shared task context not found');
  const addedBy = String(patch.added_by || 'agent');
  const now = nowIso();

  for (const draft of patch.facts_add || []) {
    const item = contextItemFromDraft(draft, addedBy);
    if (item.text && !hasText(context.facts, item.text)) context.facts.push(item);
  }

  for (const draft of patch.decisions_proposed || []) {
    const text = String(draft.text || '').trim();
    if (!text) continue;
    const conflicts = (draft.conflicts_with || []).filter((value) => hasText(context.decisions, value));
    if (conflicts.length > 0) {
      context.open_questions.push({
        id: `witem-${genId12()}`,
        text: `Conflicting decision proposed: ${text}`,
        source: draft.source || 'agent',
        source_ref: draft.source_ref,
        confidence: draft.confidence || 'medium',
        added_by: addedBy,
        created_at: now,
      });
      continue;
    }
    if (!hasText(context.decisions, text)) {
      const base = contextItemFromDraft(draft, addedBy);
      context.decisions.push({ ...base, reason: draft.reason });
    }
  }

  for (const draft of patch.risks_add || []) {
    const base = contextItemFromDraft(draft, addedBy);
    if (base.text && !hasText(context.risks, base.text)) {
      context.risks.push({ ...base, severity: draft.severity || 'medium' });
    }
  }

  for (const draft of patch.open_questions_add || []) {
    const item = contextItemFromDraft(draft, addedBy);
    if (item.text && !hasText(context.open_questions, item.text)) context.open_questions.push(item);
  }

  for (const draft of patch.artifacts_add || []) {
    const id = String(draft.id || `wartifact-${genId12()}`).trim();
    if (!id || context.artifacts.some((item) => item.id === id)) continue;
    context.artifacts.push({
      id,
      type: String(draft.type || 'artifact'),
      path: draft.path,
      summary: draft.summary,
      added_by: addedBy,
      created_at: now,
    });
  }

  if (patch.obsolete_item_ids && patch.obsolete_item_ids.length > 0) {
    const obsolete = new Set(patch.obsolete_item_ids);
    context.facts = context.facts.filter((item) => !obsolete.has(item.id));
    context.decisions = context.decisions.filter((item) => !obsolete.has(item.id));
    context.risks = context.risks.filter((item) => !obsolete.has(item.id));
    context.open_questions = context.open_questions.filter((item) => !obsolete.has(item.id));
  }

  context.updated_at = now;
  return writeContext(uid, cid, context);
}

function bulletList(items: Array<{ text: string }>, limit = 8): string[] {
  return items.slice(0, limit).map((item) => `- ${item.text}`);
}

export async function buildSharedContextSummary(uid: string, cid: string, contextId: string): Promise<string> {
  const context = await readSharedTaskContext(uid, cid, contextId);
  if (!context) return '';
  const parts: string[] = [
    '## Shared Task Context',
    `Objective: ${context.objective}`,
    `Phase: ${context.phase}`,
  ];
  if (context.constraints.length) parts.push('', '### Constraints', ...bulletList(context.constraints));
  if (context.facts.length) parts.push('', '### Facts', ...bulletList(context.facts));
  if (context.decisions.length) parts.push('', '### Decisions', ...bulletList(context.decisions));
  if (context.open_questions.length) parts.push('', '### Open Questions', ...bulletList(context.open_questions));
  if (context.risks.length) parts.push('', '### Risks', ...bulletList(context.risks));
  if (context.artifacts.length) {
    parts.push('', '### Artifacts', ...context.artifacts.slice(0, 8).map((item) => `- ${item.id}${item.summary ? `: ${item.summary}` : ''}`));
  }
  return parts.join('\n');
}
```

- [ ] **Step 4: Run patch/summary tests**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

Expected: PASS for all collaboration tests.

---

## Task 5: Integrate Step Recording Into Nested Dispatch Tools

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/bus.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/test/main/features/group_chat/bus.test.ts` or `/Users/sudai/Documents/Mate Agent/test/main/features/group_chat/bus-integration.test.ts`

- [ ] **Step 1: Add a focused test for dispatch recording**

Inspect existing bus tests and add the smallest test to the file that already mocks nested dispatch tools. The expected behavior is:

```ts
it('records a workflow step around named dispatch_to', async () => {
  // Arrange a group chat with commander + one agent.
  // Trigger a commander turn that calls dispatch_to.
  // Assert readActiveWorkflowRun(uid, cid) returns a run.
  // Assert run.steps has one step with source_tool 'dispatch_to', actor_id target agent, and status 'completed'.
  // Assert readActiveSharedTaskContext(uid, cid)?.agent_outputs has an entry for that step.
});
```

If no existing bus test can reliably drive model tool calls without a large fixture, create a smaller exported helper test in `collaboration.test.ts` instead:

```ts
it('recordNestedDispatchStep wraps a successful nested dispatch result', async () => {
  const c = await import('../../../../src/main/features/group_chat/collaboration');
  const recorded = await c.recordNestedDispatchStep(TEST_UID, TEST_CID, {
    objective: 'User asks for review',
    actor_id: 'reviewer',
    actor_name: 'Reviewer',
    source_tool: 'dispatch_to',
    task: 'Review the plan',
    result: 'No blockers.',
  });
  expect(recorded.step.status).toBe('completed');
  expect(recorded.gate.status).toBe('passed');
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run the specific test file chosen in Step 1:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

or, if adding to bus tests:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/bus.test.ts
```

Expected: FAIL because the recording helper or bus integration does not exist.

- [ ] **Step 3: Add `recordNestedDispatchStep` helper**

Append this helper to `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/collaboration.ts`:

```ts
export interface RecordNestedDispatchStepInput {
  objective: string;
  actor_id: string | null;
  actor_name?: string;
  source_tool: 'dispatch_to' | 'hand_off_to' | 'run_worker';
  task: string;
  result?: string;
  error?: string;
}

export async function recordNestedDispatchStep(
  uid: string,
  cid: string,
  input: RecordNestedDispatchStepInput,
): Promise<{ run: WorkflowRun; context: SharedTaskContext; step: WorkflowStep; gate: GateResult }> {
  const active = await ensureActiveWorkflowRun(uid, cid, {
    objective: input.objective,
    kind: 'custom',
    created_by: 'commander',
  });
  const step = await startWorkflowStep(uid, cid, active.run.id, {
    title: `${input.source_tool}: ${input.actor_name || input.actor_id || 'worker'}`,
    actor_id: input.actor_id,
    type: 'dispatch',
    source_tool: input.source_tool,
    expected_output: {
      kind: 'dispatch_result',
      required_fields: ['result_summary'],
    },
  });
  const resultText = String(input.result || '').trim();
  const errorText = String(input.error || '').trim();
  const completed = await completeWorkflowStep(uid, cid, active.run.id, step.id, {
    status: errorText ? 'failed' : 'completed',
    result_summary: errorText || resultText || '(empty result)',
  });
  const gate = await recordGateResult(uid, cid, active.run.id, completed.id, {
    name: 'dispatch_result_present',
    status: errorText ? 'failed' : (resultText ? 'passed' : 'needs_review'),
    reason: errorText || (!resultText ? 'Nested dispatch returned an empty result.' : undefined),
    checks: [
      { name: 'result_summary_present', status: resultText || errorText ? 'passed' : 'needs_review' },
    ],
  });
  const run = await readWorkflowRun(uid, cid, active.run.id);
  const context = await readSharedTaskContext(uid, cid, active.context.id);
  if (!run || !context) throw new Error('workflow record disappeared after nested dispatch recording');
  return { run, context, step: completed, gate };
}
```

- [ ] **Step 4: Wire the helper into `bus.ts` after nested dispatch returns**

Modify `/Users/sudai/Documents/Mate Agent/src/main/features/group_chat/bus.ts`:

1. Add import near other group-chat imports:

```ts
import { recordNestedDispatchStep } from './collaboration';
```

2. After each successful named `runNestedDispatch` call in `dispatch_to`, `hand_off_to`, and named `run_worker`, add a best-effort call:

```ts
      void recordNestedDispatchStep(uid, cid, {
        objective: _unwrapLlmTurnPayload(currentTurnPayload) || currentTurnPayload,
        actor_id: resolvedId,
        actor_name: dispatchActor.name,
        source_tool: 'dispatch_to',
        task: message,
        result: dispatchResult,
      }).catch((err) => log.warn(`collaboration dispatch_to record failed cid=${cid}: ${(err as Error).message}`));
```

Use the correct local variables for each tool:

- `dispatch_to`: `actor_id: resolvedId`, `actor_name: dispatchActor.name`, `source_tool: 'dispatch_to'`, `task: message`, `result: dispatchResult`.
- `hand_off_to`: `actor_id: resolvedId`, `actor_name: handoffActor.name`, `source_tool: 'hand_off_to'`, `task: message`, `result: handoffResult`.
- named `run_worker`: `actor_id: resolvedId`, `actor_name: namedActor.name`, `source_tool: 'run_worker'`, `task`, `result: namedResult`.
- anonymous `run_worker`: `actor_id: workerActor.id`, `actor_name: workerActor.name`, `source_tool: 'run_worker'`, `task`, `result`.

Keep this best-effort and non-blocking for the first slice so recording failure never breaks existing dispatch behavior.

- [ ] **Step 5: Run tests**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

If a bus test was modified, also run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/bus.test.ts
```

Expected: PASS.

---

## Task 6: Documentation Status And Verification

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/docs/superpowers/specs/2026-07-23-mate-agent-multi-agent-collaboration-design.md`

- [ ] **Step 1: Add implementation status note**

In `/Users/sudai/Documents/Mate Agent/docs/superpowers/specs/2026-07-23-mate-agent-multi-agent-collaboration-design.md`, under the existing `### 5.1 2026-07-23 优先级修订` subsection, append:

```markdown

### 5.2 2026-07-23 第一实现切片

第一实现切片只落地后端状态层：`src/main/features/group_chat/collaboration.ts` 提供 `WorkflowRun`、`SharedTaskContext`、`ContextPatch`、`GateResult` 的 JSON 文件存储与合并逻辑，并在 nested dispatch 工具回流后做 best-effort step 记录。该切片不新增 renderer UI、不新增 IPC API、不改变 Agent 调度语义。
```

- [ ] **Step 2: Run focused collaboration tests**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run test:js -- test/main/features/group_chat/collaboration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run full test command**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
npm test
```

Expected: PASS. This is required because runtime source files changed.

- [ ] **Step 5: Inspect git diff**

Run:

```bash
cd '/Users/sudai/Documents/Mate Agent'
git status --short
git diff -- src/main/features/group_chat/collaboration.ts test/main/features/group_chat/collaboration.test.ts src/main/features/group_chat/bus.ts docs/superpowers/specs/2026-07-23-mate-agent-multi-agent-collaboration-design.md
```

Expected:

- New collaboration module and tests are present.
- `bus.ts` only has best-effort recording additions around nested dispatch.
- No renderer/preload/IPC changes.
- POC local files remain ignored.

---

## Completion Criteria

This implementation is complete when:

1. `collaboration.ts` stores workflow state under the existing conversation group directory.
2. `createWorkflowRun` and `ensureActiveWorkflowRun` create/reuse active runs.
3. `startWorkflowStep`, `completeWorkflowStep`, and `recordGateResult` persist step/gate state.
4. `applyContextPatch` merges facts, decisions, risks, questions, and artifacts while routing explicit decision conflicts to open questions.
5. `buildSharedContextSummary` returns a compact prompt-ready summary.
6. Nested dispatch tools call the recording helper best-effort without changing dispatch semantics.
7. Focused collaboration tests pass.
8. `npm run typecheck` passes.
9. `npm test` passes.
