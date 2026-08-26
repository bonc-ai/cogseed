// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P0-04 + RC-P0-05 — app-restart reconciliation and the action semantics
// that must ship with it. These are one indivisible change: recovery without
// the action semantics turns a `running` zombie into a `recoverable` zombie
// (which `taskActions()` gives *zero* actions), and the action semantics
// without recovery describe a state nothing ever produces.
//
// Why Group Chat is failed rather than made recoverable: `group_chat/index.ts`
// heals an orphaned run by setting the conversation to `idle` — it abandons the
// run, and offers no resume at all. A `recoverable` shadow task would advertise
// a capability the upstream does not have.
//
// These tests use the real task store against a real temp workspace; only the
// display projection is stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-restart-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-restart-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  return {
    tasks: await import('../../../../src/main/features/cogseed_backend/task-store'),
    lifecycle: await import('../../../../src/main/features/cogseed_backend/lifecycle'),
    recovery: await import('../../../../src/main/features/cogseed_backend/recovery'),
    events: await import('../../../../src/main/features/cogseed_backend/event-store'),
  };
}

/** A group-chat parent run task, advanced to `running` the way the bridge does. */
async function groupChatRun(suffix: string, opts: { status?: 'created' | 'queued' | 'running' } = {}) {
  const { tasks, lifecycle } = await modules();
  const task = (await tasks.createCogSeedTask(USER, {
    requestId: `req-groupchat-run-${suffix}`,
    task: 'Conversation task',
    sessionId: `gconv-cid-${suffix}`,
    conversationId: `cid-${suffix}`,
    executionKind: 'group-chat',
    groupChatRunId: `run-${suffix}`,
    groupChatSourceMessageId: `msg-src-${suffix}`,
  })).task;
  const target = opts.status ?? 'running';
  if (target === 'created') return task;
  await lifecycle.transitionCogSeedTask(USER, task.taskId, 'queued');
  if (target === 'queued') return (await tasks.readCogSeedTask(USER, task.taskId))!;
  await lifecycle.transitionCogSeedTask(USER, task.taskId, 'running');
  return (await tasks.readCogSeedTask(USER, task.taskId))!;
}

/** An actor-turn child task, as `startTurn` builds it. */
async function groupChatTurn(suffix: string, parentTaskId: string) {
  const { tasks, lifecycle } = await modules();
  const task = (await tasks.createCogSeedTask(USER, {
    requestId: `req-groupchat-turn-${suffix}`,
    task: 'Conversation turn',
    sessionId: `gconv-cid-${suffix}`,
    conversationId: `cid-${suffix}`,
    executionKind: 'group-chat',
    agentId: `agent-${suffix}`,
    groupChatRunId: `run-${suffix}`,
    groupChatTurnId: `turn-${suffix}`,
    groupChatSourceMessageId: `msg-src-${suffix}`,
    parentTaskId,
    coordinationDepth: 1,
  })).task;
  await lifecycle.transitionCogSeedTask(USER, task.taskId, 'queued');
  await lifecycle.transitionCogSeedTask(USER, task.taskId, 'running');
  return (await tasks.readCogSeedTask(USER, task.taskId))!;
}

/**
 * Every task these helpers build is stamped "now", so to simulate a *previous*
 * process the boundary is pushed into the future. Real production uses
 * `PROCESS_STARTED_AT` from storage.ts.
 *
 * The boundary must come from `nowIso()`, not `toISOString()`: task timestamps
 * are local, second-precision and unsuffixed, so mixing in a UTC string makes
 * every lexicographic comparison wrong in the same direction — the tests would
 * still pass while the guard silently did nothing.
 */
const FUTURE_BOUNDARY = '2099-01-01T00:00:00';

/** Sweep as a later process would: everything on disk predates the boundary. */
const asPreviousProcess = {
  projectTaskEvent: vi.fn(async () => undefined),
  processStartedAt: FUTURE_BOUNDARY,
} as never;

/** Sweep as this process: nothing on disk predates the boundary. */
const asThisProcess = {
  projectTaskEvent: vi.fn(async () => undefined),
  processStartedAt: '2000-01-01T00:00:00',
} as never;

const noProjection = asPreviousProcess;

