// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// RC-P2-10 — Group Chat never offers resume, in any status.
//
// This is an invariant, not a defect: Group Chat has no run-resume capability
// at all. `group_chat/index.ts` heals an orphaned run by setting the
// conversation to `idle` — it abandons the run. `retryCogSeedTask` throws
// outright for group-chat, and `resumeCogSeedTask` refuses it too. So a
// `resume` affordance anywhere in the Run Center would be a promise nothing
// can keep.
//
// The invariant is asserted here, against the real `taskActions()`, because
// that projection is the single source of action truth — the renderer simply
// draws what it is given. Duplicating the rule as a renderer-side group-chat
// special case would put it in two places and let them drift.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CogSeedTaskRecord, CogSeedTaskStatus } from '../../../../src/main/features/cogseed_backend/types';

const USER = 'cogseed-resume-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-resume-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Every status in the task state machine — nothing may be skipped. */
const ALL_STATUSES: CogSeedTaskStatus[] = [
  'created', 'queued', 'running', 'waiting_user',
  'completed', 'failed', 'cancelled', 'recoverable',
];

function record(status: CogSeedTaskStatus, overrides: Partial<CogSeedTaskRecord> = {}): CogSeedTaskRecord {
  const at = '2026-08-26T00:00:00';
  return {
    schemaVersion: 1,
    taskId: 'cogseed-task-resume1',
    sessionId: 'cogseed-session-1',
    requestId: 'req-groupchat-run-1',
    userId: USER,
    status,
    createdAt: at,
    updatedAt: at,
    executionKind: 'group-chat',
    conversationId: 'conv-1',
    groupChatRunId: 'run-1',
    ...overrides,
  } as CogSeedTaskRecord;
}

async function summaryFor(task: CogSeedTaskRecord) {
  const { createCogSeedIpcService } = await import('../../../../src/main/features/cogseed_backend/ipc-service');
  const service = createCogSeedIpcService({
    readTask: async () => task,
    listTasks: async () => [task],
    listSessions: async () => [] as never,
    isConversationAvailable: async () => true,
  });
  return service.read(USER, { taskId: task.taskId });
}

describe('RC-P2-10 group-chat resume invariant', () => {
  it.each(ALL_STATUSES)('never offers resume for a group-chat task in %s', async (status) => {
    const summary = await summaryFor(record(status));
    expect(summary.actions.resume).toBe(false);
  });

  it.each(ALL_STATUSES)('never offers skip for a group-chat task in %s', async (status) => {
    // `skip` belonged to workflow-step semantics group-chat never used, and
    // `action()` threw for it unconditionally. RC-P1-18 removed the field
    // rather than keep advertising a capability nothing could honour, so the
    // invariant is now "absent", not "present and false".
    const summary = await summaryFor(record(status));
    expect(summary.actions).not.toHaveProperty('skip');
  });

  it('offers no resume even for the restart-reconciled failed state', async () => {
    const summary = await summaryFor(record('failed', { errorCode: 'app_restart' }));
    expect(summary.actions).toMatchObject({ resume: false });
    expect(summary.actions).not.toHaveProperty('skip');
    // And no retry either, because the interrupted run has no retryable turn.
    expect(summary.actions.retry).toBe(false);
  });

  it('offers no resume even when a retryable turn exists', async () => {
    const summary = await summaryFor(record('failed', { groupChatMessageId: 'msg-failed-1' }));
    // Retry becomes available; resume must still not.
    expect(summary.actions.retry).toBe(true);
    expect(summary.actions.resume).toBe(false);
  });

  it('still offers resume for a recoverable non-group-chat task', async () => {
    // The invariant is specific to group-chat; the native contract must not be
    // collateral damage.
    const native = record('recoverable', { executionKind: 'cogseed-native' });
    const summary = await summaryFor(native);
    expect(summary.actions.resume).toBe(true);
  });

  it('refuses a resume attempt at the runtime boundary too', async () => {
    // Defence where it belongs: even if some caller ignored `actions`, the
    // controller rejects group-chat outright.
    const { cogseedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const created = (await tasks.createCogSeedTask(USER, {
      requestId: 'req-groupchat-run-resume',
      task: 'Conversation task',
      sessionId: 'gconv-conv-1',
      conversationId: 'conv-1',
      executionKind: 'group-chat',
      groupChatRunId: 'run-resume',
      groupChatSourceMessageId: 'msg-resume',
    })).task;

    await expect(cogseedRuntimeController.resumeCogSeedTask(USER, created.taskId, {
      requestId: 'req-resume-attempt',
      continuation: 'keep going',
    })).rejects.toThrow(/Group Chat/i);
  });
});
