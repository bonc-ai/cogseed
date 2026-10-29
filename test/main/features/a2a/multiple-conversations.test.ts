import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_A = 'u-a';
const USER_B = 'u-b';
const ACC_A = 'cs_a';
const ACC_B = 'cs_b';
const FIXED_TIMESTAMP = '2026-10-25T00:00:00.000Z';

interface CapturedQuestion {
  messageId: string;
  to: string;
  conversationId: string;
  kind: string;
  text: string;
}

let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-multiple-conversations-')));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function seedMutualContacts(): Promise<void> {
  const contacts = await import('../../../../src/main/features/contacts/store');
  const requestA = await contacts.requestAdd(USER_A, {
    phone: '13800001234',
    peerUserId: ACC_B,
    peerName: 'Bob',
  });
  await contacts.acceptRequest(USER_A, requestA.id);
  const requestB = await contacts.requestAdd(USER_B, {
    phone: '13800005678',
    peerUserId: ACC_A,
    peerName: 'Alice',
  });
  await contacts.acceptRequest(USER_B, requestB.id);
}

function writeReceptionAgent(userId: string, agentId: string): void {
  const dir = path.join(tmp, userId, 'cloud', 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
    agent_id: agentId,
    name: 'Reception Agent',
    description: 'Answers accepted A2A receptions.',
    category: 'general',
    workflow: '',
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
  }));
}

// Existing confirmation scenarios now pass the server preview explicitly.
async function confirmScope(userId: string, input: any, deps: any = {}) {
  const service = await import('../../../../src/main/features/a2a/reception-service');
  const resolved = await service.previewReceptionWorkspace(userId, input);
  return service.confirmReception(userId, { ...input, ...('preview' in resolved ? { expectedPreview: resolved.preview } : {}) }, deps);
}

