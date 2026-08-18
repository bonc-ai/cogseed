import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

// Blocking projection gate: this test exercises copy/merge + group send,
// not Recall projection. Fail the preview so the Commander dispatch is not
// gated and the turn can reply normally.
vi.mock('../../../src/main/features/recall/context-projection', () => ({
  previewContextProjection: vi.fn(async () => { throw new Error('no projection in copy-merge tests'); }),
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const modelCalls = vi.hoisted(() => [] as Array<{ sessionId: string; message: string }>);
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: { sessionId?: string; message?: string }) {
    modelCalls.push({
      sessionId: String(opts.sessionId || ''),
      message: String(opts.message || ''),
    });
    yield { type: 'final', text: 'Continued through the group bus' };
    yield { type: 'done' };
  },
  abortActiveSessionsForConversation: vi.fn(() => 0),
}));

const TEST_UID = 'copy-merge-user';
let tmpDir: string;
let previousWorkspace: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-copy-merge-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  modelCalls.length = 0;
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('conversation copy and merge primitives', () => {

// T4.5 空间化：projects 模块已删，测试直接手工建项目壳目录（数据层仍在）。
function makeProject(name: string): { ok: true; project: { project_id: string; name: string } } {
  const pid = `p${Math.random().toString(16).slice(2, 10)}`;
  const projectDir = path.join(tmpDir, TEST_UID, 'cloud', 'projects', pid);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
    project_id: pid,
    name,
    owner_uid: TEST_UID,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }));
  return { ok: true, project: { project_id: pid, name } };
}

  it('copies a conversation to a new cid and remaps commander/member session ids', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const storage = await import('../../../src/main/storage');
    const layout = await import('../../../src/main/util/project-layout');
    const sessions = await import('../../../src/main/model/core-agent/session-store');
    const feature = await import('../../../src/main/features/conversation_copy_merge');

    const source = await chats.createConversation(TEST_UID, {
      title: 'Old conversation',
      agentId: 'agentA',
    });
    await state.seedReservedActors(TEST_UID, source.conversation_id);
    await state.addMember(TEST_UID, source.conversation_id, {
      kind: 'agent',
      id: 'agentA',
      name: 'Agent A',
    });
    await state.setActiveRecipient(TEST_UID, source.conversation_id, 'agentA');

    await storage.appendJsonlAtomic(layout.conversationMessageFile(TEST_UID, source.conversation_id), {
      id: 'msg-source',
      ts: storage.nowIso(),
      from: 'user',
      to: ['commander'],
      text: 'Keep the history, not the attachment body.',
      attachments: ['brief.pdf'],
    });
    await sessions.writeSessionMessagesForUser(TEST_UID, `gconv-${source.conversation_id}`, [
      { role: 'user', content: [{ type: 'text', text: 'Commander context' }] },
    ]);
    await sessions.writeSessionMessagesForUser(TEST_UID, `gmember-${source.conversation_id}-agentA`, [
      { role: 'assistant', content: [{ type: 'text', text: 'Agent private context' }] },
    ]);

    const result = await feature.cloneConversation(TEST_UID, source.conversation_id);
    const newCid = result.newConversation.conversation_id;

    expect(newCid).not.toBe(source.conversation_id);
    expect(result.commanderSessionId).toBe(`gconv-${newCid}`);
    expect(result.memberSessionIds).toContain(`gmember-${newCid}-agentA`);
    expect(await chats.getMessages(TEST_UID, newCid)).toHaveLength(1);
    expect(await sessions.readSessionMessagesForUser(TEST_UID, `gconv-${newCid}`)).toHaveLength(1);
    expect(await sessions.readSessionMessagesForUser(TEST_UID, `gmember-${newCid}-agentA`)).toHaveLength(1);
    expect(await state.readState(TEST_UID, newCid)).not.toHaveProperty('active_recipient');
    expect(fs.existsSync(path.join(tmpDir, TEST_UID, 'cloud', 'chats', newCid, 'attachments'))).toBe(false);
  });

  it('merges multiple conversations into one summary and groups private context by agent_id', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const sessions = await import('../../../src/main/model/core-agent/session-store');
    const feature = await import('../../../src/main/features/conversation_copy_merge');

    const first = await chats.createConversation(TEST_UID, { title: 'Design', agentId: 'agentA' });
    const second = await chats.createConversation(TEST_UID, { title: 'Research', agentId: 'agentA' });
    for (const source of [first, second]) {
      await state.seedReservedActors(TEST_UID, source.conversation_id);
      await state.addMember(TEST_UID, source.conversation_id, { kind: 'agent', id: 'agentA' });
    }
    await sessions.writeSessionMessagesForUser(TEST_UID, `gmember-${first.conversation_id}-agentA`, [
      { role: 'user', content: [{ type: 'text', text: 'Design responsibility' }] },
    ]);
    await sessions.writeSessionMessagesForUser(TEST_UID, `gmember-${second.conversation_id}-agentA`, [
      { role: 'user', content: [{ type: 'text', text: 'Research responsibility' }] },
    ]);

    const result = await feature.mergeConversations(TEST_UID, [first.conversation_id, second.conversation_id], {
      title: 'Merged workstreams',
    });

    expect(result.summaryMessage).toContain('Merged 2 conversations');
    expect(result.agentSummaries).toHaveProperty('agentA');
    expect(result.agentSummaries.agentA.sourceCids).toEqual([first.conversation_id, second.conversation_id]);
    expect(result.agentSummaries.agentA.markdown).toContain('Source Workstreams');
    expect(result.agentSummaries.agentA.markdown).toContain('Design responsibility');
    expect(result.agentSummaries.agentA.markdown).toContain('Research responsibility');
    expect(result.agentSummaries.agentA.markdown).toContain('Conflicts / Risks');

    const commanderContext = JSON.parse(fs.readFileSync(
      `${sessions.resolveSessionPath(TEST_UID, `gconv-${result.newConversation.conversation_id}`)}.context.json`,
      'utf8',
    ));
    const agentContext = JSON.parse(fs.readFileSync(
      `${sessions.resolveSessionPath(TEST_UID, `gmember-${result.newConversation.conversation_id}-agentA`)}.context.json`,
      'utf8',
    ));
    expect(commanderContext).toMatchObject({
      version: 1,
      nextTurnId: 1,
      summaryVersion: 1,
    });
    expect(commanderContext.historySummary).toContain(result.summaryMessage);
    expect(agentContext).toMatchObject({
      version: 1,
      nextTurnId: 1,
      summaryVersion: 1,
    });
    expect(agentContext.historySummary).toContain(result.agentSummaries.agentA.markdown);
  });

  it('rejects mixed-project merges without an explicit destination project', async () => {
    const chats = await import('../../../src/main/features/chats');
    const feature = await import('../../../src/main/features/conversation_copy_merge');

    const projectA = makeProject('Project A');
    const projectB = makeProject('Project B');
    if (!projectA.ok || !projectB.ok) throw new Error('project setup failed');
    const first = await chats.createConversation(TEST_UID, { title: 'Project A', projectId: projectA.project.project_id });
    const second = await chats.createConversation(TEST_UID, { title: 'Project B', projectId: projectB.project.project_id });

    await expect(feature.mergeConversations(TEST_UID, [first.conversation_id, second.conversation_id], {
      title: 'Ambiguous destination',
    })).rejects.toThrow(/same project/i);
  });

  it('respects an explicit global destination for a mixed-project merge', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const feature = await import('../../../src/main/features/conversation_copy_merge');

    const projectA = makeProject('Project A');
    if (!projectA.ok) throw new Error('project setup failed');
    const first = await chats.createConversation(TEST_UID, { title: 'Project A', projectId: projectA.project.project_id });
    const second = await chats.createConversation(TEST_UID, { title: 'Global source' });
    await state.seedReservedActors(TEST_UID, first.conversation_id, projectA.project.project_id);
    await state.seedReservedActors(TEST_UID, second.conversation_id, null);

    const result = await feature.mergeConversations(TEST_UID, [first.conversation_id, second.conversation_id], {
      title: 'Explicitly global',
      projectIdHint: null,
    });

    expect(result.newConversation.project_id).toBeUndefined();
    expect(await chats.getConversation(TEST_UID, result.newConversation.conversation_id, null)).toMatchObject({
      conversation_id: result.newConversation.conversation_id,
    });
  });

  it('builds each merged agent context only from that agent visibility slice', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const storage = await import('../../../src/main/storage');
    const layout = await import('../../../src/main/util/project-layout');
    const visibility = await import('../../../src/main/features/group_chat/visibility');
    const feature = await import('../../../src/main/features/conversation_copy_merge');

    const first = await chats.createConversation(TEST_UID, { title: 'Private source' });
    const second = await chats.createConversation(TEST_UID, { title: 'Other source' });
    for (const source of [first, second]) {
      await state.seedReservedActors(TEST_UID, source.conversation_id);
      await state.addMember(TEST_UID, source.conversation_id, { kind: 'agent', id: 'agentA' });
      await state.addMember(TEST_UID, source.conversation_id, { kind: 'agent', id: 'agentB' });
    }
    const secretMessage = {
      id: 'msg-agent-b-secret',
      ts: storage.nowIso(),
      from: 'agentB',
      to: ['commander'],
      text: 'Agent B private material',
      attachments: ['agent-b-secret.pdf'],
    };
    await storage.appendJsonlAtomic(
      layout.conversationMessageFile(TEST_UID, first.conversation_id),
      secretMessage,
    );
    await visibility.appendVisible(
      TEST_UID,
      first.conversation_id,
      secretMessage,
      ['commander', 'user', 'agentA', 'agentB'],
    );

    const result = await feature.mergeConversations(TEST_UID, [first.conversation_id, second.conversation_id], {
      title: 'Visibility-safe merge',
    });

    expect(result.agentSummaries.agentA.markdown).not.toContain('agent-b-secret.pdf');
    expect(result.agentSummaries.agentA.markdown).not.toContain('Agent B private material');
    expect(result.agentSummaries.agentB.markdown).toContain('agent-b-secret.pdf');
  });

  it('keeps cloned resource fields bound to the source conversation', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const storage = await import('../../../src/main/storage');
    const layout = await import('../../../src/main/util/project-layout');
    const feature = await import('../../../src/main/features/conversation_copy_merge');

    const source = await chats.createConversation(TEST_UID, { title: 'Resource source' });
    await state.seedReservedActors(TEST_UID, source.conversation_id);
    await storage.appendJsonlAtomic(layout.conversationMessageFile(TEST_UID, source.conversation_id), {
      id: 'msg-resources',
      ts: storage.nowIso(),
      from: 'commander',
      to: ['user'],
      text: 'Historical deliverables',
      attachments: ['brief.pdf'],
      produced: ['/workspace/report.csv'],
      artifacts: [{ id: 'artifact-1', title: 'Dashboard', agent_id: 'commander' }],
    });

    const result = await feature.cloneConversation(TEST_UID, source.conversation_id);
    const [message] = await chats.getMessages(TEST_UID, result.newConversation.conversation_id);

    expect(message.attachments).toBeUndefined();
    expect(message.produced).toBeUndefined();
    expect(message.references).toContainEqual(expect.objectContaining({
      source_cid: source.conversation_id,
      source_msg_id: 'msg-resources',
      attachments: [{ name: 'brief.pdf' }],
      produced: ['/workspace/report.csv'],
    }));
    expect(message.artifacts).toEqual([expect.objectContaining({
      id: 'artifact-1',
      source_cid: source.conversation_id,
    })]);
  });

  it('drops transient state and active session execution context from clones', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const storage = await import('../../../src/main/storage');
    const layout = await import('../../../src/main/util/project-layout');
    const sessions = await import('../../../src/main/model/core-agent/session-store');
    const feature = await import('../../../src/main/features/conversation_copy_merge');

    const source = await chats.createConversation(TEST_UID, { title: 'Transient source' });
    await state.seedReservedActors(TEST_UID, source.conversation_id);
    const sourceState = await state.readState(TEST_UID, source.conversation_id);
    await storage.writeJson(layout.conversationLayout(TEST_UID, source.conversation_id).stateFile, {
      ...sourceState,
      workspace_dir: 'durable-workspace',
      coding_project_dir: '/durable/project',
      coding_project_dir_explicit: true,
      tool_extra_roots: ['/private/temporary-root'],
      sync_conflict_resolution: {
        version: 1,
        conflicts: [{ id: 'c1', rel_path: 'a.txt', current_path: '/private/a.txt' }],
      },
    });
    const sourceSessionId = `gconv-${source.conversation_id}`;
    await sessions.writeSessionMessagesForUser(TEST_UID, sourceSessionId, [
      { role: 'user', content: [{ type: 'text', text: 'Durable transcript' }], turnId: 4 },
    ]);
    fs.writeFileSync(`${sessions.resolveSessionPath(TEST_UID, sourceSessionId)}.context.json`, JSON.stringify({
      version: 1,
      nextTurnId: 5,
      historySummary: 'Durable summary',
      summaryVersion: 2,
      activeTurn: { id: 4, userMessageIndex: 0, startIndex: 0 },
      executionPlan: { version: 1, objective: 'unfinished', steps: [] },
      executionPlanAudit: [{ action: 'update' }],
      completedWork: [{ id: 1 }],
      resources: [{ path: '/private/result', kind: 'tool_result' }],
    }));

    const result = await feature.cloneConversation(TEST_UID, source.conversation_id);
    const clonedState = await state.readState(TEST_UID, result.newConversation.conversation_id);
    const clonedContext = JSON.parse(fs.readFileSync(
      `${sessions.resolveSessionPath(TEST_UID, result.commanderSessionId)}.context.json`,
      'utf8',
    ));

    expect(clonedState).toMatchObject({
      status: 'idle',
      in_flight: [],
      workspace_dir: 'durable-workspace',
      coding_project_dir: '/durable/project',
      coding_project_dir_explicit: true,
    });
    expect(clonedState).not.toHaveProperty('tool_extra_roots');
    expect(clonedState).not.toHaveProperty('sync_conflict_resolution');
    expect(clonedContext).toMatchObject({
      version: 1,
      nextTurnId: 5,
      historySummary: 'Durable summary',
      summaryVersion: 2,
    });
    expect(clonedContext).not.toHaveProperty('activeTurn');
    expect(clonedContext).not.toHaveProperty('executionPlan');
    expect(clonedContext).not.toHaveProperty('executionPlanAudit');
    expect(clonedContext).not.toHaveProperty('completedWork');
    expect(clonedContext).not.toHaveProperty('resources');
  });

  it('removes a partially-created clone when a session write fails', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const sessions = await import('../../../src/main/model/core-agent/session-store');

    const source = await chats.createConversation(TEST_UID, { title: 'Rollback source' });
    await state.seedReservedActors(TEST_UID, source.conversation_id);
    await sessions.writeSessionMessagesForUser(TEST_UID, `gconv-${source.conversation_id}`, [
      { role: 'user', content: [{ type: 'text', text: 'Source session' }] },
    ]);
    const before = new Set((await chats.listConversations(TEST_UID)).map((item) => item.conversation_id));
    vi.spyOn(sessions, 'cloneSessionForUser').mockRejectedValueOnce(new Error('injected session failure'));
    const feature = await import('../../../src/main/features/conversation_copy_merge');

    await expect(feature.cloneConversation(TEST_UID, source.conversation_id)).rejects.toThrow('injected session failure');

    const after = await chats.listConversations(TEST_UID);
    expect(after.map((item) => item.conversation_id)).toEqual(expect.arrayContaining([...before]));
    expect(after).toHaveLength(before.size);
  });

  it('removes a partially-created merge when a session summary write fails', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const sessions = await import('../../../src/main/model/core-agent/session-store');

    const first = await chats.createConversation(TEST_UID, { title: 'Rollback merge one' });
    const second = await chats.createConversation(TEST_UID, { title: 'Rollback merge two' });
    for (const source of [first, second]) await state.seedReservedActors(TEST_UID, source.conversation_id);
    const before = new Set((await chats.listConversations(TEST_UID)).map((item) => item.conversation_id));
    vi.spyOn(sessions, 'writeMergedSessionSummaryForUser').mockRejectedValueOnce(
      new Error('injected merge session failure'),
    );
    const feature = await import('../../../src/main/features/conversation_copy_merge');

    await expect(feature.mergeConversations(TEST_UID, [first.conversation_id, second.conversation_id], {
      title: 'Rollback merge',
    })).rejects.toThrow('injected merge session failure');

    const after = await chats.listConversations(TEST_UID);
    expect(after.map((item) => item.conversation_id)).toEqual(expect.arrayContaining([...before]));
    expect(after).toHaveLength(before.size);
  });

  it('resumes cloned and merged sessions with a fresh completed turn', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const sessions = await import('../../../src/main/model/core-agent/session-store');
    const feature = await import('../../../src/main/features/conversation_copy_merge');

    const first = await chats.createConversation(TEST_UID, { title: 'Resume one' });
    const second = await chats.createConversation(TEST_UID, { title: 'Resume two' });
    for (const source of [first, second]) await state.seedReservedActors(TEST_UID, source.conversation_id);
    await sessions.writeSessionMessagesForUser(TEST_UID, `gconv-${first.conversation_id}`, [
      { role: 'user', content: [{ type: 'text', text: 'Existing turn' }], turnId: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'Existing reply' }], turnId: 1 },
    ]);

    const cloned = await feature.cloneConversation(TEST_UID, first.conversation_id);
    const merged = await feature.mergeConversations(TEST_UID, [first.conversation_id, second.conversation_id], {
      title: 'Resume merged',
    });
    for (const sessionId of [cloned.commanderSessionId, `gconv-${merged.newConversation.conversation_id}`]) {
      const session = await sessions.getSession(sessionId);
      session.beginUserTurn([{ type: 'text', text: 'Continue now' }]);
      session.addAssistantMessage([{ type: 'text', text: 'Continued reply' }]);
      session.completeActiveTurn('completed');
      const context = JSON.parse(fs.readFileSync(`${sessions.resolveSessionPath(TEST_UID, sessionId)}.context.json`, 'utf8'));
      expect(context).not.toHaveProperty('activeTurn');
      expect(await sessions.readSessionMessagesForUser(TEST_UID, sessionId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Continue now' }] }),
        expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'Continued reply' }] }),
      ]));
    }
  });

  it('continues cloned and merged conversations through the real group send path', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const feature = await import('../../../src/main/features/conversation_copy_merge');
    const groupChat = await import('../../../src/main/features/group_chat');

    const first = await chats.createConversation(TEST_UID, { title: 'Send one' });
    const second = await chats.createConversation(TEST_UID, { title: 'Send two' });
    for (const source of [first, second]) await state.seedReservedActors(TEST_UID, source.conversation_id);
    const cloned = await feature.cloneConversation(TEST_UID, first.conversation_id);
    const merged = await feature.mergeConversations(TEST_UID, [first.conversation_id, second.conversation_id], {
      title: 'Send merged',
    });

    for (const [cid, text] of [
      [cloned.newConversation.conversation_id, 'Continue after copy'],
      [merged.newConversation.conversation_id, 'Continue after merge'],
    ]) {
      const sent = await groupChat.send({ userId: TEST_UID, cid, text });
      expect(sent.ok).toBe(true);
      const deadline = Date.now() + 4_000;
      let replyFound = false;
      while (Date.now() < deadline) {
        const messages = await chats.getMessages(TEST_UID, cid);
        replyFound = messages.some((message) => (
          message.from === 'commander' && message.text === 'Continued through the group bus'
        ));
        const currentState = await state.readState(TEST_UID, cid);
        if (replyFound && currentState.status === 'idle' && currentState.in_flight.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(replyFound).toBe(true);
      expect(modelCalls).toContainEqual(expect.objectContaining({
        sessionId: `gconv-${cid}`,
        message: expect.stringContaining(text),
      }));
    }
  });

  it('requires at least two distinct source conversations for a merge', async () => {
    const chats = await import('../../../src/main/features/chats');
    const feature = await import('../../../src/main/features/conversation_copy_merge');
    const source = await chats.createConversation(TEST_UID, { title: 'Only source' });

    await expect(feature.mergeConversations(TEST_UID, [source.conversation_id], {
      title: 'Not a merge',
    })).rejects.toThrow(/at least two/i);
    await expect(feature.mergeConversations(TEST_UID, [source.conversation_id, source.conversation_id], {
      title: 'Duplicate source',
    })).rejects.toThrow(/at least two/i);
  });

  it('applies an explicit time range, deduplicates across sources, and reports actual injection', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const storage = await import('../../../src/main/storage');
    const layout = await import('../../../src/main/util/project-layout');
    const feature = await import('../../../src/main/features/conversation_copy_merge');
    const first = await chats.createConversation(TEST_UID, { title: 'Range one' });
    const second = await chats.createConversation(TEST_UID, { title: 'Range two' });
    for (const source of [first, second]) await state.seedReservedActors(TEST_UID, source.conversation_id);
    const append = (cid: string, message: Record<string, unknown>) => storage.appendJsonlAtomic(
      layout.conversationMessageFile(TEST_UID, cid),
      message,
    );
    await append(first.conversation_id, {
      id: 'old-risk', ts: '2026-08-01T00:00:00.000Z', from: 'user', to: ['commander'],
      text: 'Old risk must stay outside the range.',
    });
    await append(first.conversation_id, {
      id: 'shared-message', ts: '2026-08-10T10:00:00.000Z', from: 'user', to: ['commander'],
      text: 'Shared in-range risk.',
    });
    await append(second.conversation_id, {
      id: 'shared-message', ts: '2026-08-10T10:00:00.000Z', from: 'user', to: ['commander'],
      text: 'Shared in-range risk.',
    });
    await append(second.conversation_id, {
      id: 'range-risk', ts: '2026-08-10T11:00:00.000Z', from: 'assistant', to: ['user'],
      text: 'Actual in-range risk.',
    });

    const merged = await feature.mergeConversations(TEST_UID, [first.conversation_id, second.conversation_id], {
      title: 'Scoped merge',
      scope: {
        kind: 'time_range',
        startAt: '2026-08-10T09:00:00.000Z',
        endAt: '2026-08-10T12:00:00.000Z',
      },
    });

    expect(merged.scopeReceipt).toMatchObject({
      kind: 'time_range',
      requestedStartAt: '2026-08-10T09:00:00.000Z',
      requestedEndAt: '2026-08-10T12:00:00.000Z',
    });
    expect(merged.scopeReceipt.sources).toEqual([
      expect.objectContaining({ sourceCid: first.conversation_id, selectedMessageCount: 1, actualMessageCount: 1 }),
      expect.objectContaining({
        sourceCid: second.conversation_id,
        selectedMessageCount: 2,
        actualMessageCount: 1,
        deduplicatedCount: 1,
        reasons: expect.arrayContaining(['duplicate_message_id', 'private_session_omitted_for_time_range']),
      }),
    ]);
    expect(merged.summaryMessage).toContain('Actual in-range risk.');
    expect(merged.summaryMessage).not.toContain('Old risk must stay outside the range.');
  });

  it('records messages omitted by the merge context limit', async () => {
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const storage = await import('../../../src/main/storage');
    const layout = await import('../../../src/main/util/project-layout');
    const feature = await import('../../../src/main/features/conversation_copy_merge');
    const first = await chats.createConversation(TEST_UID, { title: 'Large one' });
    const second = await chats.createConversation(TEST_UID, { title: 'Large two' });
    for (const source of [first, second]) await state.seedReservedActors(TEST_UID, source.conversation_id);
    for (let index = 0; index < 205; index += 1) {
      const cid = index < 103 ? first.conversation_id : second.conversation_id;
      await storage.appendJsonlAtomic(layout.conversationMessageFile(TEST_UID, cid), {
        id: `large-${index}`,
        ts: new Date(Date.UTC(2026, 7, 10, 0, index)).toISOString(),
        from: index % 2 ? 'commander' : 'user',
        to: index % 2 ? ['user'] : ['commander'],
        text: `Message ${index}`,
      });
    }

    const merged = await feature.mergeConversations(TEST_UID, [first.conversation_id, second.conversation_id], {
      title: 'Bounded merge',
    });
    const totals = merged.scopeReceipt.sources.reduce((acc, source) => ({
      selected: acc.selected + source.selectedMessageCount,
      actual: acc.actual + source.actualMessageCount,
      truncated: acc.truncated + source.truncatedCount,
    }), { selected: 0, actual: 0, truncated: 0 });

    expect(totals).toEqual({ selected: 205, actual: 200, truncated: 5 });
    expect(merged.scopeReceipt.sources.some((source) => source.reasons.includes('context_limit'))).toBe(true);
  });


  it('localizes main-generated copy titles and merge summaries', async () => {
    const i18n = await import('../../../src/main/i18n');
    const chats = await import('../../../src/main/features/chats');
    const state = await import('../../../src/main/features/group_chat/state');
    const feature = await import('../../../src/main/features/conversation_copy_merge');
    i18n.setCurrentLang('zh');

    const first = await chats.createConversation(TEST_UID, { title: '来源一' });
    const second = await chats.createConversation(TEST_UID, { title: '来源二' });
    for (const source of [first, second]) await state.seedReservedActors(TEST_UID, source.conversation_id);

    const cloned = await feature.cloneConversation(TEST_UID, first.conversation_id);
    const merged = await feature.mergeConversations(TEST_UID, [first.conversation_id, second.conversation_id], {
      title: '归并任务',
    });

    expect(cloned.newConversation.title).toBe('来源一（副本）');
    expect(merged.summaryMessage).toContain('已合并 2 个会话：归并任务');
    expect(merged.summaryMessage).toContain('## 来源会话');
  });

});
