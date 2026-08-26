// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// Invariants for the three transition edges Phase 2 added to `TRANSITIONS`:
//
//   created     → failed
//   queued      → failed
//   recoverable → failed
//
// They exist because a task can die before it ever runs (the process hosting it
// disappears), and because a task once judged `recoverable` may later be
// confirmed unrecoverable — Group Chat offers no run resume, so a `recoverable`
// group-chat task is a promise nothing can keep.
//
// These edges are globally legal, not recovery-private, so this file pins both
// what they now permit and what must still be refused. A widened state machine
// that quietly also allowed terminal states to reanimate would be a far worse
// bug than the zombie it was added to fix.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'cogseed-transition-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-transition-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function mods() {
  return {
    tasks: await import('../../../../src/main/features/cogseed_backend/task-store'),
    lifecycle: await import('../../../../src/main/features/cogseed_backend/lifecycle'),
    events: await import('../../../../src/main/features/cogseed_backend/event-store'),
  };
}

/** A task parked at `status`, built only through legal transitions. */
async function taskAt(status: 'created' | 'queued' | 'running' | 'recoverable' | 'failed' | 'completed' | 'cancelled', suffix: string) {
  const { tasks, lifecycle } = await mods();
  const task = (await tasks.createCogSeedTask(USER, {
    requestId: `req-transition-${suffix}`,
    task: 'Transition fixture.',
    conversationId: `cid-${suffix}`,
  })).task;
  const go = (next: Parameters<typeof lifecycle.transitionCogSeedTask>[2]) =>
    lifecycle.transitionCogSeedTask(USER, task.taskId, next);
  if (status === 'created') return task;
  if (status === 'recoverable') { await go('recoverable'); return task; }
  await go('queued');
  if (status === 'queued') return task;
  if (status === 'failed') { await go('failed'); return task; }
  if (status === 'cancelled') { await go('cancelled'); return task; }
  await go('running');
  if (status === 'running') return task;
  await go(status);
  return task;
}

describe('Phase 2 transition edges', () => {
  it.each(['created', 'queued', 'recoverable'] as const)(
    'allows %s → failed and records the error code',
    async (from) => {
      const { tasks, lifecycle, events } = await mods();
      const task = await taskAt(from, `ok-${from}`);

      const updated = await lifecycle.transitionCogSeedTask(USER, task.taskId, 'failed', {
        errorCode: 'app_restart',
      });

      expect(updated).toMatchObject({ status: 'failed', errorCode: 'app_restart' });
      await expect(tasks.readCogSeedTask(USER, task.taskId)).resolves.toMatchObject({ status: 'failed' });
      // A single lifecycle event, matching the destination status.
      const failedEvents = (await events.readCogSeedTaskEvents(USER, task.taskId, 0, 50))
        .filter((event) => event.type === 'task.failed');
      expect(failedEvents).toHaveLength(1);
    },
  );

  it('still refuses to reanimate a completed task', async () => {
    const { lifecycle } = await mods();
    const task = await taskAt('completed', 'done');
    for (const next of ['failed', 'queued', 'running', 'recoverable'] as const) {
      await expect(lifecycle.transitionCogSeedTask(USER, task.taskId, next))
        .rejects.toThrow(/terminal|transition/i);
    }
  });

  it('still refuses to reanimate a cancelled task', async () => {
    const { lifecycle } = await mods();
    const task = await taskAt('cancelled', 'cancel');
    for (const next of ['failed', 'queued', 'running', 'recoverable'] as const) {
      await expect(lifecycle.transitionCogSeedTask(USER, task.taskId, next))
        .rejects.toThrow(/terminal|transition/i);
    }
  });

  it('keeps failed → completed illegal, which is why a mislabelled run cannot self-heal', async () => {
    const { lifecycle } = await mods();
    const task = await taskAt('failed', 'stuck');
    // This asymmetry is exactly what made the B-1 race unrecoverable: once a
    // live run's task was wrongly failed, its own terminal projection could
    // never put it right. The edge stays illegal; the boundary guard is what
    // prevents the situation arising.
    await expect(lifecycle.transitionCogSeedTask(USER, task.taskId, 'completed'))
      .rejects.toThrow(/transition/i);
    // `failed → queued` remains legal — that is the retry path.
    await expect(lifecycle.transitionCogSeedTask(USER, task.taskId, 'queued')).resolves.toMatchObject({
      status: 'queued',
    });
  });

  it('does not open waiting_user → failed', async () => {
    const { lifecycle } = await mods();
    const task = await taskAt('running', 'wait');
    await lifecycle.transitionCogSeedTask(USER, task.taskId, 'waiting_user');
    // `waiting_user` records a run that already ended normally, pausing for
    // input. It is deliberately outside the restart sweep, and the state
    // machine keeps it that way.
    await expect(lifecycle.transitionCogSeedTask(USER, task.taskId, 'failed'))
      .rejects.toThrow(/transition/i);
  });

  it('leaves the non-group-chat resume path intact', async () => {
    const { lifecycle } = await mods();
    const task = await taskAt('recoverable', 'resume');
    // Adding `recoverable → failed` must not have displaced `recoverable →
    // queued`, which is how a native task actually resumes.
    await expect(lifecycle.transitionCogSeedTask(USER, task.taskId, 'queued')).resolves.toMatchObject({
      status: 'queued',
    });
  });

  it('keeps group-chat tasks out of the CogSeed retry path', async () => {
    const { tasks, lifecycle } = await mods();
    const task = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-transition-gc',
      task: 'Group chat fixture.',
      sessionId: 'gconv-cid-gc',
      conversationId: 'cid-gc',
      executionKind: 'group-chat',
      groupChatRunId: 'run-gc',
      groupChatSourceMessageId: 'msg-gc',
    })).task;
    await lifecycle.transitionCogSeedTask(USER, task.taskId, 'failed', { errorCode: 'app_restart' });

    // The new edge makes the *state* reachable; it must not make the task
    // retryable through CogSeed Runtime, which cannot execute Group Chat.
    await expect(lifecycle.retryCogSeedTask(USER, task.taskId, 'req-retry-gc'))
      .rejects.toThrow(/Group Chat/i);
  });
});
