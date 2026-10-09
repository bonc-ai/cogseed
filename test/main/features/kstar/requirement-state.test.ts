import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-phase2-state-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
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

  it('attaches an episode to an explicitly addressed open requirement and records the episode id', async () => {
    const { state, store } = await modules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-attach-ok', title: 'Attachment task' });
    const requirement = store.createKstarRequirementRecord('user-a', {
      taskId: task.id,
      conversationId: 'cid-attach-ok',
      userMessageIds: ['msg-attach-ok'],
      title: 'Attachment requirement',
      goalText: 'Record one episode',
    });
    await store.replaceKstarTask('user-a', {
      ...task,
      requirementIds: [requirement.id],
      currentRequirementId: requirement.id,
    });
    await store.replaceKstarRequirement('user-a', { ...requirement, projectionId: 'proj-attach-ok' });

    await state.attachKstarEpisodeToRequirement('user-a', {
      conversationId: 'cid-attach-ok',
      episodeId: 'ep-attach-ok',
      taskId: task.id,
      requirementId: requirement.id,
    });

    const updated = await store.readKstarRequirement('user-a', requirement.id);
    expect(updated?.episodeIds).toEqual(['ep-attach-ok']);
  });

  it('rejects an episode whose explicit task belongs to a different conversation', async () => {
    const { state, store } = await modules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-task-owner', title: 'Owner task' });
    await store.replaceKstarTask('user-a', task);

    await expect(state.attachKstarEpisodeToRequirement('user-a', {
      conversationId: 'cid-other-conversation',
      episodeId: 'ep-conversation-mismatch',
      taskId: task.id,
    })).rejects.toThrow(/kstar episode task conversation mismatch/i);
  });

  it('rejects an explicit requirement that does not belong to the addressed task', async () => {
    const { state, store } = await modules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-req-owner', title: 'Requirement owner task' });
    const own = store.createKstarRequirementRecord('user-a', {
      taskId: task.id,
      conversationId: 'cid-req-owner',
      userMessageIds: ['msg-req-owner'],
      title: 'Owned requirement',
      goalText: 'Belongs to the task',
    });
    const otherTask = store.createKstarTaskRecord('user-a', { conversationId: 'cid-req-owner', title: 'Other task' });
    const foreign = store.createKstarRequirementRecord('user-a', {
      taskId: otherTask.id,
      conversationId: 'cid-req-owner',
      userMessageIds: ['msg-req-foreign'],
      title: 'Foreign requirement',
      goalText: 'Belongs to another task',
    });
    await store.replaceKstarTask('user-a', {
      ...task,
      requirementIds: [own.id],
      currentRequirementId: own.id,
    });
    await store.replaceKstarRequirement('user-a', { ...own, projectionId: 'proj-req-owner' });
    await store.replaceKstarRequirement('user-a', { ...foreign, projectionId: 'proj-req-foreign' });

    await expect(state.attachKstarEpisodeToRequirement('user-a', {
      conversationId: 'cid-req-owner',
      episodeId: 'ep-req-foreign',
      taskId: task.id,
      requirementId: foreign.id,
    })).rejects.toThrow(/kstar episode requirement does not belong to task/i);
  });

  it('rejects an episode attachment when several open requirements match the projection', async () => {
    const { state, store } = await modules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-ambiguous-episode', title: 'Ambiguous episode task' });
    const matched: string[] = [];
    for (const messageId of ['msg-ambiguous-episode-a', 'msg-ambiguous-episode-b']) {
      const requirement = store.createKstarRequirementRecord('user-a', {
        taskId: task.id,
        conversationId: 'cid-ambiguous-episode',
        userMessageIds: [messageId],
        title: 'Ambiguous requirement',
        goalText: 'Two open requirements share the projection',
      });
      await store.replaceKstarRequirement('user-a', { ...requirement, projectionId: 'proj-ambiguous-episode' });
      matched.push(requirement.id);
    }
    await store.replaceKstarTask('user-a', {
      ...task,
      requirementIds: matched,
      currentRequirementId: matched[0],
    });

    await expect(state.attachKstarEpisodeToRequirement('user-a', {
      conversationId: 'cid-ambiguous-episode',
      episodeId: 'ep-ambiguous-episode',
      taskId: task.id,
      projectionId: 'proj-ambiguous-episode',
    })).rejects.toThrow(/multiple kstar requirements match episode provenance/i);
  });

  it('rejects an episode whose projection matches neither an open requirement nor the current fallback', async () => {
    const { state, store } = await modules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-no-provenance', title: 'No provenance task' });
    const current = store.createKstarRequirementRecord('user-a', {
      taskId: task.id,
      conversationId: 'cid-no-provenance',
      userMessageIds: ['msg-no-provenance'],
      title: 'Current requirement',
      goalText: 'Fallback target with a different projection',
    });
    await store.replaceKstarTask('user-a', {
      ...task,
      requirementIds: [current.id],
      currentRequirementId: current.id,
    });
    await store.replaceKstarRequirement('user-a', { ...current, projectionId: 'proj-current' });
    await store.writeConversationTaskState('user-a', {
      ...store.createInitialConversationTaskState('user-a', 'cid-no-provenance'),
      currentTaskId: task.id,
      currentRequirementId: current.id,
      taskComplete: false,
    });

    await expect(state.attachKstarEpisodeToRequirement('user-a', {
      conversationId: 'cid-no-provenance',
      episodeId: 'ep-no-provenance',
      taskId: task.id,
      projectionId: 'proj-other',
    })).rejects.toThrow(/no kstar requirement matches episode provenance/i);
  });

  it('does not attach an episode to a closed requirement', async () => {
    const { state, store } = await modules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-closed-episode', title: 'Closed task' });
    const closed = store.createKstarRequirementRecord('user-a', {
      taskId: task.id,
      conversationId: 'cid-closed-episode',
      userMessageIds: ['msg-closed-episode'],
      title: 'Closed requirement',
      goalText: 'Must refuse new episodes',
    });
    await store.replaceKstarTask('user-a', {
      ...task,
      requirementIds: [closed.id],
      currentRequirementId: closed.id,
    });
    await store.replaceKstarRequirement('user-a', {
      ...closed,
      projectionId: 'proj-closed-episode',
      status: 'closed',
      closedAt: '2026-09-01T00:00:00.000Z',
    });

    await expect(state.attachKstarEpisodeToRequirement('user-a', {
      conversationId: 'cid-closed-episode',
      episodeId: 'ep-closed-episode',
      taskId: task.id,
      requirementId: closed.id,
    })).resolves.toBeUndefined();

    const updated = await store.readKstarRequirement('user-a', closed.id);
    expect(updated?.status).toBe('closed');
    expect(updated?.episodeIds).toEqual([]);
  });

  it('rejects the current-requirement fallback when the current requirement belongs to a different task than the resolved episode task', async () => {
    const { state, store } = await modules();
    // Task A is the episode's resolved task (input.taskId), but the
    // conversation has since moved to task B: the current requirement must
    // not become the attachment target without a membership check.
    const taskA = store.createKstarTaskRecord('user-a', { conversationId: 'cid-fallback-member', title: 'Resolved episode task' });
    const own = store.createKstarRequirementRecord('user-a', {
      taskId: taskA.id,
      conversationId: 'cid-fallback-member',
      userMessageIds: ['msg-fallback-own'],
      title: 'Owned requirement',
      goalText: 'Open but unmatched',
    });
    const taskB = store.createKstarTaskRecord('user-a', { conversationId: 'cid-fallback-member', title: 'Current task' });
    const foreign = store.createKstarRequirementRecord('user-a', {
      taskId: taskB.id,
      conversationId: 'cid-fallback-member',
      userMessageIds: ['msg-fallback-current'],
      title: 'Current requirement',
      goalText: 'Belongs to the current (different) task',
    });
    await store.replaceKstarTask('user-a', { ...taskA, requirementIds: [own.id], currentRequirementId: own.id });
    await store.replaceKstarRequirement('user-a', own);
    await store.replaceKstarTask('user-a', { ...taskB, requirementIds: [foreign.id], currentRequirementId: foreign.id });
    await store.replaceKstarRequirement('user-a', foreign);
    await store.writeConversationTaskState('user-a', {
      ...store.createInitialConversationTaskState('user-a', 'cid-fallback-member'),
      currentTaskId: taskB.id,
      currentRequirementId: foreign.id,
      taskComplete: false,
    });

    await expect(state.attachKstarEpisodeToRequirement('user-a', {
      conversationId: 'cid-fallback-member',
      episodeId: 'ep-fallback-member',
      taskId: taskA.id,
    })).rejects.toThrow(/kstar current requirement does not belong to episode task/i);

    expect((await store.readKstarRequirement('user-a', foreign.id))?.episodeIds).toEqual([]);
    expect((await store.readKstarRequirement('user-a', own.id))?.episodeIds).toEqual([]);
  });

  it('attaches through the current-requirement fallback when the current requirement belongs to the resolved task', async () => {
    const { state, store } = await modules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-fallback-ok', title: 'Resolved task' });
    const current = store.createKstarRequirementRecord('user-a', {
      taskId: task.id,
      conversationId: 'cid-fallback-ok',
      userMessageIds: ['msg-fallback-ok'],
      title: 'Current requirement',
      goalText: 'Belongs to the resolved task',
    });
    await store.replaceKstarTask('user-a', { ...task, requirementIds: [current.id], currentRequirementId: current.id });
    await store.replaceKstarRequirement('user-a', current);
    await store.writeConversationTaskState('user-a', {
      ...store.createInitialConversationTaskState('user-a', 'cid-fallback-ok'),
      currentTaskId: task.id,
      currentRequirementId: current.id,
      taskComplete: false,
    });

    await state.attachKstarEpisodeToRequirement('user-a', {
      conversationId: 'cid-fallback-ok',
      episodeId: 'ep-fallback-ok',
      taskId: task.id,
    });

    expect((await store.readKstarRequirement('user-a', current.id))?.episodeIds).toEqual(['ep-fallback-ok']);
  });

  it('does not use the current-requirement fallback when attachment opts out, even for a same-task open current requirement', async () => {
    const { state, store } = await modules();
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-fallback-optout', title: 'Resolved task' });
    const current = store.createKstarRequirementRecord('user-a', {
      taskId: task.id,
      conversationId: 'cid-fallback-optout',
      userMessageIds: ['msg-fallback-optout'],
      title: 'Current requirement',
      goalText: 'Belongs to the resolved task but must not become a snapshot fallback target',
    });
    await store.replaceKstarTask('user-a', { ...task, requirementIds: [current.id], currentRequirementId: current.id });
    await store.replaceKstarRequirement('user-a', current);
    await store.writeConversationTaskState('user-a', {
      ...store.createInitialConversationTaskState('user-a', 'cid-fallback-optout'),
      currentTaskId: task.id,
      currentRequirementId: current.id,
      taskComplete: false,
    });

    await state.attachKstarEpisodeToRequirement('user-a', {
      conversationId: 'cid-fallback-optout',
      episodeId: 'ep-fallback-optout',
      taskId: task.id,
    }, { allowCurrentRequirementFallback: false });

    expect((await store.readKstarRequirement('user-a', current.id))?.episodeIds).toEqual([]);
  });

  it('ignores a closed current requirement instead of throwing the membership error (fallback only targets an open current requirement)', async () => {
    const { state, store } = await modules();
    // Task A is the episode's resolved task (input.taskId); the conversation
    // has since moved to task B whose CURRENT requirement is already closed.
    // A closed/abandoned current requirement is never a fallback target, so
    // the membership error must not fire (pre-Fix-4 silent no-attach).
    const taskA = store.createKstarTaskRecord('user-a', { conversationId: 'cid-closed-current', title: 'Resolved episode task' });
    const own = store.createKstarRequirementRecord('user-a', {
      taskId: taskA.id,
      conversationId: 'cid-closed-current',
      userMessageIds: ['msg-closed-current-own'],
      title: 'Owned requirement',
      goalText: 'Open but unmatched',
    });
    const taskB = store.createKstarTaskRecord('user-a', { conversationId: 'cid-closed-current', title: 'Closed current task' });
    const foreign = store.createKstarRequirementRecord('user-a', {
      taskId: taskB.id,
      conversationId: 'cid-closed-current',
      userMessageIds: ['msg-closed-current-foreign'],
      title: 'Closed current requirement',
      goalText: 'Belongs to the current (different) task and is closed',
    });
    await store.replaceKstarTask('user-a', { ...taskA, requirementIds: [own.id], currentRequirementId: own.id });
    await store.replaceKstarRequirement('user-a', own);
    await store.replaceKstarTask('user-a', { ...taskB, requirementIds: [foreign.id], currentRequirementId: foreign.id });
    await store.replaceKstarRequirement('user-a', {
      ...foreign,
      status: 'closed',
      closedAt: '2026-09-01T00:00:00.000Z',
    });
    await store.writeConversationTaskState('user-a', {
      ...store.createInitialConversationTaskState('user-a', 'cid-closed-current'),
      currentTaskId: taskB.id,
      currentRequirementId: foreign.id,
      taskComplete: false,
    });

    await expect(state.attachKstarEpisodeToRequirement('user-a', {
      conversationId: 'cid-closed-current',
      episodeId: 'ep-closed-current',
      taskId: taskA.id,
    })).resolves.toBeUndefined();

    expect((await store.readKstarRequirement('user-a', foreign.id))?.episodeIds).toEqual([]);
    expect((await store.readKstarRequirement('user-a', own.id))?.episodeIds).toEqual([]);
  });
});