describe('RC-P0-04 startup reconciliation', () => {
  it('fails a running group-chat parent run task with app_restart', async () => {
    const { tasks, recovery } = await modules();
    const run = await groupChatRun('a');

    await recovery.recoverCogSeedTasks(USER, noProjection);

    await expect(tasks.readCogSeedTask(USER, run.taskId)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'app_restart',
    });
  });

  it('fails an actor-turn child task the same way', async () => {
    const { tasks, recovery } = await modules();
    const run = await groupChatRun('b');
    const turn = await groupChatTurn('b', run.taskId);

    await recovery.recoverCogSeedTasks(USER, noProjection);

    // Parent and child are treated identically — both only ever terminate via
    // `finishTask`, so both strand at `running`.
    for (const taskId of [run.taskId, turn.taskId]) {
      await expect(tasks.readCogSeedTask(USER, taskId)).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'app_restart',
      });
    }
  });

  // The transition table forbade created→failed and queued→failed before this
  // change, so these two cases silently could not be reconciled at all.
  it.each(['created', 'queued', 'running'] as const)(
    'reconciles a group-chat task stranded at %s',
    async (status) => {
      const { tasks, recovery } = await modules();
      const run = await groupChatRun(`s-${status}`, { status });

      await recovery.recoverCogSeedTasks(USER, noProjection);

      await expect(tasks.readCogSeedTask(USER, run.taskId)).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'app_restart',
      });
    },
  );

  it('leaves no recoverable group-chat task behind, ever', async () => {
    const { tasks, recovery } = await modules();
    await groupChatRun('c1', { status: 'created' });
    await groupChatRun('c2', { status: 'queued' });
    const running = await groupChatRun('c3');
    await groupChatTurn('c3', running.taskId);

    await recovery.recoverCogSeedTasks(USER, noProjection);

    const all = await tasks.listCogSeedTasks(USER);
    const groupChat = all.filter((task) => task.executionKind === 'group-chat');
    expect(groupChat).toHaveLength(4);
    // The whole point of RC-P0-04: a running zombie must not become a
    // recoverable zombie.
    expect(groupChat.filter((task) => task.status === 'recoverable')).toEqual([]);
    expect(groupChat.every((task) => task.status === 'failed')).toBe(true);
  });

  it('heals a pre-existing recoverable group-chat task', async () => {
    const { tasks, lifecycle, recovery } = await modules();
    const run = await groupChatRun('legacy');
    // What the old recovery would have produced.
    await lifecycle.markCogSeedTaskRecoverable(USER, run.taskId, 'worker_restart');

    await recovery.recoverCogSeedTasks(USER, noProjection);

    await expect(tasks.readCogSeedTask(USER, run.taskId)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'app_restart',
    });
  });

  it('leaves a waiting_user group-chat task alone', async () => {
    const { tasks, lifecycle, recovery } = await modules();
    const run = await groupChatRun('wait');
    await lifecycle.transitionCogSeedTask(USER, run.taskId, 'waiting_user');

    await recovery.recoverCogSeedTasks(USER, noProjection);

    // `waiting_user` waits on a person, not a process. The conversation
    // survives the restart and the user can still answer, so failing it here
    // would destroy real state.
    await expect(tasks.readCogSeedTask(USER, run.taskId)).resolves.toMatchObject({ status: 'waiting_user' });
  });

  it('keeps the existing recoverable behaviour for non-group-chat tasks', async () => {
    const { tasks, lifecycle, recovery } = await modules();
    const native = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-native-1',
      task: 'Native task.',
      conversationId: 'cid-native',
      agentId: 'agent-native',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'running');

    const report = await recovery.recoverCogSeedTasks(USER, noProjection);

    await expect(tasks.readCogSeedTask(USER, native.taskId)).resolves.toMatchObject({
      status: 'recoverable',
      errorCode: 'worker_restart',
    });
    expect(report.recoveredCount).toBe(1);
    expect(report.groupChatFailedCount ?? 0).toBe(0);
  });

  it('reports both branches separately in one mixed sweep', async () => {
    const { tasks, lifecycle, recovery } = await modules();
    await groupChatRun('mix');
    const native = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-native-mix',
      task: 'Native mixed.',
      conversationId: 'cid-native-mix',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'queued');

    const report = await recovery.recoverCogSeedTasks(USER, noProjection);

    expect(report).toMatchObject({ recoveredCount: 1, groupChatFailedCount: 1, dispatchedCount: 0 });
    expect(report.taskIds).toHaveLength(2);
  });

  it('is idempotent across repeated sweeps', async () => {
    const { tasks, recovery } = await modules();
    const run = await groupChatRun('idem');

    const first = await recovery.recoverCogSeedTasks(USER, noProjection);
    const second = await recovery.recoverCogSeedTasks(USER, noProjection);

    expect(first.groupChatFailedCount).toBe(1);
    // `failed` is terminal, so the second pass finds nothing to do rather than
    // attempting an illegal second transition.
    expect(second.groupChatFailedCount).toBe(0);
    expect(second.recoveredCount).toBe(0);

    const after = await tasks.readCogSeedTask(USER, run.taskId);
    expect(after).toMatchObject({ status: 'failed', errorCode: 'app_restart' });

    // And exactly one task.failed event was recorded, not two.
    const { events } = await modules();
    const failedEvents = (await events.readCogSeedTaskEvents(USER, run.taskId, 0, 50))
      .filter((event) => event.type === 'task.failed');
    expect(failedEvents).toHaveLength(1);
  });

  it('does not abort the sweep when one task cannot be reconciled', async () => {
    const first = await groupChatRun('err1');
    const second = await groupChatRun('err2');

    // Make the transition fail for exactly one task, leaving the rest healthy.
    const real = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    vi.doMock('../../../../src/main/features/cogseed_backend/lifecycle', () => ({
      ...real,
      transitionCogSeedTask: vi.fn(async (userId: string, taskId: string, ...rest: unknown[]) => {
        if (taskId === first.taskId) throw new Error('simulated transition failure');
        return (real.transitionCogSeedTask as never as (...args: unknown[]) => unknown)(userId, taskId, ...rest);
      }),
    }));
    vi.resetModules();

    const recovery = await import('../../../../src/main/features/cogseed_backend/recovery');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const report = await recovery.recoverCogSeedTasks(USER, noProjection);

    // The healthy task was still reconciled...
    await expect(tasks.readCogSeedTask(USER, second.taskId)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'app_restart',
    });
    // ...the failing one was left for the next startup, not counted as done...
    await expect(tasks.readCogSeedTask(USER, first.taskId)).resolves.toMatchObject({ status: 'running' });
    expect(report.groupChatFailedCount).toBe(1);
    vi.doUnmock('../../../../src/main/features/cogseed_backend/lifecycle');
  });

  it('does not block application startup when recovery throws', async () => {
    const { runBootTaskForTest } = await import('../../../../src/main/util/boot_init');

    // The boot harness contains a throwing task: it logs and moves on, which is
    // what keeps a broken task store from wedging the app on launch.
    await expect(runBootTaskForTest('cogseed:task-recovery', async () => {
      throw new Error('recovery exploded');
    })).resolves.toBeUndefined();
  });
});

