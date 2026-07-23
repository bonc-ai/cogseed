import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let root: string;
const uid = 'wake-user';
const cid = 'conversation-1';
const agentId = 'agent-1';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-p3394-wake-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.ORKAS_WORKSPACE_ROOT;
  vi.resetModules();
});

describe('P3394 wake service', () => {
  it('persists and reuses a pending wake request when the agent has no approval', async () => {
    const wake = await import('../../../../src/main/features/p3394/wake-service');

    const first = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      agentName: '软件工程师',
      source: 'user_mention',
      sourceActorId: 'user',
      objective: '检查这个项目',
      dispatchPayload: { text: '@软件工程师 检查这个项目' },
    });
    const second = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      agentName: '软件工程师',
      source: 'user_mention',
      sourceActorId: 'user',
      objective: '检查这个项目',
      dispatchPayload: { text: '@软件工程师 检查这个项目' },
    });

    expect(first.approved).toBe(false);
    expect(first.request.status).toBe('pending');
    expect(second.request.id).toBe(first.request.id);

    vi.resetModules();
    const reloaded = await import('../../../../src/main/features/p3394/wake-service');
    const requests = await reloaded.listWakeRequests(uid, cid);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      conversation_id: cid,
      agent_id: agentId,
      source: 'user_mention',
      status: 'pending',
      objective: '检查这个项目',
    });
  });

  it('limits approval to the approved conversation and agent', async () => {
    const wake = await import('../../../../src/main/features/p3394/wake-service');
    const pending = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      agentName: '软件工程师',
      source: 'dispatch_to',
      sourceActorId: 'commander',
      objective: '实现登录页',
      dispatchPayload: { text: '实现登录页' },
    });

    const approved = await wake.approveWakeRequest(uid, pending.request.id);
    expect(approved.request.status).toBe('approved');
    expect(approved.approval).toMatchObject({
      conversation_id: cid,
      agent_id: agentId,
      context_scope: [`conversation:${cid}`],
      behavior_scope: ['dispatch_to'],
      status: 'active',
    });

    const sameScope = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      agentName: '软件工程师',
      source: 'dispatch_to',
      sourceActorId: 'commander',
      objective: '继续实现登录页',
      dispatchPayload: { text: '继续实现登录页' },
    });
    expect(sameScope.approved).toBe(true);

    const otherConversation = await wake.evaluateWake(uid, {
      conversationId: 'conversation-2',
      agentId,
      agentName: '软件工程师',
      source: 'dispatch_to',
      sourceActorId: 'commander',
      objective: '实现另一个任务',
      dispatchPayload: { text: '实现另一个任务' },
    });
    expect(otherConversation.approved).toBe(false);

    const otherAgent = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId: 'agent-2',
      agentName: '测试工程师',
      source: 'dispatch_to',
      sourceActorId: 'commander',
      objective: '测试登录页',
      dispatchPayload: { text: '测试登录页' },
    });
    expect(otherAgent.approved).toBe(false);
  });

  it('records rejection and execution as explicit state transitions', async () => {
    const wake = await import('../../../../src/main/features/p3394/wake-service');
    const rejectedPending = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      source: 'run_worker',
      sourceActorId: 'commander',
      objective: '运行检查',
      dispatchPayload: { text: '运行检查' },
    });
    const rejected = await wake.rejectWakeRequest(uid, rejectedPending.request.id, '当前不需要');
    expect(rejected.status).toBe('rejected');
    expect(rejected.decision_reason).toBe('当前不需要');

    const executablePending = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId,
      source: 'hand_off_to',
      sourceActorId: 'commander',
      objective: '交付报告',
      dispatchPayload: { text: '交付报告' },
    });
    await wake.approveWakeRequest(uid, executablePending.request.id);
    const executed = await wake.markWakeRequestExecuted(uid, executablePending.request.id);
    expect(executed.status).toBe('executed');
    expect(executed.executed_at).toBeTruthy();
  });
});
