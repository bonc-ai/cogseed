import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-failure-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('KSTAR failure records', () => {
  it('persists an idempotent, user-scoped failure record', async () => {
    const service = await import('../../../../src/main/features/kstar/failure-service');
    const first = await service.recordKstarFailure('user-a', {
      stage: 'precipitation', errorCode: 'asset_write_failed', errorMessage: 'write failed',
      episodeId: 'kse-a', requirementId: 'ksreq-a', operationKey: 'finish-a',
    });
    const second = await service.recordKstarFailure('user-a', {
      stage: 'precipitation', errorCode: 'asset_write_failed', errorMessage: 'write failed',
      episodeId: 'kse-a', requirementId: 'ksreq-a', operationKey: 'finish-a',
    });
    expect(second.id).toBe(first.id);
    expect(await service.listKstarFailures('user-a')).toHaveLength(1);
    expect(await service.listKstarFailures('user-b')).toHaveLength(0);
  });

  it('filters failures by the owning conversation through task and requirement links', async () => {
    const service = await import('../../../../src/main/features/kstar/failure-service');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const taskA = store.createKstarTaskRecord('user-a', { conversationId: 'conversation-a', title: 'A' });
    const taskB = store.createKstarTaskRecord('user-a', { conversationId: 'conversation-b', title: 'B' });
    const requirementA = store.createKstarRequirementRecord('user-a', {
      taskId: taskA.id, conversationId: taskA.conversationId, userMessageIds: ['message-a'], title: 'A', goalText: 'A',
    });
    const requirementB = store.createKstarRequirementRecord('user-a', {
      taskId: taskB.id, conversationId: taskB.conversationId, userMessageIds: ['message-b'], title: 'B', goalText: 'B',
    });
    await store.replaceKstarTask('user-a', taskA);
    await store.replaceKstarTask('user-a', taskB);
    await store.replaceKstarRequirement('user-a', requirementA);
    await store.replaceKstarRequirement('user-a', requirementB);
    await service.recordKstarFailure('user-a', {
      stage: 'precipitation', errorCode: 'a', errorMessage: 'a', operationKey: 'op-a', taskId: taskA.id, requirementId: requirementA.id,
    });
    await service.recordKstarFailure('user-a', {
      stage: 'precipitation', errorCode: 'b', errorMessage: 'b', operationKey: 'op-b', taskId: taskB.id, requirementId: requirementB.id,
    });
    expect((await service.listKstarFailures('user-a', { conversationId: 'conversation-a' })).map((item) => item.errorCode)).toEqual(['a']);
    expect(await service.listKstarFailures('user-a', { conversationId: 'conversation-missing' })).toEqual([]);
  });

  it('uses the persisted conversation link for failures without a task record', async () => {
    const service = await import('../../../../src/main/features/kstar/failure-service');
    await service.recordKstarFailure('user-a', {
      stage: 'capture', errorCode: 'capture-a', errorMessage: 'a', operationKey: 'capture-a', conversationId: 'conversation-a',
    });
    await service.recordKstarFailure('user-a', {
      stage: 'capture', errorCode: 'capture-b', errorMessage: 'b', operationKey: 'capture-b', conversationId: 'conversation-b',
    });
    expect((await service.listKstarFailures('user-a', { conversationId: 'conversation-a' })).map((item) => item.errorCode)).toEqual(expect.arrayContaining(['a', 'capture-a']));
    expect(await service.listKstarFailures('user-a', { conversationId: 'conversation-a' })).toHaveLength(2);
  });
});
