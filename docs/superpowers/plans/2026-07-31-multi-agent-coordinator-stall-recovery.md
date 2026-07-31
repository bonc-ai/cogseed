# Multi-Agent Coordinator Stall Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Add activity-aware stall detection, one same-Agent resume retry, bounded capability-based fallback, dependency/write-scope admission, and accurate UI status to existing Group Chat nested dispatches without creating a second scheduler or spawn path.

**Architecture:** Pure coordinator modules classify turn activity, choose recovery actions, rank fallback Agents, and serialize conflicting access. `src/main/features/group_chat/bus.ts` remains the only executor and calls those modules around the existing `runNestedDispatch`; `collaboration.ts` remains the durable workflow/attempt ledger; `local_agents/runner.ts` remains the only CLI spawn path. The implementation is staged so activity tracking and persistence land before automatic termination and fallback.

**Tech Stack:** Electron main process, Node.js, TypeScript, vanilla renderer JavaScript, JSON/JSONL persistence, Vitest through the repository `npm test` wrapper, `async-mutex` already present in the repository.

**Design:** `docs/superpowers/specs/2026-07-31-multi-agent-coordinator-stall-recovery-design.md`

---

## File Map

### New files

- `src/main/features/group_chat/coordinator_activity.ts` — pure turn activity state machine and lease decisions.
- `src/main/features/group_chat/coordinator_runtime.ts` — timer host plus CLI/model event normalization.
- `src/main/features/group_chat/coordinator_recovery.ts` — pure retry/fallback policy and deterministic Agent ranking.
- `src/main/features/group_chat/coordinator_admission.ts` — dependency checks and abortable read/write scope admission.
- `src/main/features/group_chat/retry_resume.ts` — canonical resume instruction shared by manual and automatic retry.
- `test/main/features/group_chat/coordinator-activity.test.ts` — activity/lease invariants.
- `test/main/features/group_chat/coordinator-recovery.test.ts` — bounded recovery and Agent ranking invariants.
- `test/main/features/group_chat/coordinator-admission.test.ts` — access conflict and abortable waiting invariants.

### Existing files modified

- `src/main/features/group_chat/collaboration.ts` — persist bounded attempt history and structured dispatch metadata.
- `src/main/features/group_chat/bus.ts` — wire the monitor, structured abort source, coordinated dispatch loop, tool schemas, and hand-off finalization.
- `src/main/features/group_chat/index.ts` — reuse canonical resume instruction for manual retry.
- `src/main/model/core-agent/client.ts` and `src/main/model/client.ts` — expose a read-only active-session liveness query.
- `src/main/locales/{en,zh,ja,pt}.json` — localized coordinator failure bubbles.
- `src/main/util/locks.ts` — change default nested dispatch capacity from 4 to 3.
- `src/renderer/modules/conversation.js` — render actor-level idle and coordinator recovery events through i18n.
- `src/renderer/locales/{en,zh,ja,pt}.json` — coordinator status strings.
- `test/main/features/group_chat/collaboration.test.ts` — workflow attempt normalization/persistence tests.
- `test/main/features/group_chat/bus-integration.test.ts` — CLI/in-process stall, retry, fallback, hand-off, and concurrency integration tests.
- `test/main/features/group_chat/bus.test.ts` — structured abort and process-event unit coverage.
- `test/main/features/local_agents/runner.test.ts` — confirm runner idle heartbeat remains informational and does not reset activity.
- `test/renderer/conversation-sidebar.test.ts` — localized idle/recovery formatting.
- `docs/superpowers/specs/2026-07-31-multi-agent-coordinator-stall-recovery-design.md` — mark approved and, after implementation, record delivered behavior.

## Working-Tree Safety

The repository already contains unrelated uncommitted authorization/settings changes. Every task below stages only its listed files with explicit `git add -- <paths>` commands. Do not use `git add .`, do not reset existing changes, and do not amend unrelated commits.

---

### Task 1: Build the Pure Turn Activity State Machine

**Files:**
- Create: `src/main/features/group_chat/coordinator_activity.ts`
- Create: `test/main/features/group_chat/coordinator-activity.test.ts`

- [ ] **Step 1: Write failing state-machine tests**

Create `test/main/features/group_chat/coordinator-activity.test.ts` with these cases:

```typescript
import { describe, expect, it } from 'vitest';
import {
  TurnActivityTracker,
  DEFAULT_COORDINATOR_LEASES,
} from '../../../../src/main/features/group_chat/coordinator_activity';

describe('TurnActivityTracker', () => {
  it('treats a completed tool followed by silence as agent idle', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'tool_start', callId: 'c1', tool: 'exec_command' }, 1_000);
    t.observe({ kind: 'tool_result', callId: 'c1' }, 2_000);

    expect(t.snapshot().phase).toBe('agent_idle');
    expect(t.evaluate(2_000 + DEFAULT_COORDINATOR_LEASES.agentProbeMs)).toMatchObject({
      kind: 'probe',
      reason: 'agent_idle',
    });
  });

  it('aborts an unfinished normal tool after 120 seconds of real inactivity', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'tool_start', callId: 'c1', tool: 'exec_command' }, 1_000);

    expect(t.evaluate(120_999)).toEqual({ kind: 'none' });
    expect(t.evaluate(121_000)).toMatchObject({ kind: 'abort', reason: 'tool_idle' });
  });

  it('does not count the runner idle heartbeat as activity', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'activity' }, 1_000);
    t.observe({ kind: 'idle_heartbeat' }, 100_000);

    expect(t.snapshot().lastActivityAt).toBe(1_000);
  });

  it('probes once at five minutes and aborts at eight minutes', () => {
    const t = new TurnActivityTracker(0);

    expect(t.evaluate(299_999)).toEqual({ kind: 'none' });
    expect(t.evaluate(300_000)).toMatchObject({ kind: 'probe', reason: 'agent_idle' });
    expect(t.evaluate(360_000)).toEqual({ kind: 'none' });
    expect(t.evaluate(480_000)).toMatchObject({ kind: 'abort', reason: 'agent_idle' });
  });

  it('clears a previous probe when real activity resumes', () => {
    const t = new TurnActivityTracker(0);
    expect(t.evaluate(300_000).kind).toBe('probe');
    t.observe({ kind: 'activity' }, 310_000);

    expect(t.evaluate(610_000).kind).toBe('probe');
  });

  it('pauses while explicitly waiting for the user', () => {
    const t = new TurnActivityTracker(0);
    t.observe({ kind: 'awaiting_user' }, 10_000);

    expect(t.evaluate(900_000)).toEqual({ kind: 'none' });
    t.observe({ kind: 'user_resumed' }, 910_000);
    expect(t.evaluate(1_210_000).kind).toBe('probe');
  });

  it('lets explicitly long-running silent tools fall through to the backend watchdog', () => {
    const t = new TurnActivityTracker(0);
    t.observe({
      kind: 'tool_start',
      callId: 'download',
      tool: 'exec_command',
      longRunning: true,
    }, 1_000);

    expect(t.evaluate(20 * 60_000)).toEqual({ kind: 'none' });
  });
});
```

- [ ] **Step 2: Run the suite and verify RED**

Run:

```bash
npm test
```

Expected: the new test file fails because `coordinator_activity.ts` does not exist.

- [ ] **Step 3: Implement the state machine**

Create `src/main/features/group_chat/coordinator_activity.ts`:

