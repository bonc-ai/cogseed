import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-phase2-state-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [state, store] = await Promise.all([
    import('../../../../src/main/features/kstar/requirement-state'),
    import('../../../../src/main/features/kstar/requirement-store'),
  ]);
  return { state, store };
}

describe('KSTAR requirement state transitions', () => {
  it('binds exactly one wake request by conversation and projection', async () => {
    const { state, store } = await modules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-bind', title: 'Binding task' });
    const first = store.createKstarRequirementRecord('user-a', {
      taskId: task.id,
      conversationId: 'cid-bind',
      userMessageIds: ['msg-bind-a'],
      title: 'Binding requirement',
      goalText: 'Bind one wake request',
    });
    await store.replaceKstarRequirement('user-a', { ...first, projectionId: 'proj-bind' });

    const bound = await state.bindKstarRequirementWakeRequest('user-a', {
      conversationId: 'cid-bind',
      projectionId: 'proj-bind',
      wakeRequestId: 'wake-bind',
    });
    expect(bound).toMatchObject({ id: first.id, conversationId: 'cid-bind', projectionId: 'proj-bind', wakeRequestId: 'wake-bind' });

    const otherConversation = store.createKstarTaskRecord('user-a', { conversationId: 'cid-other', title: 'Other task' });
    const other = store.createKstarRequirementRecord('user-a', {
      taskId: otherConversation.id,
      conversationId: 'cid-other',
      userMessageIds: ['msg-bind-b'],
      title: 'Other requirement',
      goalText: 'Must not match another conversation',
    });
    await store.replaceKstarRequirement('user-a', { ...other, projectionId: 'proj-bind' });
    await expect(state.bindKstarRequirementWakeRequest('user-a', {
      conversationId: 'cid-missing', projectionId: 'proj-bind', wakeRequestId: 'wake-other',
    })).rejects.toThrow(/no kstar requirement matches/i);
  });

  it('rejects ambiguous projection bindings instead of updating every match', async () => {
    const { state, store } = await modules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-ambiguous-bind', title: 'Ambiguous task' });
    for (const messageId of ['msg-ambiguous-a', 'msg-ambiguous-b']) {
      const requirement = store.createKstarRequirementRecord('user-a', {
        taskId: task.id,
        conversationId: 'cid-ambiguous-bind',
        userMessageIds: [messageId],
        title: 'Ambiguous requirement',
        goalText: 'Reject duplicate projection ownership',
      });
      await store.replaceKstarRequirement('user-a', { ...requirement, projectionId: 'proj-ambiguous' });
    }

    await expect(state.bindKstarRequirementWakeRequest('user-a', {
      conversationId: 'cid-ambiguous-bind',
      projectionId: 'proj-ambiguous',
      wakeRequestId: 'wake-ambiguous',
    })).rejects.toThrow(/multiple kstar requirements match/i);
  });
});
