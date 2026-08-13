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

const modelRoute = (intent: 'new' | 'continue' | 'complete' | 'topic_switch') => ({
  routerOptions: {
    classify: async (input: { text: string; hasOpenTask: boolean; hasOpenRequirement: boolean }) => ({
      intent,
      confidence: 0.95,
      reason: `fake route for ${input.text}`,
      requirementText: input.text,
    }),
  },
});

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
  it('creates a task and requirement for the first user message', async () => {
    const { state } = await modules();
    const result = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-a', messageId: 'msg-a', text: '审查 OAuth 登录实现',
    }, modelRoute('new'));

    expect(result.task.status).toBe('open');
    expect(result.task.requirementIds).toEqual([result.currentRequirement.id]);
    expect(result.currentRequirement.status).toBe('open');
    expect(result.state).toMatchObject({ currentTaskId: result.task.id, currentRequirementId: result.currentRequirement.id, taskComplete: false });
  });


  it('creates a projection for a natural-language requirement title', async () => {
    const { state } = await modules();
    const result = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-natural-projection',
      messageId: 'msg-natural-projection',
      text: '请把这个任务作为一次完整的 KSTAR / Recall / 多智能体融合测试来执行，并调度一个 Agent 检查遗漏。',
    }, modelRoute('new'));

    expect(result.currentRequirement.projectionId).toMatch(/^proj-/);
    expect(result.currentRequirement.forecastId).toBeUndefined();
  });


  it('keeps projection preview available when the routed requirement text is longer than the projection purpose limit', async () => {
    const { state } = await modules();
    const longTask = '请把这个任务作为一次完整的 KSTAR / Recall / 多智能体融合测试来执行。'.repeat(12);
    const result = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-long-projection',
      messageId: 'msg-long-projection',
      text: longTask,
    }, modelRoute('new'));

    expect(result.currentRequirement.projectionId).toMatch(/^proj-/);
  });

  it('continues the open requirement without creating another one', async () => {
    const { state, store } = await modules();
    const first = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-a', messageId: 'msg-a', text: '审查 OAuth 登录实现',
    }, modelRoute('new'));
    const second = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-a', messageId: 'msg-b', text: '继续检查 refresh token',
    }, modelRoute('continue'));

    expect(second.task.id).toBe(first.task.id);
    expect(second.task.requirementIds).toEqual([first.currentRequirement.id]);
    expect(second.currentRequirement.userMessageIds).toEqual(['msg-a', 'msg-b']);
    expect(second.currentRequirement.projectionId).toMatch(/^proj-/);
    expect(second.currentRequirement.projectionId).not.toBe(first.currentRequirement.projectionId);
    expect(second.currentRequirement.projectionIds).toHaveLength(2);
    expect(second.currentRequirement.projectionIds[0]).toBe(first.currentRequirement.projectionId);
    expect(second.currentRequirement.projectionIds[1]).toBe(second.currentRequirement.projectionId);
    expect(second.projectionPreviewCreated).toEqual(expect.objectContaining({ projectionId: second.currentRequirement.projectionId }));
    await expect(store.readConversationTaskState('user-a', 'cid-a')).resolves.toMatchObject({ taskComplete: false });
  });



  it('keeps the task open when semantic routing treats closure-like words as ambiguous continuation', async () => {
    const { state, store } = await modules();
    const first = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-ambiguous', messageId: 'msg-a', text: '帮我写一个完成度检查',
    }, modelRoute('new'));
    const second = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-ambiguous', messageId: 'msg-b', text: '可以检查一下完成度吗',
    }, modelRoute('continue'));

    expect(second.task.id).toBe(first.task.id);
    expect(second.currentRequirement.status).toBe('open');
    expect(second.currentRequirement.userMessageIds).toEqual(['msg-a', 'msg-b']);
    await expect(store.readKstarTask('user-a', first.task.id)).resolves.toMatchObject({ status: 'open' });
    await expect(store.readConversationTaskState('user-a', 'cid-ambiguous')).resolves.toMatchObject({ taskComplete: false });
  });

  it('closes the current requirement and opens a new one for new intent', async () => {
    const { state, store } = await modules();
    const first = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-a', messageId: 'msg-a', text: '修复 OAuth callback',
    }, modelRoute('new'));
    const second = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-a', messageId: 'msg-b', text: '另外检查 refresh token',
    }, modelRoute('new'));

    const oldRequirement = await store.readKstarRequirement('user-a', first.currentRequirement.id);
    expect(oldRequirement).toMatchObject({ status: 'waiting_review', userMessageIds: ['msg-a'] });
    expect(second.currentRequirement.id).not.toBe(first.currentRequirement.id);
    expect(second.task.requirementIds).toEqual([first.currentRequirement.id, second.currentRequirement.id]);
    expect(second.state).toMatchObject({ requirementJustClosed: first.currentRequirement.id, taskComplete: false });
  });

  it('marks the current requirement and task ready for ordered completion', async () => {
    const { state, store } = await modules();
    const first = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-a', messageId: 'msg-a', text: '修复错误提示',
    }, modelRoute('new'));
    const result = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-a', messageId: 'msg-b', text: '任务完成了',
    }, modelRoute('complete'));

    expect(await store.readKstarRequirement('user-a', first.currentRequirement.id)).toMatchObject({
      status: 'waiting_review', userMessageIds: ['msg-a', 'msg-b'],
    });
    expect(await store.readKstarTask('user-a', first.task.id)).toMatchObject({ status: 'closing', closeReason: 'user_complete' });
    expect(result.state).toMatchObject({ requirementJustClosed: first.currentRequirement.id, taskComplete: true });
  });



  it('derives the current lifecycle snapshot from the existing task requirement and projection records', async () => {
    const { state, store } = await modules();
    const result = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-projection', messageId: 'msg-projection', text: '审查预加载资产和唤醒流程', workspaceId: 'workspace-a',
    }, modelRoute('new'));
    const lifecycle = await import('../../../../src/main/features/kstar/lifecycle-adapter');

    expect(result.task).toMatchObject({ id: result.state.currentTaskId, status: 'open', currentRequirementId: result.currentRequirement.id, requirementIds: [result.currentRequirement.id] });
    expect(result.currentRequirement.rHat).toMatchObject({ summary: '审查预加载资产和唤醒流程', source: 'user_message', confidence: 0.6 });
    expect(result.currentRequirement.projectionId).toMatch(/^proj-/);

    const snapshot = await lifecycle.readKstarTaskLifecycle('user-a', 'cid-projection');
    expect(snapshot).toMatchObject({
      status: 'preload_preview',
      task: { id: result.task.id, currentRequirementId: result.currentRequirement.id },
      requirement: { id: result.currentRequirement.id, projectionId: result.currentRequirement.projectionId },
      projection: { id: result.currentRequirement.projectionId, taskRunId: result.task.id, status: 'preview', purpose: '审查预加载资产和唤醒流程' },
    });
    await expect(store.readConversationTaskState('user-a', 'cid-projection')).resolves.toMatchObject({ currentRequirementId: result.currentRequirement.id, taskComplete: false });
  });

  it('persists a topic-switch message until the old task closes', async () => {
    const { state, store } = await modules();
    const first = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-a', messageId: 'msg-a', text: '修复 OAuth callback',
    }, modelRoute('new'));
    const result = await state.routeKstarUserMessage('user-a', {
      conversationId: 'cid-a', messageId: 'msg-b', text: '换个话题，设计发票导出',
    }, modelRoute('topic_switch'));

    expect(result.state).toMatchObject({
      requirementJustClosed: first.currentRequirement.id,
      taskComplete: true,
      pendingTaskStart: { userMessageId: 'msg-b', text: '换个话题，设计发票导出', reason: 'topic_switch' },
    });
    expect(await store.readKstarTask('user-a', first.task.id)).toMatchObject({ status: 'closing', closeReason: 'topic_switch' });
    expect((await store.readKstarRequirement('user-a', first.currentRequirement.id))?.userMessageIds).toEqual(['msg-a']);
  });
});