```typescript
export const DEFAULT_COORDINATOR_LEASES = {
  toolIdleMs: 120_000,
  agentProbeMs: 5 * 60_000,
  agentAbortMs: 8 * 60_000,
} as const;

export type CoordinatorStallReason = 'tool_idle' | 'agent_idle';

export type CoordinatorActivityEvent =
  | { kind: 'activity' }
  | { kind: 'idle_heartbeat' }
  | { kind: 'tool_start'; callId?: string; tool: string; longRunning?: boolean }
  | { kind: 'tool_result'; callId?: string; tool?: string }
  | { kind: 'awaiting_user' }
  | { kind: 'user_resumed' }
  | { kind: 'terminal' };

export type CoordinatorLeaseDecision =
  | { kind: 'none' }
  | { kind: 'probe'; reason: 'agent_idle'; idleMs: number }
  | { kind: 'abort'; reason: CoordinatorStallReason; idleMs: number };

export interface CoordinatorLeaseConfig {
  toolIdleMs: number;
  agentProbeMs: number;
  agentAbortMs: number;
}

type OpenTool = { tool: string; startedAt: number; longRunning: boolean };

export class TurnActivityTracker {
  private phaseValue: 'agent_idle' | 'tool_in_flight' | 'awaiting_user' | 'terminal' = 'agent_idle';
  private lastActivityAtValue: number;
  private probeSentAtValue: number | undefined;
  private syntheticToolSeq = 0;
  private readonly openTools = new Map<string, OpenTool>();

  constructor(
    startedAt: number,
    private readonly config: CoordinatorLeaseConfig = DEFAULT_COORDINATOR_LEASES,
  ) {
    this.lastActivityAtValue = startedAt;
  }

  observe(event: CoordinatorActivityEvent, now: number): void {
    if (this.phaseValue === 'terminal') return;
    if (event.kind === 'idle_heartbeat') return;
    if (event.kind === 'terminal') {
      this.phaseValue = 'terminal';
      this.openTools.clear();
      return;
    }
    if (event.kind === 'awaiting_user') {
      this.phaseValue = 'awaiting_user';
      return;
    }
    if (event.kind === 'user_resumed') {
      this.lastActivityAtValue = now;
      this.probeSentAtValue = undefined;
      this.phaseValue = this.openTools.size ? 'tool_in_flight' : 'agent_idle';
      return;
    }
    if (event.kind === 'tool_start') {
      const callId = event.callId || `synthetic-${++this.syntheticToolSeq}`;
      this.openTools.set(callId, {
        tool: event.tool,
        startedAt: now,
        longRunning: event.longRunning === true,
      });
    } else if (event.kind === 'tool_result') {
      if (event.callId) this.openTools.delete(event.callId);
      else {
        const fallback = [...this.openTools.entries()].find(([, tool]) => !event.tool || tool.tool === event.tool);
        if (fallback) this.openTools.delete(fallback[0]);
      }
    }
    this.lastActivityAtValue = now;
    this.probeSentAtValue = undefined;
    this.phaseValue = this.openTools.size ? 'tool_in_flight' : 'agent_idle';
  }

  evaluate(now: number): CoordinatorLeaseDecision {
    if (this.phaseValue === 'terminal' || this.phaseValue === 'awaiting_user') {
      return { kind: 'none' };
    }
    const idleMs = Math.max(0, now - this.lastActivityAtValue);
    if (this.phaseValue === 'tool_in_flight') {
      const hasNormalTool = [...this.openTools.values()].some((tool) => !tool.longRunning);
      return hasNormalTool && idleMs >= this.config.toolIdleMs
        ? { kind: 'abort', reason: 'tool_idle', idleMs }
        : { kind: 'none' };
    }
    if (idleMs >= this.config.agentAbortMs) {
      return { kind: 'abort', reason: 'agent_idle', idleMs };
    }
    if (idleMs >= this.config.agentProbeMs && this.probeSentAtValue === undefined) {
      this.probeSentAtValue = now;
      return { kind: 'probe', reason: 'agent_idle', idleMs };
    }
    return { kind: 'none' };
  }

  snapshot(): {
    phase: 'agent_idle' | 'tool_in_flight' | 'awaiting_user' | 'terminal';
    lastActivityAt: number;
    probeSentAt?: number;
    openToolCount: number;
  } {
    return {
      phase: this.phaseValue,
      lastActivityAt: this.lastActivityAtValue,
      ...(this.probeSentAtValue !== undefined ? { probeSentAt: this.probeSentAtValue } : {}),
      openToolCount: this.openTools.size,
    };
  }
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: the coordinator activity tests and the existing suite pass.

- [ ] **Step 5: Commit**

```bash
git add -- src/main/features/group_chat/coordinator_activity.ts test/main/features/group_chat/coordinator-activity.test.ts
git commit -m "feat(group-chat): add turn activity lease state machine"
```

---

### Task 2: Persist Bounded Workflow Attempt History

**Files:**
- Modify: `src/main/features/group_chat/collaboration.ts`
- Modify: `test/main/features/group_chat/collaboration.test.ts`

- [ ] **Step 1: Add failing persistence tests**

Add tests that create one nested dispatch step and assert:

```typescript
const started = await c.beginWorkflowStepAttempt(TEST_UID, cid, prepared.step.id, {
  actor_id: 'agent-a',
  actor_kind: 'agent',
  actor_name: 'Agent A',
});
expect(started.original_actor_id).toBe('agent-a');
expect(started.current_actor_id).toBe('agent-a');
expect(started.attempts).toMatchObject([
  { attempt: 1, actor_id: 'agent-a', actor_kind: 'agent', status: 'running' },
]);

const failed = await c.finishWorkflowStepAttempt(TEST_UID, cid, prepared.step.id, {
  status: 'failed',
  failure_code: 'coordinator_agent_idle',
});
expect(failed.attempts?.[0]).toMatchObject({
  status: 'failed',
  failure_code: 'coordinator_agent_idle',
});
```

Add compatibility coverage by manually writing a workflow JSON containing malformed/oversized `attempts`; assert `readWorkflowRun` keeps only the last four valid entries and never throws.

Add a fifth-start test:

```typescript
await expect(c.beginWorkflowStepAttempt(TEST_UID, cid, stepId, {
  actor_id: null,
  actor_kind: 'anonymous_worker',
})).rejects.toThrow('workflow step attempt limit reached');
```

- [ ] **Step 2: Run the suite and verify RED**

Run `npm test`.

Expected: failures report missing `beginWorkflowStepAttempt`, `finishWorkflowStepAttempt`, and attempt fields.

- [ ] **Step 3: Add attempt types and normalization**

Extend `WorkflowStep` with:

```typescript
export type WorkflowAttemptStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type WorkflowAttemptFailureCode =
  | 'coordinator_tool_idle'
  | 'coordinator_agent_idle'
  | 'runtime_failed'
  | 'dependency_failed';

export interface WorkflowAttempt {
  attempt: number;
  actor_id: string | null;
  actor_kind: 'agent' | 'anonymous_worker';
  actor_name?: string;
  status: WorkflowAttemptStatus;
  failure_code?: WorkflowAttemptFailureCode;
  started_at: string;
  completed_at?: string;
}

export interface WorkflowStep {
  // existing fields remain unchanged
  original_actor_id?: string | null;
  current_actor_id?: string | null;
  required_capabilities?: string[];
  access_mode?: 'read' | 'write';
  write_scopes?: string[];
  attempts?: WorkflowAttempt[];
}
```

Add a `normalizeWorkflowAttempt` helper that accepts only attempts 1-4, valid actor kinds/statuses, sanitized ids/names, and ISO strings. In `normalizeWorkflowRun`, set:

```typescript
const attempts = Array.isArray(step.attempts)
  ? step.attempts.map(normalizeWorkflowAttempt).filter((x): x is WorkflowAttempt => !!x).slice(-4)
  : [];
if (attempts.length) normalized.attempts = attempts;
else delete normalized.attempts;
```

Normalize `required_capabilities` as trimmed unique strings, `access_mode` as `read|write`, and `write_scopes` as trimmed unique strings. Do not resolve OS paths in the persistence layer.

- [ ] **Step 4: Implement attempt mutation APIs**

Add locked public functions:

```typescript
export async function beginWorkflowStepAttempt(
  uid: string,
  cid: string,
  stepId: string,
  input: {
    actor_id: string | null;
    actor_kind: 'agent' | 'anonymous_worker';
    actor_name?: string;
  },
): Promise<WorkflowStep>;

export async function finishWorkflowStepAttempt(
  uid: string,
  cid: string,
  stepId: string,
  input: {
    status: Exclude<WorkflowAttemptStatus, 'running'>;
    failure_code?: WorkflowAttemptFailureCode;
  },
): Promise<WorkflowStep>;
```

The unlocked begin implementation must:

```typescript
const active = await readActiveWorkflowStateUnlocked(uid, cid);
if (!active) throw new Error('active workflow context not found');
const step = active.run.steps.find((candidate) => candidate.id === stepId);
if (!step) throw new Error('workflow step not found');
const attempts = step.attempts || [];
if (attempts.length >= 4) throw new Error('workflow step attempt limit reached');
if (attempts.some((attempt) => attempt.status === 'running')) {
  throw new Error('workflow step already has a running attempt');
}
const now = nowIso();
if (step.original_actor_id === undefined) step.original_actor_id = step.actor_id || null;
step.current_actor_id = input.actor_id;
step.actor_id = input.actor_id;
step.actor_kind = input.actor_kind;
if (input.actor_name) step.actor_name = input.actor_name;
else delete step.actor_name;
step.attempts = [...attempts, {
  attempt: attempts.length + 1,
  actor_id: input.actor_id,
  actor_kind: input.actor_kind,
  ...(input.actor_name ? { actor_name: input.actor_name } : {}),
  status: 'running',
  started_at: now,
}];
active.run.updated_at = now;
await writeRun(uid, cid, active.run);
await appendCollaborationEvent(uid, cid, {
  type: 'step_attempt_started',
  run_id: active.run.id,
  context_id: active.context.id,
  actor_id: input.actor_id,
  step_id: step.id,
  payload: { attempt: step.attempts.length, actor_kind: input.actor_kind },
});
return step;
```

The finish implementation updates only the latest running attempt, stamps `completed_at`, writes the run, and appends `step_attempt_finished` with attempt number, status, and failure code. It must not store task text, output, PID, CLI run id, or raw errors.

- [ ] **Step 5: Ensure retries preserve attempt history**

Keep the existing `retryWorkflowStepUnlocked` cleanup of `started_at`, `completed_at`, result fields, and gate id, but do not delete `attempts`, `original_actor_id`, `required_capabilities`, `access_mode`, or `write_scopes`.

- [ ] **Step 6: Run tests and verify GREEN**

Run `npm test`.

Expected: collaboration attempt and compatibility tests pass with the full suite.

- [ ] **Step 7: Commit**

```bash
git add -- src/main/features/group_chat/collaboration.ts test/main/features/group_chat/collaboration.test.ts
git commit -m "feat(group-chat): persist bounded workflow attempts"
```

---

### Task 3: Extract the Canonical Resume Instruction

**Files:**
- Create: `src/main/features/group_chat/retry_resume.ts`
- Modify: `src/main/features/group_chat/index.ts`
- Modify: `test/main/features/group_chat/failed-turn-retry.test.ts`

- [ ] **Step 1: Add failing shared-builder tests**

Add assertions that the builder:

```typescript
expect(buildRetryResumeModelText({
  originalRequest: 'Build the site',
  uncertainToolState: true,
})).toContain('verify its current state');
expect(buildRetryResumeModelText({
  originalRequest: 'Build the site',
  uncertainToolState: false,
})).toContain('Do not repeat work already verified as successful');
expect(buildRetryResumeModelText({
  originalRequest: 'Build the site',
  uncertainToolState: false,
})).toContain('"Build the site"');
```

Keep the existing manual retry tests unchanged; they must continue to pass after the extraction.

- [ ] **Step 2: Run `npm test` and verify RED**

Expected: `buildRetryResumeModelText` is missing.

- [ ] **Step 3: Create the shared builder**

Create `retry_resume.ts`:

```typescript
export function buildRetryResumeModelText(input: {
  originalRequest: string;
  uncertainToolState: boolean;
  failureCode?: string;
}): string {
  const rules = [
    '<task-retry mode="resume">',
    'Continue the unfinished task from the durable state in this same session.',
    'Read the authoritative execution plan, completed-work ledger, prior tool results, and history resources before acting.',
    'Do not repeat work already verified as successful.',
    input.uncertainToolState
      ? 'A tool started without a confirmed result. Verify its current state before deciding whether to run it again; never blindly repeat an external, paid, destructive, or otherwise non-idempotent operation.'
      : 'If an external, paid, destructive, or otherwise non-idempotent operation has an uncertain outcome, verify its current state before deciding whether to run it again.',
    'Respect every existing confirmation and permission gate. Complete the remaining work or report the smallest blocker that still requires the user.',
    ...(input.failureCode ? [`Recovery reason: ${input.failureCode}.`] : []),
    '</task-retry>',
    '',
    'Authoritative original request (quoted for objective continuity):',
    JSON.stringify(String(input.originalRequest || '')),
  ];
  return rules.join('\n');
}
```

- [ ] **Step 4: Replace the private constant in `index.ts`**

Import the builder and replace the current `RETRY_RESUME_MODEL_TEXT + original request` branch with:

```typescript
model_text: mode === 'resume'
  ? buildRetryResumeModelText({
      originalRequest: originalModelText,
      uncertainToolState: hasToolState,
      failureCode: failed.failure_code,
    })
  : originalModelText,