describe('a2a conversations', () => {
  it('keeps two account-pair conversations independent on both clients', async () => {
    await seedMutualContacts();
    writeReceptionAgent(USER_B, 'reception-agent');

    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const chats = await import('../../../../src/main/features/chats');
    const sentQuestions: CapturedQuestion[] = [];
    let sendSequence = 0;
    const send = vi.fn(async (input: Omit<CapturedQuestion, 'messageId'>) => {
      const messageId = `relay-message-${++sendSequence}`;
      sentQuestions.push({ ...input, messageId });
      return { messageId };
    });
    const record = vi.fn(async () => {});
    const deps = { selfAccountId: async () => ACC_A, send, record };

    const sentOne = await sendA2AQuestion(USER_A, {
      contactUserId: ACC_B,
      text: 'First independent question',
      mode: 'new',
      requestId: 'req-1',
    }, deps);
    const sentTwo = await sendA2AQuestion(USER_A, {
      contactUserId: ACC_B,
      text: 'Second independent question',
      mode: 'new',
      requestId: 'req-2',
    }, deps);
    expect(sentOne.sent).toBe(true);
    expect(sentTwo.sent).toBe(true);
    expect(sentOne.conversationId).toBeTruthy();
    expect(sentTwo.conversationId).toBeTruthy();
    expect(sentOne.conversationId).not.toBe(sentTwo.conversationId);

    const cidOne = sentOne.conversationId!;
    const cidTwo = sentTwo.conversationId!;
    expect(sentQuestions).toEqual([
      {
        messageId: 'relay-message-1',
        to: ACC_B,
        conversationId: cidOne,
        kind: 'question',
        text: 'First independent question',
        requestId: 'req-1',
      },
      {
        messageId: 'relay-message-2',
        to: ACC_B,
        conversationId: cidTwo,
        kind: 'question',
        text: 'Second independent question',
        requestId: 'req-2',
      },
    ]);
    const [questionOne, questionTwo] = sentQuestions;
    const inboundOne = await handleInboundQuestion(USER_B, {
      messageId: questionOne.messageId,
      conversationId: questionOne.conversationId,
      text: questionOne.text,
      fromAccount: ACC_A,
      fromName: 'Alice',
    });
    const inboundTwo = await handleInboundQuestion(USER_B, {
      messageId: questionTwo.messageId,
      conversationId: questionTwo.conversationId,
      text: questionTwo.text,
      fromAccount: ACC_A,
      fromName: 'Alice',
    });
    expect(inboundOne).toMatchObject({ accepted: true, outcome: { awaitingConfirmation: true } });
    expect(inboundTwo).toMatchObject({ accepted: true, outcome: { awaitingConfirmation: true } });

    expect((await chats.getConversation(USER_B, cidOne))?.a2a).toMatchObject({
      state: 'waiting',
      peer_user_id: ACC_A,
    });
    expect((await chats.getConversation(USER_B, cidTwo))?.a2a).toMatchObject({
      state: 'waiting',
      peer_user_id: ACC_A,
    });

    const workspaceOne = fs.mkdtempSync(path.join(tmp, 'workspace-one-'));
    const workspaceTwo = fs.mkdtempSync(path.join(tmp, 'workspace-two-'));
    const confirmedOne = await confirmScope(USER_B, {
      conversationId: cidOne,
      workspace: workspaceOne,
      assistantAgentId: 'commander',
    });
    expect('error' in confirmedOne).toBe(false);
    const stillWaiting = (await chats.getConversation(USER_B, cidTwo))?.a2a;
    expect(stillWaiting).toMatchObject({ state: 'waiting', peer_user_id: ACC_A });
    expect(stillWaiting?.workspace).toBeUndefined();
    expect(stillWaiting?.assistant_agent_id).toBeUndefined();

    const confirmedTwo = await confirmScope(USER_B, {
      conversationId: cidTwo,
      workspace: workspaceTwo,
      assistantAgentId: 'reception-agent',
    });
    expect('error' in confirmedTwo).toBe(false);
    expect((await chats.getConversation(USER_B, cidOne))?.a2a).toMatchObject({
      state: 'active',
      workspace: workspaceOne,
      assistant_agent_id: 'commander',
    });
    expect((await chats.getConversation(USER_B, cidTwo))?.a2a).toMatchObject({
      state: 'active',
      workspace: workspaceTwo,
      assistant_agent_id: 'reception-agent',
    });

    const receiverConversations = (await chats.listConversations(USER_B))
      .filter((row) => row.a2a?.peer_user_id === ACC_A);
    expect(receiverConversations).toHaveLength(2);

    const cidTwoAtInitiatorBeforeContinue = { ...(await chats.getConversation(USER_A, cidTwo))?.a2a };
    const cidTwoAtReceiverBeforeContinue = { ...(await chats.getConversation(USER_B, cidTwo))?.a2a };
    const continueSend = vi.fn(async () => ({ messageId: 'relay-message-3' }));
    const continueRecord = vi.fn(async () => {});
    const continued = await sendA2AQuestion(USER_B, {
      contactUserId: ACC_A,
      text: 'Continue only the first conversation',
      mode: 'continue',
      conversationId: cidOne,
    }, {
      selfAccountId: async () => ACC_B,
      send: continueSend,
      record: continueRecord,
    });
    expect(continued).toMatchObject({ sent: true, conversationId: cidOne });
    expect(continueSend).toHaveBeenCalledWith({
      to: ACC_A,
      conversationId: cidOne,
      kind: 'question',
      text: 'Continue only the first conversation',
      requestId: expect.stringMatching(/^legacy-[0-9a-f]{32}$/),
    });
    expect((await chats.getConversation(USER_B, cidOne))?.a2a).toMatchObject({
      inbound: true,
      outgoing: true,
      state: 'active',
      workspace: workspaceOne,
      assistant_agent_id: 'commander',
    });
    expect((await chats.getConversation(USER_A, cidTwo))?.a2a).toEqual(cidTwoAtInitiatorBeforeContinue);
    expect((await chats.getConversation(USER_B, cidTwo))?.a2a).toEqual(cidTwoAtReceiverBeforeContinue);
    const initiatorConversations = (await chats.listConversations(USER_A))
      .filter((row) => row.a2a?.peer_user_id === ACC_B);
    expect(initiatorConversations).toHaveLength(2);
    const receiverConversationsAfterContinue = (await chats.listConversations(USER_B))
      .filter((row) => row.a2a?.peer_user_id === ACC_A);
    expect(receiverConversationsAfterContinue).toHaveLength(2);
  });

  it('falls back to the default workspace when the receiver picks none', async () => {
    const contacts = await import('../../../../src/main/features/contacts/store');
    const { handleInboundQuestion } = await import('../../../../src/main/features/a2a/reception-service');
    const { a2aConversationId } = await import('../../../../src/main/features/a2a/extensions');
    const { getWorkspacePath } = await import('../../../../src/main/features/user_workspace');
    const chats = await import('../../../../src/main/features/chats');
    const conversationId = a2aConversationId(ACC_A, ACC_B);
    const request = await contacts.requestAdd(USER_A, {
      phone: '13800001234',
      peerUserId: ACC_B,
      peerName: 'Bob',
    });
    await contacts.acceptRequest(USER_A, request.id);

    await handleInboundQuestion(USER_A, {
      messageId: 'legacy-message',
      conversationId,
      text: 'Use the default workspace',
      fromAccount: ACC_B,
      fromName: 'Bob',
    });
    const confirmed = await confirmScope(USER_A, { conversationId });

    expect('error' in confirmed).toBe(false);
    const workspace = String((await chats.getConversation(USER_A, conversationId))?.a2a?.workspace || '');
    // D4 单根契约：默认不再是用户根，而是按会话解析规则选出的**一个**接待根
    // （标题 slug 子目录），与确认前预览用的是同一个解析器。
    const root = getWorkspacePath(USER_A);
    expect(path.isAbsolute(workspace)).toBe(true);
    expect(workspace.startsWith(root + path.sep)).toBe(true);
    expect(workspace).not.toBe(root);
    expect(fs.existsSync(workspace)).toBe(true);
  });
});
