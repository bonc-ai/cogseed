import { describe, expect, it, vi } from 'vitest';

/**
 * 接待会话里的写审批（设计 §3.6 L3）。
 *
 * 写工具在内核里没有审批客户端，这条宿主预检是它唯一的闸门：接访会话里的写必须
 * 逐次得到接收方本人批准，普通会话不受影响。
 */
const base = {
  userId: 'u1',
  requestId: 'req-1',
  runtimeSessionId: 'mruntime-1',
  toolName: 'write_file' as const,
  path: '/tmp/a2a-reception-ws/note.txt',
  content: 'ok',
  workingDir: '/tmp/a2a-reception-ws',
};

describe('a2a reception › write approval', () => {
  it('asks the receiver before a write inside an active reception', async () => {
    const { requestReceptionWriteApproval } = await import('../../../../src/main/features/a2a/reception-approval');
    const request = vi.fn(async () => ({ approved: true as const, requestId: 'approval-1' }));

    const refusal = await requestReceptionWriteApproval(base, { isReception: async () => true, request });

    expect(refusal).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    const input = request.mock.calls[0][0] as any;
    expect(input).toMatchObject({
      action: 'write_file',
      risk: 'high',
      reasons: ['file_write'],
      // 审计里不放路径与内容。
      auditTarget: 'Sensitive file write',
    });
    expect(input.target).toBe(base.path);
    expect(input.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('blocks the write with the decision code when the receiver declines', async () => {
    const { requestReceptionWriteApproval } = await import('../../../../src/main/features/a2a/reception-approval');
    const refusal = await requestReceptionWriteApproval(base, {
      isReception: async () => true,
      request: async () => ({ approved: false, code: 'E_ACTION_APPROVAL_DENIED' }),
    });
    expect(refusal).toBe('E_ACTION_APPROVAL_DENIED');
  });

  it('never asks for an ordinary conversation', async () => {
    const { requestReceptionWriteApproval } = await import('../../../../src/main/features/a2a/reception-approval');
    const request = vi.fn();
    const refusal = await requestReceptionWriteApproval(base, { isReception: async () => false, request });
    expect(refusal).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('fails open for an ordinary write when the reception check itself errors', async () => {
    const { requestReceptionWriteApproval } = await import('../../../../src/main/features/a2a/reception-approval');
    const request = vi.fn();
    const refusal = await requestReceptionWriteApproval(base, {
      isReception: async () => { throw new Error('store unavailable'); },
      request,
    });
    expect(refusal).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('a2a reception › conversation-level hook', () => {
  it('only builds a hook for an active receiving conversation', async () => {
    const { writeJson } = await import('../../../../src/main/storage');
    const { userContactsFile } = await import('../../../../src/main/paths');
    const chats = await import('../../../../src/main/features/chats');
    const { receptionWriteApprovalForConversation } = await import('../../../../src/main/features/a2a/reception-approval');
    void userContactsFile; void writeJson;

    const cid = 'a2a-0123456789abcdef0123';
    await chats.createConversation('u1', { conversationId: cid, title: '来访' });
    // 等待确认的接访会话：还没到"可以动"的程度。
    await chats.updateConversation('u1', cid, {
      a2a: { role: 'receiver', peer_user_id: 'cs_alice', state: 'waiting', exchange_id: cid },
    });
    expect(await receptionWriteApprovalForConversation('u1', cid)).toBeNull();

    await chats.updateConversation('u1', cid, {
      a2a: { role: 'receiver', peer_user_id: 'cs_alice', state: 'active', exchange_id: cid, workspace: '/tmp/ws' },
    });
    expect(typeof (await receptionWriteApprovalForConversation('u1', cid))).toBe('function');

    // 发起方会话不算接访运行。
    await chats.updateConversation('u1', cid, {
      a2a: { role: 'initiator', peer_user_id: 'cs_alice', state: 'active', exchange_id: cid },
    });
    expect(await receptionWriteApprovalForConversation('u1', cid)).toBeNull();
  });
});