```

Remove the duplicated `RETRY_RESUME_MODEL_TEXT` constant.

- [ ] **Step 5: Run tests and verify GREEN**

Run `npm test`.

Expected: manual retry behavior remains compatible and the new builder tests pass.

- [ ] **Step 6: Commit**

```bash
git add -- src/main/features/group_chat/retry_resume.ts src/main/features/group_chat/index.ts test/main/features/group_chat/failed-turn-retry.test.ts
git commit -m "refactor(group-chat): share durable retry resume instructions"
```

---

### Task 4: Add Runtime Timer Hosting and Event Normalization

**Files:**
- Create: `src/main/features/group_chat/coordinator_runtime.ts`
- Modify: `test/main/features/group_chat/coordinator-activity.test.ts`
- Modify: `test/main/features/local_agents/runner.test.ts`

- [ ] **Step 1: Add failing normalizer and timer tests**

Cover these mappings:

```typescript
expect(activityFromLocalEvent({ type: 'tool-event', phase: 'use', callId: 'x', tool: 'exec_command' }))
  .toEqual({ kind: 'tool_start', callId: 'x', tool: 'exec_command', longRunning: false });
expect(activityFromLocalEvent({ type: 'tool-event', phase: 'result', callId: 'x', tool: 'exec_command' }))
  .toEqual({ kind: 'tool_result', callId: 'x', tool: 'exec_command' });
expect(activityFromLocalEvent({ type: 'idle', stalledMs: 99_000 }))
  .toEqual({ kind: 'idle_heartbeat' });
expect(activityFromProcessEvent({ stream: 'tool', data: { phase: 'start', call_id: 'x', name: 'bash' } }))
  .toMatchObject({ kind: 'tool_start', callId: 'x' });
expect(activityFromProcessEvent({ stream: 'tool', data: { phase: 'end', call_id: 'x', name: 'bash' } }))
  .toEqual({ kind: 'tool_result', callId: 'x', tool: 'bash' });
```

Use injected timers to assert `startTurnLeaseMonitor` calls `onProbe` once, calls `onAbort` once, and `stop()` clears the interval.

Extend the runner idle test to assert repeated runner `idle` events remain informational and do not change backend `lastEventAt`.

- [ ] **Step 2: Run `npm test` and verify RED**

Expected: the runtime normalizers and monitor host are missing.

- [ ] **Step 3: Implement `coordinator_runtime.ts`**

Export:

```typescript
import type { LocalEvent } from '../local_agents/backends/base';
import {
  TurnActivityTracker,
  type CoordinatorActivityEvent,
  type CoordinatorLeaseConfig,
  type CoordinatorStallReason,
  DEFAULT_COORDINATOR_LEASES,
} from './coordinator_activity';

export interface CoordinatorProcessEvent {
  stream: string;
  data?: Record<string, unknown>;
}

export interface TurnLeaseMonitor {
  observe(event: CoordinatorActivityEvent): void;
  stop(): void;
}

export function probeProcessLiveness(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch { return false; }
}

export function activityFromLocalEvent(event: LocalEvent): CoordinatorActivityEvent {
  if (event.type === 'idle') return { kind: 'idle_heartbeat' };
  if (event.type === 'done') return { kind: 'terminal' };
  if (event.type === 'tool-event') {
    const callId = event.callId ? String(event.callId) : undefined;
    if (event.phase === 'use') {
      return {
        kind: 'tool_start',
        ...(callId ? { callId } : {}),
        tool: String(event.tool || 'tool'),
        longRunning: event.longRunning === true,
      };
    }
    if (event.phase === 'result') return { kind: 'tool_result', ...(callId ? { callId } : {}), tool: String(event.tool || 'tool') };
  }
  return { kind: 'activity' };
}