describe('RC-P0-05 action semantics after reconciliation', () => {
  async function summaryFor(taskId: string) {
    const { createCogSeedIpcService } = await import('../../../../src/main/features/cogseed_backend/ipc-service');
    const { readCogSeedTask } = await import('../../../../src/main/features/cogseed_backend/task-store');
    const service = createCogSeedIpcService({
      readTask: async (_u: string, id: string) => readCogSeedTask(USER, id),
      listTasks: async () => [],
      listSessions: async () => [] as never,
      isConversationAvailable: async () => true,
    });
    return service.read(USER, { taskId });
  }

  it('never offers resume for an app_restart failed group-chat task', async () => {
    const { recovery } = await modules();
    const run = await groupChatRun('act1');
    await recovery.recoverCogSeedTasks(USER, noProjection);

    const summary = await summaryFor(run.taskId);

    expect(summary).toMatchObject({ status: 'failed', errorCode: 'app_restart' });
    // Group Chat has no run resume. Offering it would be a lie the runtime
    // cannot honour.
    expect(summary.actions.resume).toBe(false);
    // RC-P1-18 deleted `skip` outright — assert absence, not `false`.
    expect(summary.actions).not.toHaveProperty('skip');
    // Terminal, so abort is meaningless too.
    expect(summary.actions.abort).toBe(false);
  });

  // The honest half of RC-P0-05. `groupChatMessageId` is written in exactly one
  // place — `finishTask` — so a task killed by a restart never has one, and
  // `resolveFailedTurnRetry` needs a *failed assistant reply* which the run's
  // source (a user message) can never be. There is no safe fallback, so the
  // semantics are "explicitly not retryable".
  it('reports retry as unavailable when the interrupted run has no retryable turn', async () => {
    const { recovery } = await modules();
    const run = await groupChatRun('act2');
    await recovery.recoverCogSeedTasks(USER, noProjection);

    const summary = await summaryFor(run.taskId);

    expect(summary.actions.retry).toBe(false);
    // The reason is carried, not silently dropped, so the UI can explain it.
    expect(summary.errorCode).toBe('app_restart');
  });

  it('does offer retry once a retryable turn is actually recorded', async () => {
    const { tasks, recovery } = await modules();
    const run = await groupChatRun('act3');
    // `finishTask` stamps groupChatMessageId when a turn really terminates.
    await tasks.updateCogSeedTask(USER, run.taskId, (task) => ({
      ...task,
      groupChatMessageId: 'msg-failed-act3',
    }));
    await recovery.recoverCogSeedTasks(USER, noProjection);

    const summary = await summaryFor(run.taskId);

    expect(summary).toMatchObject({ status: 'failed', errorCode: 'app_restart' });
    // Retry's real precondition is satisfied here, so it must be offered.
    expect(summary.actions.retry).toBe(true);
    expect(summary.actions.resume).toBe(false);
  });

  it('keeps resume available for a recoverable non-group-chat task', async () => {
    const { tasks, lifecycle, recovery } = await modules();
    const native = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-native-act',
      task: 'Native act.',
      conversationId: 'cid-native-act',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'running');
    await recovery.recoverCogSeedTasks(USER, noProjection);

    const summary = await summaryFor(native.taskId);

    // Unchanged semantics for everything that is not Group Chat.
    expect(summary).toMatchObject({ status: 'recoverable' });
    expect(summary.actions.resume).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// B-1 — the process-start boundary.
//
// `cogseed:task-recovery` is deferred ~36s into boot (BOOT_BACKGROUND_DEFER_MS
// 6s + heavyDiskOffsetMs 30s) and `preferIdle` can hold it back a further
// maxUserDeferralMs (120s). By then the user may well have started a fresh
// conversation run. Without a boundary that live task is indistinguishable from
// an orphan, and failing it is unrecoverable: `failed → completed` is not a
// legal transition, so the run's own terminal projection can never put it right.
// -----------------------------------------------------------------------------
describe('B-1 process-start boundary', () => {
  it('reclaims a group-chat run left behind by a previous process', async () => {
    const { tasks, recovery } = await modules();
    const run = await groupChatRun('prev');

    const report = await recovery.recoverCogSeedTasks(USER, asPreviousProcess);

    await expect(tasks.readCogSeedTask(USER, run.taskId)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'app_restart',
    });
    expect(report.groupChatFailedCount).toBe(1);
  });

  // The test that locks the blocker.
  it('never touches a live run started by this process', async () => {
    const { tasks, recovery } = await modules();
    const live = await groupChatRun('live');

    const report = await recovery.recoverCogSeedTasks(USER, asThisProcess);

    expect(report.groupChatFailedCount).toBe(0);
    await expect(tasks.readCogSeedTask(USER, live.taskId)).resolves.toMatchObject({ status: 'running' });

    // ...and the run can still finish normally, which is what the bug destroyed.
    const { groupChatTaskBridge } = await import('../../../../src/main/features/cogseed_backend/group-chat-task-bridge');
    const finished = await groupChatTaskBridge.finishTask({
      userId: USER,
      taskId: live.taskId,
      status: 'completed',
      messageId: 'msg-live-done',
    });
    expect(finished).not.toBeNull();
    await expect(tasks.readCogSeedTask(USER, live.taskId)).resolves.toMatchObject({ status: 'completed' });
  });

  it.each(['created', 'queued'] as const)(
    'never touches a %s group-chat task belonging to this process',
    async (status) => {
      const { tasks, recovery } = await modules();
      const task = await groupChatRun(`live-${status}`, { status });

      const report = await recovery.recoverCogSeedTasks(USER, asThisProcess);

      expect(report.groupChatFailedCount).toBe(0);
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({ status });
    },
  );

  it.each(['created', 'queued'] as const)(
    'still reclaims a %s group-chat orphan from a previous process',
    async (status) => {
      const { tasks, recovery } = await modules();
      const task = await groupChatRun(`orphan-${status}`, { status });

      await recovery.recoverCogSeedTasks(USER, asPreviousProcess);

      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({
        status: 'failed',
        errorCode: 'app_restart',
      });
    },
  );

  it('never marks a live non-group-chat task recoverable', async () => {
    const { tasks, lifecycle, recovery } = await modules();
    const native = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-native-live',
      task: 'Native live.',
      conversationId: 'cid-native-live',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'running');

    const report = await recovery.recoverCogSeedTasks(USER, asThisProcess);

    expect(report.recoveredCount).toBe(0);
    await expect(tasks.readCogSeedTask(USER, native.taskId)).resolves.toMatchObject({ status: 'running' });
  });

  it('still marks a previous process non-group-chat task recoverable', async () => {
    const { tasks, lifecycle, recovery } = await modules();
    const native = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-native-prev',
      task: 'Native previous.',
      conversationId: 'cid-native-prev',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'running');

    const report = await recovery.recoverCogSeedTasks(USER, asPreviousProcess);

    expect(report.recoveredCount).toBe(1);
    await expect(tasks.readCogSeedTask(USER, native.taskId)).resolves.toMatchObject({
      status: 'recoverable',
      errorCode: 'worker_restart',
    });
  });

  it('defaults to the real process-start boundary when none is supplied', async () => {
    const { tasks, recovery } = await modules();
    const { PROCESS_STARTED_AT } = await import('../../../../src/main/storage');
    // Same clock and format as the task records — a UTC string here would sort
    // wrongly against local timestamps and quietly disable the guard.
    expect(PROCESS_STARTED_AT).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    const live = await groupChatRun('default');
    const report = await recovery.recoverCogSeedTasks(USER, { projectTaskEvent: async () => undefined } as never);

    // Created after this process started, so the default guard protects it.
    expect(report.groupChatFailedCount).toBe(0);
    await expect(tasks.readCogSeedTask(USER, live.taskId)).resolves.toMatchObject({ status: 'running' });
  });

  it('leaves a waiting_user task alone regardless of which process owns it', async () => {
    const { tasks, lifecycle, recovery } = await modules();
    const run = await groupChatRun('wait-prev');
    await lifecycle.transitionCogSeedTask(USER, run.taskId, 'waiting_user');

    const report = await recovery.recoverCogSeedTasks(USER, asPreviousProcess);

    // `waiting_user` records that a run already ended normally, pausing for
    // input — the restart did not interrupt it, so `app_restart` would be a
    // factual error. The authoritative "still waiting" state lives in Group
    // Chat's persisted orchestration ledger, not here.
    await expect(tasks.readCogSeedTask(USER, run.taskId)).resolves.toMatchObject({ status: 'waiting_user' });
    expect(report.groupChatFailedCount).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// B-2 — repeated sweeps must not re-report work they already did.
// -----------------------------------------------------------------------------
describe('B-2 repeated sweep accounting', () => {
  it('counts a non-group-chat task as recovered exactly once', async () => {
    const { tasks, lifecycle, recovery } = await modules();
    const native = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-native-repeat',
      task: 'Native repeat.',
      conversationId: 'cid-native-repeat',
      agentId: 'agent-repeat',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, native.taskId, 'running');

    const projected: string[] = [];
    const sweep = () => recovery.recoverCogSeedTasks(USER, {
      projectTaskEvent: async (input: { event: { eventId: string } }) => { projected.push(input.event.eventId); },
      processStartedAt: FUTURE_BOUNDARY,
    } as never);

    const first = await sweep();
    const second = await sweep();
    const third = await sweep();

    expect([first.recoveredCount, second.recoveredCount, third.recoveredCount]).toEqual([1, 0, 0]);
    // No repeated display projection either — this fired on every launch before.
    expect(projected).toHaveLength(1);
    expect([first.taskIds.length, second.taskIds.length, third.taskIds.length]).toEqual([1, 0, 0]);
    // State itself is untouched and still resumable.
    await expect(tasks.readCogSeedTask(USER, native.taskId)).resolves.toMatchObject({
      status: 'recoverable',
      errorCode: 'worker_restart',
    });
  });

  it('counts a group-chat task as failed exactly once', async () => {
    const { recovery } = await modules();
    await groupChatRun('repeat-gc');

    const first = await recovery.recoverCogSeedTasks(USER, asPreviousProcess);
    const second = await recovery.recoverCogSeedTasks(USER, asPreviousProcess);

    expect([first.groupChatFailedCount, second.groupChatFailedCount]).toEqual([1, 0]);
  });
});
