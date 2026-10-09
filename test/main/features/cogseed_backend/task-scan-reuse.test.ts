// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * `listCogSeedTasks` reads every task file in the directory, so the number of
 * times one Run Center refresh calls it is a direct multiplier on disk cost —
 * and the dashboard watch stream replays that refresh on every task change.
 * A session read used to scan twice: once for itself, then again inside the
 * collaboration snapshot it delegates to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';

const USER = 'cogseed-scan-reuse-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-scan-reuse-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedTasks(count: number) {
  const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
  const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
  const seeded: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const created = await tasks.createCogSeedTask(USER, {
      requestId: `req-scan-reuse-${index}`,
      task: `task ${index}`,
      executionKind: 'cogseed-native',
      agentId: 'agent-reviewer',
    });
    await lifecycle.transitionCogSeedTask(USER, created.task.taskId, 'queued');
    await lifecycle.transitionCogSeedTask(USER, created.task.taskId, 'running');
    seeded.push(created.task.taskId);
  }
  return { tasks, seeded };
}

async function countingService(listTasks: typeof import('../../../../src/main/features/cogseed_backend/task-store').listCogSeedTasks) {
  const ipc = await import('../../../../src/main/features/cogseed_backend/ipc-service');
  const scans: number[] = [];
  const service = ipc.createCogSeedIpcService({
    listTasks: async (userId: string) => {
      const result = await listTasks(userId);
      scans.push(result.length);
      return result;
    },
    isConversationAvailable: async () => true,
    countConversationAgents: async () => 1,
  });
  return { service, scans };
}

describe('task-directory scans per Run Center read', () => {
  it('reads the task directory once per session projection', async () => {
    const { tasks, seeded } = await seedTasks(4);
    const { service, scans } = await countingService(tasks.listCogSeedTasks);
    const sessionId = (await tasks.readCogSeedTask(USER, seeded[0]))!.sessionId;

    scans.length = 0;
    const projection = await service.sessionProjection(USER, { sessionId });

    expect(projection.session).not.toBeNull();
    expect(projection.collaboration).not.toBeNull();
    expect(scans).toHaveLength(1);
  });

  it('reads it once when the session projection is scoped to a task', async () => {
    const { tasks, seeded } = await seedTasks(4);
    const { service, scans } = await countingService(tasks.listCogSeedTasks);

    scans.length = 0;
    const projection = await service.sessionProjection(USER, { taskId: seeded[1] });

    expect(projection.collaboration).not.toBeNull();
    expect(scans).toHaveLength(1);
  });

  it('reads it once per board projection', async () => {
    const { tasks } = await seedTasks(4);
    const { service, scans } = await countingService(tasks.listCogSeedTasks);

    scans.length = 0;
    await service.boardProjection(USER);

    expect(scans).toHaveLength(1);
  });

  it('still scans for itself when a caller supplies nothing', async () => {
    const { tasks, seeded } = await seedTasks(3);
    const { service, scans } = await countingService(tasks.listCogSeedTasks);

    scans.length = 0;
    await service.collaborationSnapshot(USER, { taskId: seeded[0] });

    expect(scans).toHaveLength(1);
  });

  it('produces the same snapshot whether the task set is handed down or re-read', async () => {
    const { tasks, seeded } = await seedTasks(3);
    const ipc = await import('../../../../src/main/features/cogseed_backend/ipc-service');
    const service = ipc.createCogSeedIpcService({
      isConversationAvailable: async () => true,
      countConversationAgents: async () => 1,
    });
    const sessionId = (await tasks.readCogSeedTask(USER, seeded[0]))!.sessionId;

    const viaSession = (await service.sessionProjection(USER, { sessionId })).collaboration;
    const standalone = await service.collaborationSnapshot(USER, { sessionId });

    expect(viaSession).toEqual(standalone);
  });

  it('honours the caller-supplied set rather than silently re-reading', async () => {
    const { tasks, seeded } = await seedTasks(3);
    const ipc = await import('../../../../src/main/features/cogseed_backend/ipc-service');
    const service = ipc.createCogSeedIpcService({
      listTasks: async () => { throw new Error('collaborationSnapshot must not scan when handed a task set'); },
      isConversationAvailable: async () => true,
      countConversationAgents: async () => 1,
    });
    const preloaded = await Promise.all(seeded.map((id) => tasks.readCogSeedTask(USER, id))) as CogSeedTaskRecord[];

    const snapshot = await service.collaborationSnapshot(USER, { taskId: seeded[0] }, preloaded);

    expect(snapshot.task?.taskId).toBe(seeded[0]);
  });
});