export function activityFromProcessEvent(event: CoordinatorProcessEvent): CoordinatorActivityEvent {
  const stream = String(event?.stream || '');
  const data = event?.data || {};
  if (stream === 'tool') {
    const phase = String(data.phase || data.status || '').toLowerCase();
    const rawCallId = data.call_id || data.callId || data.id;
    const callId = rawCallId ? String(rawCallId) : undefined;
    if (/^(start|running|request|call|begin)$/.test(phase)) {
      return {
        kind: 'tool_start',
        ...(callId ? { callId } : {}),
        tool: String(data.name || data.toolName || 'tool'),
        longRunning: data.long_running === true,
      };
    }
    if (/^(end|result|completed|done)$/.test(phase)) return { kind: 'tool_result', ...(callId ? { callId } : {}), tool: String(data.name || data.toolName || 'tool') };
  }
  if (stream === 'approval' && String(data.phase || '') === 'waiting') {
    return { kind: 'awaiting_user' };
  }
  if (stream === 'approval' && /^(approved|rejected|cancelled)$/.test(String(data.phase || ''))) {
    return { kind: 'user_resumed' };
  }
  return { kind: 'activity' };
}
```

Implement `startTurnLeaseMonitor` with injected `now`, `setIntervalFn`, and `clearIntervalFn` defaults. Tick every 5 seconds, call tracker `evaluate`, and guarantee each abort is delivered once:

```typescript
export function startTurnLeaseMonitor(input: {
  startedAt: number;
  config?: CoordinatorLeaseConfig;
  onProbe: (idleMs: number) => void;
  onAbort: (reason: CoordinatorStallReason, idleMs: number) => void;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): TurnLeaseMonitor {
  const now = input.now || Date.now;
  const tracker = new TurnActivityTracker(input.startedAt, input.config || DEFAULT_COORDINATOR_LEASES);
  let stopped = false;
  let aborted = false;
  const tick = () => {
    if (stopped || aborted) return;
    const decision = tracker.evaluate(now());
    if (decision.kind === 'probe') input.onProbe(decision.idleMs);
    if (decision.kind === 'abort') {
      aborted = true;
      input.onAbort(decision.reason, decision.idleMs);
    }
  };
  const timer = (input.setIntervalFn || setInterval)(tick, 5_000);
  if (typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref();
  return {
    observe(event) { tracker.observe(event, now()); },
    stop() {
      if (stopped) return;
      stopped = true;
      tracker.observe({ kind: 'terminal' }, now());
      (input.clearIntervalFn || clearInterval)(timer);
    },
  };
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run `npm test`.

- [ ] **Step 5: Commit**

```bash
git add -- src/main/features/group_chat/coordinator_runtime.ts test/main/features/group_chat/coordinator-activity.test.ts test/main/features/local_agents/runner.test.ts
git commit -m "feat(group-chat): host coordinator leases over runtime events"
```

---

### Task 5: Introduce Structured Abort Sources and Nested Outcomes

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `test/main/features/group_chat/bus.test.ts`
- Modify: `test/main/features/group_chat/bus-integration.test.ts`

- [ ] **Step 1: Add failing abort classification tests**

Add tests proving:

1. Group abort produces a non-retryable nested outcome with `abortSource: 'group_abort'`.
2. Coordinator abort produces a failed, retryable nested outcome with `failureCode: 'coordinator_agent_idle'`, not the text “Task was stopped by the user.”
3. A successful nested run still formats the existing `<worker-result>` payload.

Use a bus test seam and assert the structured result rather than matching localized prose:

```typescript
let fireAbort: ((reason: 'tool_idle' | 'agent_idle', idleMs: number) => void) | undefined;
bus._setCoordinatorLeaseFactoryForTest((input) => {
  fireAbort = input.onAbort;
  return { observe() {}, stop() {} };
});
// Start the nested dispatch, then:
fireAbort?.('agent_idle', 480_000);
expect(result).toMatchObject({
  ok: false,
  failureCode: 'coordinator_agent_idle',
  retryable: true,
  abortSource: 'coordinator',
});
expect(result.payload).not.toContain('stopped by the user');
```

The actual seam type should accept `onAbort` and let the test invoke it synchronously.

- [ ] **Step 2: Run `npm test` and verify RED**

Expected: coordinator abort is currently indistinguishable from user/group abort and `runNestedDispatch` only returns a string.

- [ ] **Step 3: Add structured abort state to `WorkerState`**

Add:

```typescript
type TurnAbortSource =
  | { kind: 'group_abort' }
  | { kind: 'parent_abort' }
  | { kind: 'coordinator'; reason: 'tool_idle' | 'agent_idle' };

interface WorkerState {
  // existing fields
  abortSource: TurnAbortSource | null;
}
```

Initialize `abortSource: null` in every WorkerState construction. Before every group/drop abort, assign the source before calling `.abort()`. In nested parent propagation:

```typescript
const abortFromParent = () => {
  w.abortSource = { kind: 'parent_abort' };
  ac.abort(w.abortSource);
};
```

Do not infer user/group abort from localized text.

- [ ] **Step 4: Refactor nested dispatch to return a structure**

Define:

```typescript
type NestedDispatchOutcome =
  | {
      ok: true;
      actor: Actor;
      workflowStepId?: string;
      text: string;
      produced: string[];
      form?: ChatFormPayload;
      payload: string;
    }
  | {
      ok: false;
      actor: Actor;
      workflowStepId?: string;
      text: string;
      produced: string[];
      failureCode: string;
      retryable: boolean;
      abortSource?: TurnAbortSource['kind'];
      payload: string;
    };
```

Change `runNestedDispatch` to return `NestedDispatchOutcome`. Keep `buildWorkerResultPayload`, but extend `buildWorkerErrorPayload` to accept stable attributes:

```typescript
function buildWorkerErrorPayload(
  workerName: string,
  errorText: string,
  opts?: { aborted?: boolean; failureCode?: string; retryable?: boolean },
): string {
  const attrs = [
    opts?.aborted ? 'aborted="true"' : '',
    opts?.failureCode ? `failure_code="${escapeXmlAttr(opts.failureCode)}"` : '',
    opts?.retryable ? 'retryable="true"' : '',
  ].filter(Boolean).join(' ');
  return [
    `<worker-error from="${escapeXmlAttr(workerName)}"${attrs ? ` ${attrs}` : ''}>`,
    escapeXmlText(String(errorText || '').trim() || 'Worker failed without an error message.'),
    '</worker-error>',
  ].join('\n');
}
```

Return `failureCode: coordinator_${reason}` and `retryable: true` for coordinator abort. Return `retryable: false` for `group_abort` and `parent_abort`. Preserve partial text in the structured outcome. Add `workflow_step_id="..."` to both `<worker-result>` and `<worker-error>` root elements when a step id exists, and expose the same id as `outcome.workflowStepId`; this is how a later Commander dispatch can name the step in `depends_on`.

At the three tool call sites, temporarily return `outcome.payload` so behavior stays compatible before the recovery loop lands.

- [ ] **Step 5: Run tests and verify GREEN**

Run `npm test`.

Expected: existing payload tests still pass and new abort classification tests pass.

- [ ] **Step 6: Commit**

```bash
git add -- src/main/features/group_chat/bus.ts test/main/features/group_chat/bus.test.ts test/main/features/group_chat/bus-integration.test.ts
git commit -m "refactor(group-chat): classify nested dispatch abort sources"
```

---

### Task 6: Wire Lease Monitoring into CLI and In-Process Turns

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/model/core-agent/client.ts`
- Modify: `src/main/model/client.ts`
- Modify: `src/main/locales/en.json`
- Modify: `src/main/locales/zh.json`
- Modify: `src/main/locales/ja.json`
- Modify: `src/main/locales/pt.json`
- Modify: `test/main/model/core-agent/client-stall.test.ts`
- Modify: `test/main/features/group_chat/bus-integration.test.ts`

- [ ] **Step 1: Add failing integration tests for the real trap**

Add one CLI-scripted test with events:

```typescript
{ type: 'tool-event', tool: 'exec_command', callId: 'c1', phase: 'use' },
{ type: 'tool-event', tool: 'exec_command', callId: 'c1', phase: 'result', output: 'ok' },
```

Then trigger the injected monitor abort. Assert the failure code is `coordinator_agent_idle`, proving the completed tool was removed from `openTools`.

Add another CLI test with only tool use and assert `coordinator_tool_idle`.

Add an in-process test that sends a `stream:'tool'` start/end pair, then triggers abort and expects `coordinator_agent_idle`.

Assert the emitted process events include a liveness result but no PID:

```typescript
{ stream: 'coordinator', data: { phase: 'probe', reason: 'agent_idle', alive: true } }
{ stream: 'coordinator', data: { phase: 'terminating', reason: 'agent_idle' } }
```

Extend `client-stall.test.ts` so an active mocked model stream makes `hasActiveSession(sessionId)` return true and the settled stream makes it return false:

```typescript
expect(hasActiveSession(sessionId)).toBe(true);
releaseStream();
await runPromise;
expect(hasActiveSession(sessionId)).toBe(false);
```

- [ ] **Step 2: Run `npm test` and verify RED**

Expected: nested turns do not yet start a coordinator monitor or feed it events.

- [ ] **Step 3: Expose a read-only model-session liveness query**

In `src/main/model/core-agent/client.ts`, export:

```typescript
export function hasActiveSession(sessionId: string): boolean {
  return (activeSessionAborts.get(sessionId)?.size || 0) > 0;
}
```

Re-export it from `src/main/model/client.ts` next to `abortActiveSession`. This is read-only and must not mutate or renew a turn. In `bus.ts`, obtain it from the existing dynamic `await import('../../model/client')` call; do not add a static `#core-agent` or model-client import that could run before the SDK timeout patch.

- [ ] **Step 4: Add the testable lease factory seam**

In `bus.ts`, add:

```typescript
type CoordinatorLeaseFactory = typeof startTurnLeaseMonitor;
let _coordinatorLeaseFactory: CoordinatorLeaseFactory = startTurnLeaseMonitor;

export function _setCoordinatorLeaseFactoryForTest(factory?: CoordinatorLeaseFactory): void {
  _coordinatorLeaseFactory = factory || startTurnLeaseMonitor;
}
```

Use this only for tests; production always defaults to the real factory.

- [ ] **Step 5: Start one monitor per workflow-backed nested turn**

At the beginning of `runActorTurn`, after `processItems` is created, declare liveness state and start a monitor only when `item.nested && item.workflow_step_id`:

```typescript
let cliProcessPid: number | undefined;
let inProcessSessionIsActive = () => false;
const coordinatorLease = item.nested && item.workflow_step_id
  ? _coordinatorLeaseFactory({
      startedAt: turnStartedAt,
      onProbe(idleMs) {
        const alive = cliProcessPid
          ? probeProcessLiveness(cliProcessPid)
          : inProcessSessionIsActive();
        const event = { stream: 'coordinator', data: { phase: 'probe', reason: 'agent_idle', idle_ms: idleMs, alive } };
        appendProcessItem(processItems, { type: 'event', event });
        if (actor.kind !== 'worker') emit(state, { type: 'process', cid, actor: actor.id, turn_id: item.turnId, data: { type: 'event', event } });
      },
      onAbort(reason, idleMs) {
        w.abortSource = { kind: 'coordinator', reason };
        const event = { stream: 'coordinator', data: { phase: 'terminating', reason, idle_ms: idleMs } };
        appendProcessItem(processItems, { type: 'event', event });
        if (actor.kind !== 'worker') emit(state, { type: 'process', cid, actor: actor.id, turn_id: item.turnId, data: { type: 'event', event } });
        w.abortController?.abort(w.abortSource);
      },
    })
  : null;
```

Always call `coordinatorLease?.stop()` in the turn `finally` before clearing `w.abortController`.

Track `cliProcessPid` only in memory. Update it from CLI `process-info` events and never include it in process events, logs, workflow JSON, or telemetry. Add `probeProcessLiveness(pid)` to `coordinator_runtime.ts` using `process.kill(pid, 0)` and returning false on error.

- [ ] **Step 6: Feed CLI events**

Extend `_runCliAgentTurn` options with:

```typescript
onCoordinatorActivity?: (event: CoordinatorActivityEvent) => void;
```

At the first line of its local-agent `onEvent` callback, call:

```typescript
opts.onCoordinatorActivity?.(activityFromLocalEvent(e));
```

Extend `_runCliAgentTurn` options with `onProcessInfo?: (pid: number) => void`. In its `process-info` branch, call the callback when `pid` is a positive integer; pass `(pid) => { cliProcessPid = pid; }` from `runActorTurn`. Pass `coordinatorLease?.observe` as `onCoordinatorActivity`.

After the existing dynamic model-client import, set `inProcessSessionIsActive = () => modelClient.hasActiveSession(sessionId)` before starting the in-process stream. Do not use this model-session check for CLI turns.

- [ ] **Step 7: Feed in-process process events and deltas**

Before process events are redacted/persisted, call:

```typescript
if (ev.type === 'delta') coordinatorLease?.observe({ kind: 'activity' });
if (ev.type === 'progress' || ev.type === 'event') {
  const event = processEventForPersistence((ev as { event?: unknown }).event);
  if (event) coordinatorLease?.observe(activityFromProcessEvent(event));
  else coordinatorLease?.observe({ kind: 'activity' });
}
```

Model retry, thinking, plan, usage, file-change, and lifecycle events therefore renew the lease. UI-only `idle` events do not.

When the catch sees `w.abortSource?.kind === 'coordinator'`, classify it as a runtime failure with code `coordinator_${reason}` rather than setting the user-aborted path:

```typescript
const coordinatorAbort = w.abortSource?.kind === 'coordinator' ? w.abortSource : null;
aborted = !!w.abortController?.signal.aborted && !coordinatorAbort;
if (coordinatorAbort) {
  errText = t(`coordinator.${coordinatorAbort.reason}`);
  markTurnFailure('runtime', `coordinator_${coordinatorAbort.reason}`);
}
```

Add these exact main-process translations in this task so no intermediate commit renders a locale key to the user:

```text
en: coordinator.tool_idle = The delegated tool stopped making progress.
en: coordinator.agent_idle = The delegated Agent remained silent after a liveness check.
en: coordinator.exhausted = Automatic recovery did not succeed.
zh: coordinator.tool_idle = 委派工具长时间没有进展。
zh: coordinator.agent_idle = 委派 Agent 在存活探测后仍然没有新事件。
zh: coordinator.exhausted = 自动恢复未成功。
ja: coordinator.tool_idle = 委任されたツールの進行が停止しました。
ja: coordinator.agent_idle = 委任された Agent は稼働確認後も新しいイベントを生成しませんでした。
ja: coordinator.exhausted = 自動復旧に成功しませんでした。
pt: coordinator.tool_idle = A ferramenta delegada parou de apresentar progresso.
pt: coordinator.agent_idle = O Agent delegado permaneceu sem novos eventos após a verificação de atividade.
pt: coordinator.exhausted = A recuperação automática não foi concluída com sucesso.
```

- [ ] **Step 8: Run tests and verify GREEN**

Run `npm test`.

- [ ] **Step 9: Commit**

```bash
git add -- src/main/features/group_chat/bus.ts src/main/model/core-agent/client.ts src/main/model/client.ts src/main/locales/en.json src/main/locales/zh.json src/main/locales/ja.json src/main/locales/pt.json test/main/model/core-agent/client-stall.test.ts test/main/features/group_chat/bus-integration.test.ts
git commit -m "feat(group-chat): monitor nested turns for staged stalls"
```

---

### Task 7: Implement Bounded Recovery Decisions and Agent Ranking

**Files:**
- Create: `src/main/features/group_chat/coordinator_recovery.ts`
- Create: `test/main/features/group_chat/coordinator-recovery.test.ts`

- [ ] **Step 1: Write failing recovery-policy tests**

Cover the complete finite chain:

```typescript
expect(nextRecoveryAction({
  attempts: [{ attempt: 1, actor_kind: 'agent', actor_id: 'a', status: 'failed', failure_code: 'coordinator_agent_idle' }],
  abortSource: 'coordinator',
})).toEqual({ kind: 'retry_same' });

expect(nextRecoveryAction({
  attempts: [
    { attempt: 1, actor_kind: 'agent', actor_id: 'a', status: 'failed', failure_code: 'coordinator_agent_idle' },
    { attempt: 2, actor_kind: 'agent', actor_id: 'a', status: 'failed', failure_code: 'coordinator_agent_idle' },
  ],
  abortSource: 'coordinator',
})).toEqual({ kind: 'select_fallback' });

expect(nextRecoveryAction({ attempts: namedFallbackFailed, abortSource: 'coordinator' }))
  .toEqual({ kind: 'run_anonymous' });
expect(nextRecoveryAction({ attempts: anonymousFailed, abortSource: 'coordinator' }))
  .toEqual({ kind: 'return_commander' });
expect(nextRecoveryAction({ attempts: firstFailure, abortSource: 'group_abort' }))
  .toEqual({ kind: 'stop' });
```

Add ranking tests with two member Agents. Assert explicit required skill wins, failed/busy/disabled candidates are excluded, low scores return `null`, and ties sort by `agent_id`:

```typescript
expect(selectFallbackAgent({
  task: 'review the implementation',
  requiredCapabilities: ['review'],
  members,
  agents,
  failedActorIds: new Set(['original']),
  busyActorIds: new Set(),
})?.actor.id).toBe('reviewer');
expect(selectFallbackAgent({
  task: 'unmatched capability',
  requiredCapabilities: ['nonexistent'],
  members,
  agents,
  failedActorIds: new Set(),
  busyActorIds: new Set(),
  minimumScore: 100,
})).toBeNull();
```

- [ ] **Step 2: Run `npm test` and verify RED**

- [ ] **Step 3: Implement recovery policy**

Create `coordinator_recovery.ts` with:

```typescript
import type { Agent } from '../agents';
import type { Actor } from './state';
import type { WorkflowAttempt } from './collaboration';

export type RecoveryAction =
  | { kind: 'retry_same' }
  | { kind: 'select_fallback' }
  | { kind: 'run_anonymous' }
  | { kind: 'return_commander' }
  | { kind: 'stop' };

export function nextRecoveryAction(input: {
  attempts: WorkflowAttempt[];
  abortSource?: 'group_abort' | 'parent_abort' | 'coordinator';
}): RecoveryAction {
  if (input.abortSource === 'group_abort' || input.abortSource === 'parent_abort') return { kind: 'stop' };
  const attempts = input.attempts || [];
  if (!attempts.length || attempts.length >= 4) return { kind: 'return_commander' };
  const latest = attempts[attempts.length - 1];
  const originalId = attempts[0].actor_id;
  const sameActorFailures = attempts.filter((attempt) => attempt.actor_id === originalId && attempt.status === 'failed').length;
  if (latest.actor_kind === 'anonymous_worker') return { kind: 'return_commander' };
  if (latest.actor_id !== originalId) return { kind: 'run_anonymous' };
  if (attempts.length === 1 && latest.failure_code?.startsWith('coordinator_')) return { kind: 'retry_same' };
  if (sameActorFailures >= 2 || latest.failure_code === 'dependency_failed') return { kind: 'select_fallback' };
  return { kind: 'select_fallback' };
}
```

- [ ] **Step 4: Implement deterministic capability ranking**

Export:

```typescript
export interface FallbackCandidate {
  actor: Actor;
  agent: Agent;
  score: number;
}

export function selectFallbackAgent(input: {
  task: string;
  requiredCapabilities: string[];
  members: Actor[];
  agents: Agent[];
  failedActorIds: ReadonlySet<string>;
  busyActorIds: ReadonlySet<string>;
  minimumScore?: number;
}): FallbackCandidate | null;
```

Normalize English tokens plus Chinese two-character runs. Score exactly:

- +50 when a required capability equals an Agent `skill_list` item or appears in category/name/description/workflow;
- +25 when category matches a required capability or task token;
- up to +20 for unique task-token matches in name/description/workflow;
- up to +20 for unique task-token matches in `skill_list`;
- +5 when `runtime_stats.attempts >= 5` and `runtime_stats.successes / runtime_stats.attempts >= 0.8`.

Exclude non-Agent members, disabled Agents, failed ids, busy ids, and unreadable specs before scoring. Use default `minimumScore = 20`. Sort by descending score then ascending `agent_id`.

Use only the existing `runtime_stats.attempts` and `runtime_stats.successes` counters; do not invent or persist a derived success-rate field.

- [ ] **Step 5: Run tests and verify GREEN**

Run `npm test`.

- [ ] **Step 6: Commit**

```bash
git add -- src/main/features/group_chat/coordinator_recovery.ts test/main/features/group_chat/coordinator-recovery.test.ts
git commit -m "feat(group-chat): add bounded recovery and fallback ranking"
```

---

### Task 8: Execute Same-Agent Retry and the Fallback Chain

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/group_chat/collaboration.ts`
- Modify: `test/main/features/group_chat/collaboration.test.ts`
- Modify: `test/main/features/group_chat/bus-integration.test.ts`

- [ ] **Step 1: Add failing end-to-end recovery tests**

Add integration tests for:

1. First coordinator stall retries the same Agent once and the second attempt succeeds.
2. Retry task text contains `<task-retry mode="resume">`, not a second user message.
3. CLI retry uses the existing CLI session binding; assert the mocked runner receives `resumeSessionId` on attempt two.
4. An uncertain tool start without result produces the “verify its current state” resume instruction.
5. Two original-Agent failures choose the highest-scoring idle member.
6. No eligible member runs one anonymous worker.
7. Anonymous worker failure returns a structured `<worker-error ... failure_code="coordinator_exhausted">` to Commander.
8. Group abort during any attempt stops the chain and starts no fallback.
9. Attempt history never exceeds four rows.

Pin the main assertions:

```typescript
expect(recordedActors).toEqual(['original', 'original', 'reviewer', null]);
expect(retryPrompts[0]).toContain('<task-retry mode="resume">');
expect(retryPrompts[0]).not.toBe(originalUserMessage);
expect(finalOutcome.failureCode).toBe('coordinator_exhausted');
expect((await collaboration.readActiveWorkflowRun(TEST_UID, cid))?.steps[0].attempts).toHaveLength(4);
```

- [ ] **Step 2: Run `npm test` and verify RED**

Expected: only one nested attempt currently runs.

- [ ] **Step 3: Allow a failed step to be prepared for another attempt**

Add `prepareWorkflowStepForRetry(uid, cid, stepId)` in `collaboration.ts`. Under the conversation lock it must:

```typescript
const run = await readWorkflowRun(uid, cid, runIdFromActive);
const step = run?.steps.find((candidate) => candidate.id === stepId);
if (!run || !step) throw new Error('workflow step not found');
if (step.status === 'failed' || step.status === 'blocked' || step.status === 'skipped') {
  await retryWorkflowStepUnlocked(uid, cid, run.id, step.id);
}
const refreshed = await readWorkflowRun(uid, cid, run.id);
const pending = refreshed?.steps.find((candidate) => candidate.id === step.id);
if (!pending || pending.status !== 'pending') throw new Error('workflow step retry preparation failed');
return pending;
```

Do not call the public locked `retryWorkflowStep` from inside the lock.

- [ ] **Step 4: Add one coordinated execution helper in `bus.ts`**

Implement:

```typescript
async function runCoordinatedNestedDispatch(input: {
  state: CidState;
  parentSignal?: AbortSignal;
  initialActor: Actor;
  task: string;
  attachments?: string[];
  outputDelivery: 'final' | 'process';
  kstarDecision?: KStarDecisionRecord;
  prepared: PreparedNestedDispatchStep;
  requiredCapabilities: string[];
}): Promise<NestedDispatchOutcome>;
```

The loop must:

1. call `prepareWorkflowStepForRetry` before attempts after the first;
2. call `beginWorkflowStepAttempt` with the selected actor, but persist `actor_id: null` when `actor.kind === 'worker'`; the ephemeral runtime id remains memory-only;
3. execute only through `runNestedDispatch`;
4. call `finishWorkflowStepAttempt` with completed/failed/cancelled and map failure codes exactly: preserve `coordinator_tool_idle`/`coordinator_agent_idle`, map `missing_cli`/`agent_unavailable` to `dependency_failed`, map group/parent abort to `cancelled` with no failure code, and map every other terminal error to `runtime_failed`;
5. return immediately on success, form blocking, group abort, or parent abort;
6. call `nextRecoveryAction` for failures;
7. for `retry_same`, build task text with `buildRetryResumeModelText({ originalRequest: input.task, uncertainToolState: failureCode === 'coordinator_tool_idle', failureCode })`;
8. for `select_fallback`, read current members, load enabled Agent specs, exclude `state.nestedTurns` actors and prior failed actor ids, then call `selectFallbackAgent`;
9. when no candidate exists, use an anonymous worker;
10. after anonymous failure or the fourth attempt, return a failure with code `coordinator_exhausted`;
11. wrap each attempt so an unexpected throw still calls `finishWorkflowStepAttempt(... status: 'failed', failure_code: 'runtime_failed')`; no terminal path may leave a `running` attempt behind.

Emit process events through the existing actor stream at transitions:

```typescript
{ stream: 'coordinator', data: { phase: 'retry', attempt: 2, actor_id: actor.id } }
{ stream: 'coordinator', data: { phase: 'fallback', attempt: 3, actor_id: fallback.id, actor_name: fallback.name } }
{ stream: 'coordinator', data: { phase: 'anonymous', attempt: 4 } }
{ stream: 'coordinator', data: { phase: 'returned', failure_code: 'coordinator_exhausted' } }
```

Do not put task text, prompt text, tool output, or raw error content in these events. For every transition, also call `log.info('coordinator transition', { cid: maskId(state.cid), step_id: maskId(prepared.step.id), actor_id: maskId(actor.id), phase, attempt, reason, fallback_kind })`; import and use the existing `maskId` helper. Never log the task, prompt, output, PID, write scopes, or raw error.

- [ ] **Step 5: Replace dispatch call sites**

For `dispatch_to` and named `run_worker`, replace the direct `runNestedDispatch` call with `runCoordinatedNestedDispatch` and return `outcome.payload`.

For anonymous `run_worker`, the initial anonymous worker is the final worker tier. If it fails, return the failure to Commander immediately; do not create or retry another anonymous worker.

Pass `required_capabilities` from the tool input once Task 9 adds the schema; until then pass `[]`.

- [ ] **Step 6: Run tests and verify GREEN**

Run `npm test`.

- [ ] **Step 7: Commit**

```bash
git add -- src/main/features/group_chat/bus.ts src/main/features/group_chat/collaboration.ts test/main/features/group_chat/collaboration.test.ts test/main/features/group_chat/bus-integration.test.ts
git commit -m "feat(group-chat): recover stalled nested dispatches"
```

---

### Task 9: Add Dependency and Read/Write Scope Admission

**Files:**
- Create: `src/main/features/group_chat/coordinator_admission.ts`
- Create: `test/main/features/group_chat/coordinator-admission.test.ts`
- Modify: `src/main/features/group_chat/collaboration.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/util/locks.ts`
- Modify: `test/main/features/group_chat/collaboration.test.ts`
- Modify: `test/main/features/group_chat/bus-integration.test.ts`

- [ ] **Step 1: Write failing admission tests**

Test the pure conflict matrix:

```typescript
expect(accessRequestsConflict(
  { mode: 'read', scopes: ['/w/a'] },
  { mode: 'read', scopes: ['/w/a'] },
)).toBe(false);
expect(accessRequestsConflict(
  { mode: 'write', scopes: ['/w/a'] },
  { mode: 'read', scopes: ['/w/a/file.txt'] },
)).toBe(true);
expect(accessRequestsConflict(
  { mode: 'write', scopes: ['/w/a'] },
  { mode: 'write', scopes: ['/w/b'] },
)).toBe(false);
```

Test `CoordinatorAccessAdmission.acquire` queues a conflicting request, releases it after the first lease, and rejects an aborted waiter with an AbortError without a lock timeout.

Add collaboration tests proving a prepared nested step cannot start until all `depends_on` steps are completed/skipped and that metadata persists.

Add integration coverage proving three explicit read tasks run concurrently, a fourth waits on `dispatchSlots`, and overlapping writes serialize.

- [ ] **Step 2: Run `npm test` and verify RED**

- [ ] **Step 3: Implement access admission**

Create `coordinator_admission.ts` with:

```typescript
import * as path from 'node:path';

export interface CoordinatorAccessRequest {
  mode: 'read' | 'write';
  scopes: string[];
}

function containsPath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

export function accessRequestsConflict(a: CoordinatorAccessRequest, b: CoordinatorAccessRequest): boolean {
  if (a.mode === 'read' && b.mode === 'read') return false;
  return a.scopes.some((left) => b.scopes.some((right) => containsPath(left, right) || containsPath(right, left)));
}

export class CoordinatorAccessAdmission {
  private active: CoordinatorAccessRequest[] = [];
  private waiters: Array<{
    request: CoordinatorAccessRequest;
    signal?: AbortSignal;
    onAbort?: () => void;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
  }> = [];

  async acquire(request: CoordinatorAccessRequest, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw this.abortError();
    if (!this.conflictsWithActive(request)) return this.activate(request);
    return new Promise<() => void>((resolve, reject) => {
      const waiter = { request, signal, resolve, reject } as typeof this.waiters[number];
      waiter.onAbort = () => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(this.abortError());
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private conflictsWithActive(request: CoordinatorAccessRequest): boolean {
    return this.active.some((active) => accessRequestsConflict(active, request));
  }

  private activate(request: CoordinatorAccessRequest): () => void {
    let released = false;
    this.active.push(request);
    return () => {
      if (released) return;
      released = true;
      const index = this.active.indexOf(request);
      if (index >= 0) this.active.splice(index, 1);
      this.drain();
    };
  }

  private drain(): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.signal?.aborted || this.conflictsWithActive(waiter.request)) continue;
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(this.activate(waiter.request));
    }
  }

  private abortError(): Error {
    return Object.assign(new Error('Aborted'), { name: 'AbortError' });
  }
}
```

Use one `CoordinatorAccessAdmission` per cid in `CidState`; clear it in `dropConv` by aborting waiters through their existing parent/group signals rather than adding a timeout.

- [ ] **Step 4: Extend nested dispatch metadata and readiness checks**

Extend `PrepareNestedDispatchStepInput` and `PlanWorkflowStepInput` with:

```typescript
depends_on?: string[];
required_capabilities?: string[];
access_mode?: 'read' | 'write';
write_scopes?: string[];
```

Persist those fields when creating a step. On resume, validate exact equality so a resume capability cannot be reused with a different dependency/access contract.

In `startPreparedNestedDispatchStepUnlocked`, copy the dependency check already used by `startPlannedWorkflowStepUnlocked`:

```typescript
const completed = new Set(run.steps
  .filter((candidate) => candidate.status === 'completed' || candidate.status === 'skipped')
  .map((candidate) => candidate.id));
const missing = (step.depends_on || []).filter((dependency) => !completed.has(dependency));
if (missing.length) throw new Error(`workflow step dependencies incomplete: ${missing.join(', ')}`);
```

At the dispatch-tool boundary, catch only this stable dependency error and return a blocked tool result containing `workflow_step_id`, `resume_token`, and `missing_dependencies`. Do not wait inside the current model tool call and do not enqueue a new turn; Commander may retry the same prepared step after its dependencies complete.

- [ ] **Step 5: Add tool schema fields**

Add the same optional properties to `dispatch_to`, `hand_off_to`, and `run_worker`:

```typescript
depends_on: { type: 'array', items: { type: 'string' } },
required_capabilities: { type: 'array', items: { type: 'string' } },
access_mode: { type: 'string', enum: ['read', 'write'] },
write_scopes: { type: 'array', items: { type: 'string' } },
```

Tool descriptions must state:

- use `read` only when the task will not modify workspace state;
- use `write` for file/code/config mutations;
- write scopes are workspace-relative paths;
- omitted `access_mode` defaults to `write` and locks the whole conversation workspace;
- dependencies are workflow step ids returned on prior `<worker-result>` / `<worker-error>` tool results.

Do not duplicate these schemas into prompt markdown. Update existing parallel fan-out integration fixtures to pass `access_mode: 'read'`; write-capable fixtures must declare non-overlapping `write_scopes` if they are expected to remain parallel.

- [ ] **Step 6: Normalize and sandbox scopes in `bus.ts`**

Before admission:

```typescript
function resolveCoordinatorAccess(
  workingDir: string,
  modeRaw: unknown,
  scopesRaw: unknown,
): CoordinatorAccessRequest {
  const mode = modeRaw === 'read' ? 'read' : 'write';
  const declared = Array.isArray(scopesRaw)
    ? scopesRaw.map((scope) => String(scope || '').trim()).filter(Boolean)
    : [];
  const resolved = declared.map((scope) => path.resolve(workingDir, scope));
  if (resolved.some((scope) => !isPathAllowed(scope, [workingDir]))) {
    throw new Error('write_scopes must stay inside the conversation workspace');
  }
  return {
    mode,
    scopes: resolved.length ? [...new Set(resolved)].sort() : [path.resolve(workingDir)],
  };
}
```

Reject any non-empty declared scope that falls outside the working directory; do not silently widen permission. Resolve and acquire the access lease once at the start of `runCoordinatedNestedDispatch`, before the attempt loop, and release it in the helper's outer `finally` after success/exhaustion/abort. Each attempt continues to acquire and release `dispatchSlots` inside `runNestedDispatch`; do not hold a dispatch slot across retry planning, but do hold the logical step's access lease across its recovery chain.

- [ ] **Step 7: Change the default nested concurrency to 3**

In `src/main/util/locks.ts`:

```typescript
return Number.isFinite(n) && n > 0 ? n : 3;
```

Do not reuse `maxToolLoopsForActorKind`; it is a turn tool-loop budget, not a concurrency budget.

- [ ] **Step 8: Run tests and verify GREEN**

Run `npm test`.

- [ ] **Step 9: Commit**

```bash
git add -- src/main/features/group_chat/coordinator_admission.ts test/main/features/group_chat/coordinator-admission.test.ts src/main/features/group_chat/collaboration.ts src/main/features/group_chat/bus.ts src/main/util/locks.ts test/main/features/group_chat/collaboration.test.ts test/main/features/group_chat/bus-integration.test.ts
git commit -m "feat(group-chat): gate dispatches by dependencies and write scopes"
```

---

### Task 10: Make `hand_off_to` Commit the Floor Only After Successful Recovery

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `test/main/features/group_chat/bus-integration.test.ts`

- [ ] **Step 1: Add failing hand-off tests**

Cover:

1. Interactive original Agent stalls, fallback Agent succeeds, and `active_recipient` becomes the fallback id.
2. Every attempt fails and `active_recipient` is absent/Commander.
3. `onTerminalHandoff` fires only after a successful final-delivery outcome.
4. Resume ledger `owner_agent_id` and `owner_agent_name` use the final successful Agent.
5. A form-blocked successful hand-off pauses recovery and retains the form owner.

Pin the floor/ledger assertions:

```typescript
expect((await state.readState(TEST_UID, fallbackCid)).active_recipient).toBe(fallbackId);
expect((await state.readState(TEST_UID, exhaustedCid)).active_recipient).toBeUndefined();
expect((await state.readState(TEST_UID, fallbackCid)).orchestration_ledger?.owner_agent_id).toBe(fallbackId);
expect(terminalHandoffCalls).toBe(1);
```

- [ ] **Step 2: Run `npm test` and verify RED**

Expected: current `hand_off_to` sets the interactive floor before the Agent runs.

- [ ] **Step 3: Move hand-off state changes after success**

Remove the pre-run `setActiveRecipient` and ledger write. Call `runCoordinatedNestedDispatch` first. If `outcome.ok === false`, return `{ content: outcome.payload }` without `endTurn` and without calling `onTerminalHandoff`.

For success:

```typescript
const finalAgent = outcome.actor.kind === 'agent'
  ? await agentsFeat.getAgent(outcome.actor.id)
  : null;
if (!finalAgent) return _toolError('hand_off_to completed without a named agent');

if (finalAgent.interactive === true) {
  await setActiveRecipient(uid, cid, finalAgent.agent_id);
  if (resume) {
    await setOrchestrationLedger(uid, cid, {
      status: 'waiting_for_agent',
      blocked_on: 'agent_handoff',
      source_tool: 'hand_off_to',
      owner_agent_id: finalAgent.agent_id,
      owner_agent_name: finalAgent.name,
      user_goal: _clipForOrchestration(_unwrapLlmTurnPayload(currentTurnPayload) || currentTurnPayload),
      handoff_message: message,
      resume_instruction: resume,
    });
  }
} else {
  await setActiveRecipient(uid, cid, COMMANDER_ID);
}
```

Use `outcome.payload` and `outcome.actor` for form-ledger/resume handling. Only then call `onTerminalHandoff()` and return `endTurn: true`.

If state persistence after a successful Agent reply fails, log `warn`, restore Commander as floor, and return a tool error so the Commander can explain the state mismatch; do not claim successful terminal delivery.

- [ ] **Step 4: Run tests and verify GREEN**

Run `npm test`.

- [ ] **Step 5: Commit**

```bash
git add -- src/main/features/group_chat/bus.ts test/main/features/group_chat/bus-integration.test.ts
git commit -m "fix(group-chat): finalize handoff after successful recovery"
```

---

### Task 11: Render Accurate Idle, Retry, and Fallback Status

**Files:**
- Modify: `src/renderer/modules/conversation.js`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Modify: `test/renderer/conversation-sidebar.test.ts`
- Modify: `test/main/features/group_chat/bus-integration.test.ts`

- [ ] **Step 1: Add failing renderer formatting tests**

Assert:

```typescript
expect(context._formatEventLine({
  stream: 'cli',
  data: { type: 'idle', stalledMs: 99_000 },
})).toBe('Agent has produced no new events for 1m 39s');

expect(context._formatEventLine({
  stream: 'coordinator',
  data: { phase: 'retry', attempt: 2 },
})).toBe('Retrying with the same Agent from saved progress');

expect(context._formatEventLine({
  stream: 'coordinator',
  data: { phase: 'fallback', actor_name: 'Reviewer' },
})).toBe('The original Agent failed again; continuing with Reviewer');
```

Run the renderer test under its existing English locale fixture. Add integration assertions that coordinator process events persist on the actor turn and contain no prompt/task/output fields. Add a renderer test with a stubbed `window.Monitor.event` and assert coordinator telemetry contains only `phase`, `reason`, `attempt`, and `fallback_kind`.

- [ ] **Step 2: Run `npm test` and verify RED**

- [ ] **Step 3: Add locale keys to all renderer locales**

Add these exact keys to each renderer locale.

English:

```json
{
  "chat.stream.agent_idle": "Agent has produced no new events for {duration}",
  "chat.stream.coordinator_probe": "Checking whether the Agent is still running",
  "chat.stream.coordinator_terminating_tool": "The tool has made no progress; stopping this attempt",
  "chat.stream.coordinator_terminating_agent": "The Agent remained silent after a liveness check; stopping this attempt",
  "chat.stream.coordinator_retry": "Retrying with the same Agent from saved progress",
  "chat.stream.coordinator_fallback": "The original Agent failed again; continuing with {name}",
  "chat.stream.coordinator_anonymous": "No suitable conversation member is available; using a temporary worker",
  "chat.stream.coordinator_returned": "Automatic recovery did not succeed; returned to Commander"
}
```

Chinese:

```json
{
  "chat.stream.agent_idle": "Agent 暂无新事件，已等待 {duration}",
  "chat.stream.coordinator_probe": "正在检查 Agent 是否仍在运行",
  "chat.stream.coordinator_terminating_tool": "工具长时间没有进展，正在终止本次执行",
  "chat.stream.coordinator_terminating_agent": "Agent 在存活探测后仍无新事件，正在终止本次执行",
  "chat.stream.coordinator_retry": "正在让原 Agent 从已有进度恢复",
  "chat.stream.coordinator_fallback": "原 Agent 再次失败，改由 {name} 继续",
  "chat.stream.coordinator_anonymous": "没有合适的会话成员，正在使用临时 worker",
  "chat.stream.coordinator_returned": "自动恢复未成功，已交还 Commander"
}
```

Japanese:

```json
{
  "chat.stream.agent_idle": "Agent から新しいイベントがありません（待機時間: {duration}）",
  "chat.stream.coordinator_probe": "Agent が実行中か確認しています",
  "chat.stream.coordinator_terminating_tool": "ツールの進行が停止したため、この試行を終了します",
  "chat.stream.coordinator_terminating_agent": "稼働確認後も Agent が応答しないため、この試行を終了します",
  "chat.stream.coordinator_retry": "保存済みの進捗から同じ Agent で再開しています",
  "chat.stream.coordinator_fallback": "元の Agent が再度失敗したため、{name} が続行します",
  "chat.stream.coordinator_anonymous": "適切な会話メンバーがいないため、一時 worker を使用します",
  "chat.stream.coordinator_returned": "自動復旧に成功しなかったため、Commander に戻しました"
}
```

Portuguese:

```json
{
  "chat.stream.agent_idle": "O Agent não produziu novos eventos por {duration}",
  "chat.stream.coordinator_probe": "Verificando se o Agent ainda está em execução",
  "chat.stream.coordinator_terminating_tool": "A ferramenta não apresentou progresso; encerrando esta tentativa",
  "chat.stream.coordinator_terminating_agent": "O Agent permaneceu sem novos eventos após a verificação; encerrando esta tentativa",
  "chat.stream.coordinator_retry": "Retomando o progresso salvo com o mesmo Agent",
  "chat.stream.coordinator_fallback": "O Agent original falhou novamente; {name} continuará",
  "chat.stream.coordinator_anonymous": "Nenhum membro adequado está disponível; usando um worker temporário",
  "chat.stream.coordinator_returned": "A recuperação automática falhou; a tarefa voltou ao Commander"
}
```

The main-process failure keys were added in Task 6; do not duplicate or rename them here.

- [ ] **Step 4: Format CLI idle at actor level**

Replace the hard-coded CLI idle line with:

```javascript
if (cliType === 'idle') {
  const ms = Number(data?.stalledMs || 0);
  return t('chat.stream.agent_idle', { duration: _formatProcessDuration(ms) });
}
```

The CLI tool `end/result` row must remain closed; the idle event is a separate process line. Do not mutate a prior tool row.

- [ ] **Step 5: Format coordinator events**

Before the generic fallback in `_formatEventLine`, add:

```javascript
if (stream === 'coordinator') {
  const phase = String(data?.phase || '');
  if (phase === 'probe') return t('chat.stream.coordinator_probe');
  if (phase === 'terminating') {
    return data?.reason === 'tool_idle'
      ? t('chat.stream.coordinator_terminating_tool')
      : t('chat.stream.coordinator_terminating_agent');
  }
  if (phase === 'retry') return t('chat.stream.coordinator_retry');
  if (phase === 'fallback') return t('chat.stream.coordinator_fallback', { name: data?.actor_name || data?.actor_id || 'Agent' });
  if (phase === 'anonymous') return t('chat.stream.coordinator_anonymous');
  if (phase === 'returned') return t('chat.stream.coordinator_returned');
  return null;
}
```

Update `_eventProcessKind` with this branch before its generic fallback:

```javascript
if (evt?.stream === 'coordinator') {
  const phase = String(evt?.data?.phase || '');
  return phase === 'terminating' || phase === 'returned' ? 'warn' : 'info';
}
```

Add a live-event telemetry helper and call it from `_renderAgentEvent` only, not from history formatting:

```javascript
function _monitorCoordinatorEvent(data) {
  if (!window.Monitor || typeof window.Monitor.event !== 'function') return;
  const phase = String(data?.phase || '');
  const action = phase === 'terminating' ? 'coordinator_stall_detected'
    : phase === 'retry' ? 'coordinator_retry_started'
      : phase === 'fallback' || phase === 'anonymous' ? 'coordinator_fallback_started'
        : phase === 'returned' ? 'coordinator_returned_to_commander'
          : '';
  if (!action) return;
  window.Monitor.event(action, {
    phase,
    reason: String(data?.reason || ''),
    attempt: Number(data?.attempt || 0),
    fallback_kind: phase === 'fallback' ? 'named' : phase === 'anonymous' ? 'anonymous' : '',
  });
}
```

Do not send actor names, task text, output, paths, or errors.

- [ ] **Step 6: Run tests and verify GREEN**

Run `npm test`.

- [ ] **Step 7: Commit**

```bash
git add -- src/renderer/modules/conversation.js src/renderer/locales/en.json src/renderer/locales/zh.json src/renderer/locales/ja.json src/renderer/locales/pt.json test/renderer/conversation-sidebar.test.ts test/main/features/group_chat/bus-integration.test.ts
git commit -m "feat(renderer): show coordinator recovery status"
```

---

### Task 12: Complete Cross-Layer Verification and Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-31-multi-agent-coordinator-stall-recovery-design.md`
- Modify tests only if verification reveals a missing invariant; do not weaken assertions.

- [ ] **Step 1: Mark the approved/delivered design state**

Confirm the design header is `已批准`. After all tasks pass, add a short “Implementation notes” section listing the actual coordinator module paths and any deliberately deferred item. The only permitted deferred item is restoring a user-visible `plan_set` adapter; the runtime must not depend on it.

- [ ] **Step 2: Run type checking**

Run:

```bash
npm run typecheck
```

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 3: Run the full test suite through the required wrapper**

Run:

```bash
npm test
```

Expected: JavaScript/TypeScript and resource suites both pass. Do not replace this with direct Vitest invocation.

- [ ] **Step 4: Run platform-native verification available on macOS**

Run:

```bash
npm run test:platform-native
```

Expected: macOS process and native-path checks pass. Record Windows process-tree/PID liveness verification as required CI/manual follow-up on a Windows machine; do not claim Windows verification from macOS.

- [ ] **Step 5: Run repository hygiene checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. `git status` may still show the user's pre-existing authorization/settings changes, but coordinator files must be clean after their commits.

- [ ] **Step 6: Perform a manual smoke test**

Start the app using the repository command:

```bash
./run.sh
```

Verify with a test CLI Agent or scripted dev run:

1. a completed `pwd && ls` tool row closes immediately;
2. a later idle heartbeat displays at actor level;
3. the automated integration test suite demonstrates probe → termination → retry without waiting eight real minutes;
4. user Stop prevents retry/fallback;
5. a fallback Agent updates the visible actor attribution;
6. no raw prompt, stderr, or OS path appears in coordinator events.

Stop the app with the existing repository stop flow after verification.

- [ ] **Step 7: Final focused audit**

Search for accidental alternate paths:

```bash
rg -n "child_process|spawn\(" src/main/features/group_chat src/main/features/local_agents
rg -n "runCoordinatedNestedDispatch|runNestedDispatch|dispatchSlots" src/main/features/group_chat/bus.ts
rg -n "coordinator_.*(task|prompt|output|stderr)" src/main test
```

Expected:

- no new CLI spawn outside `features/local_agents/runner.ts` and backend files;
- every automatic attempt passes through `runNestedDispatch`;
- coordinator persisted/logged events contain no raw task/prompt/output/stderr fields.

- [ ] **Step 8: Commit documentation and any verification-only fixes**

```bash
git add -- docs/superpowers/specs/2026-07-31-multi-agent-coordinator-stall-recovery-design.md
git commit -m "docs: record multi-agent coordinator implementation"
```

If verification required code/test fixes, commit those exact files separately before the documentation commit with a scoped `fix(group-chat): ...` message.

---

## Verification Matrix

| Requirement | Primary tests/tasks |
|---|---|
| Tool result followed by silence is Agent idle | Tasks 1, 6 |
| Tool without result uses 120-second lease | Tasks 1, 6 |
| Agent probe at 5 minutes, abort at 8 minutes | Tasks 1, 4, 6 |
| Runner idle heartbeat does not renew activity | Tasks 1, 4 |
| User/group abort never retries | Tasks 5, 7, 8 |
| Same Agent resumes once without replaying user message | Tasks 3, 8 |
| Non-idempotent uncertain tool is verified before replay | Tasks 3, 8 |
| Capability-matched member fallback | Tasks 7, 8 |
| Anonymous worker then Commander fallback | Tasks 7, 8 |
| Attempt count capped at four | Tasks 2, 7, 8 |
| Dependency and write-scope admission | Task 9 |
| Nested concurrency defaults to three | Task 9 |
| `hand_off_to` commits final successful actor only | Task 10 |
| Accurate localized process rail | Task 11 |
| No second enqueue/spawn path | Tasks 8, 9, 12 |
| Privacy-safe logs/events | Tasks 2, 8, 11, 12 |
| macOS verification and explicit Windows follow-up | Task 12 |

## Key Changes

- Add a reusable activity classifier instead of overloading `lastEventAt`.
- Preserve existing 90-second informational heartbeat, 30-minute CLI idle watchdog, and 2-hour zombie cap.
- Introduce structured abort sources so coordinator cancellation is not mistaken for user Stop.
- Persist a maximum of four privacy-safe attempts on one logical workflow step.
- Reuse durable session state and a canonical resume instruction for the one same-Agent retry.
- Deterministically rank only current, enabled, idle conversation members for fallback.
- Serialize unsafe writes with abortable, timeout-free access admission.
- Keep all actual Agent execution in `bus.ts::runNestedDispatch` and all CLI spawn in `local_agents/runner.ts`.
- Move hand-off floor/ledger mutation after the final successful Agent is known.
- Render actor-level idle and recovery transitions through existing i18n.

## Next Skill

Use **`$superpower-subagents`** for task-by-task execution with review between tasks, or **`$superpower-executing-plans`** for inline batch execution with checkpoints.
