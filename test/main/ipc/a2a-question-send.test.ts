import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  request: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;
let tmp = '';
let previous: string | undefined;

const outboundMock = vi.hoisted(() => ({
  sendA2AQuestion: vi.fn(async () => ({ sent: true })),
  prepareA2AQuestion: vi.fn(async () => ({ prepared: true, requestId: 'request-1' })),
}));
const conversationListMock = vi.hoisted(() => ({
  listA2AConversationsForContact: vi.fn(async () => ([{
    conversationId: 'a2a-existing',
    title: 'Existing',
    updatedAt: '2099-01-01T00:00:00.000Z',
    state: 'active',
    preview: 'Latest',
  }])),
}));
const receptionMock = vi.hoisted(() => ({
  confirmReception: vi.fn(async () => ({
    marker: { inbound: true, peer_user_id: 'cs_alice', state: 'active' },
    question: {
      messageId: 'stored-message',
      fromAccount: 'cs_alice',
      conversationId: 'a2a-0123456789abcdef0123',
      text: 'stored question',
      fromName: 'Alice',
    },
  })),
  handleInboundQuestion: vi.fn(async () => ({ accepted: false, reason: 'rejected' })),
  declineReception: vi.fn(async () => ({ error: 'not waiting' })),
  listPendingReceptions: vi.fn(async () => []),
}));
const receptionRunMock = vi.hoisted(() => ({
  runReception: vi.fn(async () => ({ status: 'answered' })),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'cogseed.invoke') invokeHandler = fn;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));
vi.mock('../../../src/main/features/a2a/outbound', () => outboundMock);
vi.mock('../../../src/main/features/a2a/conversation-list', () => conversationListMock);
vi.mock('../../../src/main/features/a2a/reception-service', () => receptionMock);
vi.mock('../../../src/main/features/a2a/reception-run', () => receptionRunMock);
vi.mock('../../../src/main/features/a2a/reception-nudge', () => ({
  scheduleReceptionNudge: vi.fn(),
  cancelReceptionNudge: vi.fn(),
}));
vi.mock('../../../src/main/features/a2a/relay-pump', () => ({ startRelayPump: vi.fn() }));
vi.mock('../../../src/main/features/contacts/presence', () => ({ startPresenceHeartbeat: vi.fn() }));

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-question-send-ipc-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  invokeHandler = null;
  outboundMock.sendA2AQuestion.mockClear();
  outboundMock.prepareA2AQuestion.mockClear();
  conversationListMock.listA2AConversationsForContact.mockClear();
  receptionMock.confirmReception.mockClear();
  receptionRunMock.runReception.mockClear();
  vi.resetModules();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser('u1');
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function call(channel: string, payload: unknown): ReturnType<InvokeFn> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler(
    { sender: trustedIpcSender() },
    { channel, payload },
  );
}

describe('ipc > A2A conversation directory', () => {
  it.each(['a2a.reception.receive', 'a2a.relay.send'])(
    'does not expose the main-owned %s channel to renderer invoke',
    async (channel) => {
      await expect(call(channel, {})).resolves.toMatchObject({ ok: false, error: `unknown channel: ${channel}` });
    },
  );

  it('rejects an explicitly malformed mode before dispatching to outbound relay', async () => {
    const result = await call('a2a.question.send', {
      contactUserId: 'cs_alice', text: 'hello', mode: 'resume',
    });

    expect(result).toMatchObject({ ok: false, error: 'invalid a2a question mode' });
    expect(outboundMock.sendA2AQuestion).not.toHaveBeenCalled();
  });

  it('forwards a new question with its request id exactly', async () => {
    const result = await call('a2a.question.send', {
      contactUserId: 'cs_alice', text: 'new question', mode: 'new', requestId: 'request-new',
    });

    expect(outboundMock.sendA2AQuestion).toHaveBeenCalledWith('u1', {
      contactUserId: 'cs_alice', text: 'new question', mode: 'new', requestId: 'request-new',
    });
    expect(result).toEqual({ ok: true, sent: true });
  });

  it('forwards a continued question with its conversation id exactly', async () => {
    const result = await call('a2a.question.send', {
      contactUserId: 'cs_alice', text: 'follow up', mode: 'continue', conversationId: 'a2a-existing',
    });

    expect(outboundMock.sendA2AQuestion).toHaveBeenCalledWith('u1', {
      contactUserId: 'cs_alice', text: 'follow up', mode: 'continue', conversationId: 'a2a-existing',
    });
    expect(result).toEqual({ ok: true, sent: true });
  });

  it('wires contact-scoped listing without changing the projection', async () => {
    const result = await call('a2a.conversations.listForContact', { contactUserId: 'cs_alice' });

    expect(conversationListMock.listA2AConversationsForContact).toHaveBeenCalledWith('u1', 'cs_alice');
    expect(result).toEqual({
      ok: true,
      conversations: [{
        conversationId: 'a2a-existing',
        title: 'Existing',
        updatedAt: '2099-01-01T00:00:00.000Z',
        state: 'active',
        preview: 'Latest',
      }],
    });
  });

  it('wires question preparation without changing its result', async () => {
    const result = await call('a2a.conversation.prepare', { contactUserId: 'cs_alice' });

    expect(outboundMock.prepareA2AQuestion).toHaveBeenCalledWith('u1', 'cs_alice');
    expect(result).toEqual({ ok: true, prepared: true, requestId: 'request-1' });
  });

  it('ignores renderer-supplied question data and runs only the main-owned pending payload', async () => {
    const result = await call('a2a.reception.confirm', {
      conversationId: 'a2a-0123456789abcdef0123',
      workspace: '',
      assistantAgentId: '',
      messageId: 'tampered-message',
      fromAccount: 'cs_attacker',
      fromName: 'Mallory',
      text: 'tampered question',
    });

    expect(receptionMock.confirmReception).toHaveBeenCalledWith('u1', {
      conversationId: 'a2a-0123456789abcdef0123',
      workspace: '',
      assistantAgentId: '',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(receptionRunMock.runReception).toHaveBeenCalledWith('u1', {
      messageId: 'stored-message',
      fromAccount: 'cs_alice',
      conversationId: 'a2a-0123456789abcdef0123',
      text: 'stored question',
      fromName: 'Alice',
    });
    expect(result).toMatchObject({ ok: true, confirmed: true, started: true });
    expect(result).not.toHaveProperty('question');
  });
});
