import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 发送侧（AC-04/09）：点名联系人 → 一条跨方问题 + 发起方自己的 A2A 会话。
 *
 * 被钉住的是四条边界：只能问联系人、没有账号身份就不发、交换 id 由双方账号派生且
 * 追问复用同一个会话、送不出去时不在本地留一条"看起来发出去了"的消息。
 */
const ME = 'cs_self';
const PEER = 'cs_alice';
const USER = 'u1';
let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-outbound-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../../src/main/features/chats');
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function seedContact() {
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(USER), {
    version: 1,
    contacts: [{ userId: PEER, name: 'Alice', addedAt: new Date().toISOString() }],
  });
}

async function reAddContact() {
  const contacts = await import('../../../../src/main/features/contacts/store');
  const request = await contacts.requestAdd(USER, {
    phone: '13800001234', peerUserId: PEER, peerName: 'Alice',
  });
  await contacts.acceptRequest(USER, request.id);
}

function readIndexedConversation(conversationId: string): Record<string, any> | undefined {
  const indexFile = path.join(tmp, USER, 'cloud', 'chats', '_index.json');
  const rows = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Array<Record<string, any>>;
  return rows.find((row) => row.conversation_id === conversationId);
}

const deps = (overrides: Record<string, unknown> = {}) => ({
  selfAccountId: async () => ME,
  record: vi.fn(async () => {}),
  ...overrides,
});

describe('a2a outbound › who may be asked', () => {
  it('prepares a main-issued request id only for a current contact', async () => {
    await seedContact();
    const { prepareA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    await expect(prepareA2AQuestion(USER, PEER, {
      selfAccountId: async () => ME,
      newRequestId: () => 'req-main-1',
    })).resolves.toEqual({ prepared: true, requestId: 'req-main-1' });
  });

  it('does not prepare a request id for a missing contact', async () => {
    const { prepareA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const newRequestId = vi.fn(() => 'req-main-1');

    await expect(prepareA2AQuestion(USER, PEER, {
      selfAccountId: async () => ME,
      newRequestId,
    })).resolves.toEqual({ prepared: false, error: 'not_contact' });
    expect(newRequestId).not.toHaveBeenCalled();
  });

  it('does not prepare a request id without the local account id', async () => {
    await seedContact();
    const { prepareA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const newRequestId = vi.fn(() => 'req-main-1');

    await expect(prepareA2AQuestion(USER, PEER, {
      selfAccountId: async () => null,
      newRequestId,
    })).resolves.toEqual({ prepared: false, error: 'no_account' });
    expect(newRequestId).not.toHaveBeenCalled();
  });

  it('rejects an invalid generated request id', async () => {
    await seedContact();
    const { prepareA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');

    await expect(prepareA2AQuestion(USER, PEER, {
      selfAccountId: async () => ME,
      newRequestId: () => '../invalid',
    })).resolves.toEqual({ prepared: false, error: 'invalid_request' });
  });

  it('refuses to ask someone who is not a contact', async () => {
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'out-1' }));

    const result = await sendA2AQuestion(USER, { contactUserId: PEER, text: '在吗' }, { ...deps(), send });

    expect(result).toMatchObject({ sent: false, error: 'not_contact' });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send without the local account id (the exchange id would be underivable)', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'out-1' }));

    const result = await sendA2AQuestion(USER, { contactUserId: PEER, text: '在吗' }, {
      ...deps({ selfAccountId: async () => null }),
      send,
    });

    expect(result).toMatchObject({ sent: false, error: 'no_account' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('a2a outbound › the initiator conversation', () => {
  it('relays the question and opens a conversation marked as the initiator side', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const { a2aConversationId } = await import('../../../../src/main/features/a2a/extensions');
    const chats = await import('../../../../src/main/features/chats');
    const send = vi.fn(async (input: any) => {
      // Local authorization and the visible message must be durable before transport starts.
      expect((await chats.getConversation(USER, expectedCid))?.a2a).toMatchObject({
        outgoing: true,
        peer_user_id: PEER,
        state: 'active',
      });
      expect(record).toHaveBeenCalledTimes(1);
      return { messageId: 'out-1' };
    });
    const record = vi.fn(async () => {});
    const expectedCid = a2aConversationId(ME, PEER);

    const result = await sendA2AQuestion(USER, { contactUserId: PEER, text: '报价能给八折吗？' }, { ...deps(), send, record });

    // Legacy callers without mode keep the deterministic account-pair conversation.
    expect(result).toEqual({ sent: true, conversationId: expectedCid });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: PEER,
      conversationId: expectedCid,
      kind: 'question',
      text: '报价能给八折吗？',
      requestId: expect.stringMatching(/^legacy-/),
    }));
    const stored = await chats.getConversation(USER, expectedCid);
    expect(stored?.a2a).toMatchObject({
      outgoing: true,
      peer_user_id: PEER,
      peer_name: 'Alice',
      state: 'active',
      exchange_id: expectedCid,
    });
    // 本人的问题作为一条已发生的消息落进这条会话（不启动本地运行）。
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER,
      conversationId: expectedCid,
      actorId: 'user',
      text: '报价能给八折吗？',
      messageId: expect.stringMatching(/^a2a-out-/),
    }));
    // T1.3：逐消息路由事实落在消息行上，不靠会话 marker 反推。
    const messages = await chats.getMessages(USER, expectedCid);
    expect(messages).toHaveLength(1);
    expect(messages[0].a2a).toEqual({
      visibility: 'cross',
      recipient_user: PEER,
      recipient_name: 'Alice',
    });
  });

  it('reuses the same conversation for a follow-up question', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const chats = await import('../../../../src/main/features/chats');
    const send = vi.fn(async () => ({ messageId: 'out-2' }));

    const first = await sendA2AQuestion(USER, { contactUserId: PEER, text: '第一问' }, { ...deps(), send });
    const before = await chats.getConversation(USER, first.conversationId!);
    const second = await sendA2AQuestion(USER, { contactUserId: PEER, text: '追问' }, { ...deps(), send });

    expect(second.conversationId).toBe(first.conversationId);
    const after = await chats.getConversation(USER, second.conversationId!);
    expect(after?.a2a).toEqual(before?.a2a);
  });

  it('does not relay through an ended legacy exchange after the contact is re-added', async () => {
    await seedContact();
    const chats = await import('../../../../src/main/features/chats');
    const { writeJson } = await import('../../../../src/main/storage');
    const { userContactsFile } = await import('../../../../src/main/paths');
    const { a2aConversationId } = await import('../../../../src/main/features/a2a/extensions');
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const cid = a2aConversationId(ME, PEER);
    await chats.createConversation(USER, { conversationId: cid, title: 'ended exchange' });
    await chats.updateConversation(USER, cid, {
      a2a: { outgoing: true, peer_user_id: PEER, state: 'ended', exchange_id: cid },
    });
    await writeJson(userContactsFile(USER), { version: 1, contacts: [] });
    await seedContact();
    const send = vi.fn(async () => ({ messageId: 'must-not-send' }));

    await expect(sendA2AQuestion(USER, { contactUserId: PEER, text: '旧会话不能复活' }, {
      ...deps(), send,
    })).resolves.toEqual({ sent: false, error: 'invalid_exchange' });
    expect(send).not.toHaveBeenCalled();
    expect((await chats.getConversation(USER, cid))?.a2a).toMatchObject({ state: 'ended' });
  });

  it('never relays through or revives an ended tombstone after the contact is re-added', async () => {
    await seedContact();
    const chats = await import('../../../../src/main/features/chats');
    const { a2aConversationId, a2aConversationInstanceId } = await import('../../../../src/main/features/a2a/extensions');
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'must-not-send' }));
    const record = vi.fn(async () => {});
    const legacyCid = a2aConversationId(ME, PEER);
    const requestId = 'req-ended-tombstone';
    const instanceCid = a2aConversationInstanceId(ME, PEER, requestId);
    for (const cid of [legacyCid, instanceCid]) {
      await chats.createConversation(USER, { conversationId: cid, title: 'ended exchange' });
      await chats.updateConversation(USER, cid, {
        a2a: { outgoing: true, peer_user_id: PEER, state: 'active', exchange_id: cid },
      });
    }
    const contacts = await import('../../../../src/main/features/contacts/store');
    await expect(contacts.deleteContact(USER, PEER)).resolves.toMatchObject({
      removed: true, ended: 2, cleanupPending: false,
    });
    for (const cid of [legacyCid, instanceCid]) {
      await chats.deleteConversation(USER, cid);
    }
    await reAddContact();
    const before = JSON.stringify([readIndexedConversation(legacyCid), readIndexedConversation(instanceCid)]);

    await expect(sendA2AQuestion(USER, { contactUserId: PEER, text: 'legacy' }, {
      ...deps(), send, record,
    })).resolves.toEqual({ sent: false, error: 'invalid_exchange' });
    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER, text: 'continue', mode: 'continue', conversationId: instanceCid,
    }, { ...deps(), send, record })).resolves.toEqual({ sent: false, error: 'invalid_conversation' });
    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER, text: 'reuse request', mode: 'new', requestId,
    }, { ...deps(), send, record })).resolves.toEqual({ sent: false, error: 'invalid_conversation' });

    expect(send).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(await chats.getConversation(USER, legacyCid)).toBeNull();
    expect(await chats.getConversation(USER, instanceCid)).toBeNull();
    expect(JSON.stringify([readIndexedConversation(legacyCid), readIndexedConversation(instanceCid)]))
      .toBe(before);

    const fresh = await sendA2AQuestion(USER, {
      contactUserId: PEER, text: 'fresh request', mode: 'new', requestId: 'req-fresh-after-readd',
    }, { ...deps(), send, record });
    expect(fresh).toMatchObject({ sent: true });
    expect(fresh.conversationId).not.toBe(instanceCid);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ends hidden exchanges when contact removal follows soft deletion', async () => {
    const otherPeer = 'cs_bob';
    const { writeJson } = await import('../../../../src/main/storage');
    const { userContactsFile } = await import('../../../../src/main/paths');
    await writeJson(userContactsFile(USER), {
      version: 1,
      contacts: [PEER, otherPeer].map((userId) => ({
        userId,
        name: userId === PEER ? 'Alice' : 'Bob',
        addedAt: new Date().toISOString(),
      })),
    });
    const chats = await import('../../../../src/main/features/chats');
    const { a2aConversationId, a2aConversationInstanceId } = await import('../../../../src/main/features/a2a/extensions');
    const { reconcileExchangesWithContacts } = await import('../../../../src/main/features/a2a/end-exchange');
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const contacts = await import('../../../../src/main/features/contacts/store');
    const legacyCid = a2aConversationId(ME, PEER);
    const requestId = 'req-deleted-before-contact';
    const instanceCid = a2aConversationInstanceId(ME, PEER, requestId);
    const otherCid = a2aConversationId(ME, otherPeer);
    for (const [cid, peer] of [[legacyCid, PEER], [instanceCid, PEER], [otherCid, otherPeer]]) {
      await chats.createConversation(USER, { conversationId: cid, title: 'active exchange' });
      await chats.updateConversation(USER, cid, {
        a2a: { outgoing: true, peer_user_id: peer, state: 'active', exchange_id: cid },
      });
    }
    await chats.deleteConversation(USER, legacyCid);
    await chats.deleteConversation(USER, instanceCid);
    expect(await chats.getConversation(USER, legacyCid)).toBeNull();
    expect(await chats.getConversation(USER, instanceCid)).toBeNull();

    await expect(contacts.deleteContact(USER, PEER)).resolves.toMatchObject({
      removed: true, ended: 2, cleanupPending: false,
    });
    expect(await reconcileExchangesWithContacts(USER, [otherPeer])).toBe(0);
    await expect(chats.reserveA2AConversationId(USER, legacyCid)).resolves.toMatchObject({
      state: 'deleted', marker: { peer_user_id: PEER, state: 'ended' },
    });
    await expect(chats.reserveA2AConversationId(USER, instanceCid)).resolves.toMatchObject({
      state: 'deleted', marker: { peer_user_id: PEER, state: 'ended' },
    });
    expect((await chats.getConversation(USER, otherCid))?.a2a).toMatchObject({
      peer_user_id: otherPeer, state: 'active',
    });

    await reAddContact();
    const send = vi.fn(async () => ({ messageId: 'must-not-send' }));
    const record = vi.fn(async () => {});
    await expect(sendA2AQuestion(USER, { contactUserId: PEER, text: 'legacy' }, {
      ...deps(), send, record,
    })).resolves.toEqual({ sent: false, error: 'invalid_exchange' });
    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER, text: 'continue', mode: 'continue', conversationId: instanceCid,
    }, { ...deps(), send, record })).resolves.toEqual({ sent: false, error: 'invalid_conversation' });
    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER, text: 'reuse request', mode: 'new', requestId,
    }, { ...deps(), send, record })).resolves.toEqual({ sent: false, error: 'invalid_conversation' });
    expect(send).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(await chats.getConversation(USER, legacyCid)).toBeNull();
    expect(await chats.getConversation(USER, instanceCid)).toBeNull();

    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER, text: 'fresh request', mode: 'new', requestId: 'req-fresh-after-hidden-end',
    }, { ...deps(), send, record })).resolves.toMatchObject({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown send mode instead of using the legacy conversation', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'out' }));

    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER, text: '不能降级', mode: 'malformed' as never,
    }, { ...deps(), send })).resolves.toMatchObject({ sent: false, error: 'invalid_conversation' });
    expect(send).not.toHaveBeenCalled();
  });

  it('creates two independent conversations for two new request ids', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'out' }));
    const first = await sendA2AQuestion(USER, {
      contactUserId: PEER, text: '第一条', mode: 'new', requestId: 'req-main-1',
    }, { ...deps(), send });
    const second = await sendA2AQuestion(USER, {
      contactUserId: PEER, text: '第二条', mode: 'new', requestId: 'req-main-2',
    }, { ...deps(), send });
    expect(first.conversationId).not.toBe(second.conversationId);
  });

  it('ends a new exchange when the contact disappears while relay delivery is in flight', async () => {
    await seedContact();
    const contacts = await import('../../../../src/main/features/contacts/store');
    const { endExchangesWithPeer } = await import('../../../../src/main/features/a2a/end-exchange');
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const chats = await import('../../../../src/main/features/chats');
    const record = vi.fn(async () => {});
    const send = vi.fn(async () => {
      expect(await contacts.removeContact(USER, PEER)).toBe(true);
      expect(await endExchangesWithPeer(USER, PEER)).toBe(0);
      return { messageId: 'delivered-before-removal-completed' };
    });

    const result = await sendA2AQuestion(USER, {
      contactUserId: PEER,
      text: '已经离开本机的问题',
      mode: 'new',
      requestId: 'req-delete-in-flight',
    }, { ...deps(), send, record });

    expect(result).toMatchObject({ sent: true, error: 'not_contact' });
    expect(record).toHaveBeenCalledTimes(1);
    expect((await chats.getConversation(USER, result.conversationId!))?.a2a)
      .toMatchObject({ peer_user_id: PEER, state: 'ended' });

    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER,
      text: '不能再发',
      mode: 'continue',
      conversationId: result.conversationId,
    }, { ...deps(), send, record })).resolves.toEqual({ sent: false, error: 'not_contact' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('reports contact loss when an exchange ends between selection and atomic admission', async () => {
    await seedContact();
    const chats = await import('../../../../src/main/features/chats');
    const cid = 'a2a-4123456789abcdef0123';
    await chats.createConversation(USER, { conversationId: cid, title: 'race target' });
    await chats.updateConversation(USER, cid, {
      a2a: { outgoing: true, peer_user_id: PEER, state: 'active', exchange_id: cid },
    });
    let ended = false;
    vi.doMock('../../../../src/main/features/chats', async () => ({
      ...await vi.importActual<typeof import('../../../../src/main/features/chats')>(
        '../../../../src/main/features/chats'
      ),
      reserveA2AConversationId: async (userId: string, conversationId: string) => {
        const reservation = await chats.reserveA2AConversationId(userId, conversationId);
        if (!ended && conversationId === cid) {
          ended = true;
          await chats.updateConversationAtomic(userId, conversationId, (current) => ({
            a2a: { ...(current.a2a as Record<string, unknown>), state: 'ended' },
          }));
        }
        return reservation;
      },
    }));
    vi.resetModules();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'must-not-send' }));

    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER,
      text: '并发删除',
      mode: 'continue',
      conversationId: cid,
      requestId: 'req-ended-during-admission',
    }, { ...deps(), send })).resolves.toMatchObject({
      sent: false,
      conversationId: cid,
      error: 'not_contact',
    });
    expect(send).not.toHaveBeenCalled();
    expect((await chats.getConversation(USER, cid))?.a2a).toMatchObject({ state: 'ended' });
  });

  it('reuses the same new conversation when one request id is retried', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'out' }));
    const record = vi.fn(async () => {});
    const input = { contactUserId: PEER, text: '同一草稿', mode: 'new' as const, requestId: 'req-main-1' };
    const first = await sendA2AQuestion(USER, input, { ...deps(), send, record });
    const retry = await sendA2AQuestion(USER, input, { ...deps(), send, record });
    expect(retry.conversationId).toBe(first.conversationId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('rejects a request id rebound to different text before transport', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'out' }));
    const record = vi.fn(async () => {});
    const base = { contactUserId: PEER, mode: 'new' as const, requestId: 'req-bound-text' };

    await expect(sendA2AQuestion(USER, { ...base, text: 'original' }, { ...deps(), send, record }))
      .resolves.toMatchObject({ sent: true });
    await expect(sendA2AQuestion(USER, { ...base, text: 'tampered' }, { ...deps(), send, record }))
      .resolves.toMatchObject({ sent: false, error: 'local_persistence_failed' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('does not convert an ordinary conversation on a derived-id collision', async () => {
    await seedContact();
    const chats = await import('../../../../src/main/features/chats');
    const { a2aConversationInstanceId } = await import('../../../../src/main/features/a2a/extensions');
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'out' }));
    const requestId = 'req-main-collision';
    const collision = a2aConversationInstanceId(ME, PEER, requestId);
    await chats.createConversation(USER, { conversationId: collision, title: '普通会话' });
    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER, text: '不能覆盖', mode: 'new', requestId,
    }, { ...deps(), send })).resolves.toMatchObject({ sent: false, error: 'invalid_conversation' });
    expect(send).not.toHaveBeenCalled();
    expect((await chats.getConversation(USER, collision))?.a2a).toBeUndefined();
  });

  it('continues only a live A2A conversation owned by this contact', async () => {
    await seedContact();
    const chats = await import('../../../../src/main/features/chats');
    const { a2aConversationId } = await import('../../../../src/main/features/a2a/extensions');
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'out' }));
    const live = a2aConversationId(ME, PEER);
    const wrongPeer = 'a2a-1123456789abcdef0123';
    const ended = 'a2a-2123456789abcdef0123';
    const ordinary = 'a2a-3123456789abcdef0123';
    for (const [cid, peer, state] of [
      [live, PEER, 'active'], [wrongPeer, 'cs_other', 'active'], [ended, PEER, 'ended'],
    ] as const) {
      await chats.createConversation(USER, { conversationId: cid, title: cid });
      await chats.updateConversation(USER, cid, {
        a2a: { outgoing: true, peer_user_id: peer, state, exchange_id: cid },
      });
    }
    await chats.createConversation(USER, { conversationId: ordinary, title: ordinary });

    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER, text: '继续', mode: 'continue', conversationId: live,
    }, { ...deps(), send })).resolves.toMatchObject({ sent: true, conversationId: live });

    for (const conversationId of [wrongPeer, ended, ordinary, 'a2a-4123456789abcdef0123']) {
      const calls = send.mock.calls.length;
      await expect(sendA2AQuestion(USER, {
        contactUserId: PEER, text: '不能继续', mode: 'continue', conversationId,
      }, { ...deps(), send })).resolves.toMatchObject({ sent: false, error: 'invalid_conversation' });
      expect(send).toHaveBeenCalledTimes(calls);
    }
  });

  it('keeps a recoverable local intent and stable message when delivery is ambiguous', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const chats = await import('../../../../src/main/features/chats');
    const record = vi.fn(async () => {});
    const send = vi.fn(async () => null);
    const input = {
      contactUserId: PEER,
      text: '发不出去',
      mode: 'new' as const,
      requestId: 'req-ambiguous-retry',
    };

    const result = await sendA2AQuestion(USER, input, { ...deps(), send, record });

    expect(result).toMatchObject({ sent: false, error: 'delivery_failed' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(await chats.getConversation(USER, result.conversationId!)).toMatchObject({
      a2a: expect.objectContaining({ outgoing: true, state: 'active' }),
    });

    // Simulate process restart: in-memory reservations disappear, durable intent remains.
    vi.resetModules();
    const restarted = await import('../../../../src/main/features/a2a/outbound');
    send.mockResolvedValueOnce({ messageId: 'out-after-restart' });
    await expect(restarted.recoverA2AOutboundIntents(USER, { ...deps(), send, record }))
      .resolves.toEqual({ recovered: 1, pending: 0, cancelled: 0 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([value]) => value.requestId))
      .toEqual(['req-ambiguous-retry', 'req-ambiguous-retry']);
  });

  it('does not relay when local message persistence fails before transport', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const send = vi.fn(async () => ({ messageId: 'must-not-send' }));
    const record = vi.fn(async () => { throw new Error('disk unavailable'); });

    await expect(sendA2AQuestion(USER, {
      contactUserId: PEER,
      text: '先落盘再发送',
      mode: 'new',
      requestId: 'req-local-write-failure',
    }, { ...deps(), send, record })).resolves.toMatchObject({
      sent: false,
      error: 'local_persistence_failed',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['conversation', 'message', 'prepared', 'relay'] as const)(
    'resumes after a crash at the %s stage without duplicating the visible message',
    async (crashStage) => {
      await seedContact();
      const outbound = await import('../../../../src/main/features/a2a/outbound');
      const chats = await import('../../../../src/main/features/chats');
      const send = vi.fn(async () => ({ messageId: 'relay-one' }));
      const record = vi.fn(async () => {});
      let crashed = false;
      const input = {
        contactUserId: PEER,
        text: 'durable stage message',
        mode: 'new' as const,
        requestId: `req-crash-${crashStage}`,
      };

      const first = await outbound.sendA2AQuestion(USER, input, {
        ...deps(),
        send,
        record,
        afterStage: async (stage) => {
          if (!crashed && stage === crashStage) {
            crashed = true;
            throw new Error(`crash after ${stage}`);
          }
        },
      });
      expect(first.error).toBe('local_persistence_failed');
      expect(first.conversationId).toBeTruthy();
      expect((await chats.getConversation(USER, first.conversationId!))?.a2a)
        .toMatchObject({ outgoing: true, peer_user_id: PEER });

      vi.resetModules();
      const restarted = await import('../../../../src/main/features/a2a/outbound');
      await restarted.recoverA2AOutboundIntents(USER, { ...deps(), send, record });
      const restartedChats = await import('../../../../src/main/features/chats');
      const messages = await restartedChats.getMessages(USER, first.conversationId!, 20);
      expect(messages.filter((message) => message.id.startsWith('a2a-out-'))).toHaveLength(1);
      expect(record).toHaveBeenCalledTimes(1);
      expect(new Set(send.mock.calls.map(([value]) => value.requestId)))
        .toEqual(new Set([input.requestId]));
    },
  );

  it('uses one canonical 4000-character payload and rejects longer questions before persistence', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const chats = await import('../../../../src/main/features/chats');
    const send = vi.fn(async () => ({ messageId: 'out-boundary' }));
    const record = vi.fn(async () => {});
    const accepted = 'x'.repeat(4_000);

    const result = await sendA2AQuestion(USER, {
      contactUserId: PEER, text: accepted, mode: 'new', requestId: 'req-text-4000',
    }, { ...deps(), send, record });
    expect(result.sent).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: accepted }));
    expect((await chats.getMessages(USER, result.conversationId!, 10)).at(-1)?.text).toBe(accepted);

    for (const [requestId, text] of [
      ['req-text-4001', 'y'.repeat(4_001)],
      ['req-text-12000', 'z'.repeat(12_000)],
    ]) {
      const calls = send.mock.calls.length;
      await expect(sendA2AQuestion(USER, {
        contactUserId: PEER, text, mode: 'new', requestId,
      }, { ...deps(), send, record })).resolves.toEqual({ sent: false, error: 'invalid_question' });
      expect(send).toHaveBeenCalledTimes(calls);
    }
  });
});

describe('a2a outbound › the peer assistant reply', () => {
  const answer = {
    messageId: 'amsg-answer',
    fromAccount: PEER,
    toAccount: ME,
    conversationId: 'a2a-0123456789abcdef0123',
    kind: 'answer' as const,
    text: '最多九折',
    fromName: 'Alice',
    createdAt: '2026-10-22T10:10:00.000Z',
  };

  async function seedInitiatorConversation(state: 'active' = 'active') {
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(USER, { conversationId: answer.conversationId, title: '与 Alice 的对话' });
    await chats.updateConversation(USER, answer.conversationId, {
      a2a: {
        outgoing: true,
        peer_user_id: PEER,
        peer_name: 'Alice',
        state,
        exchange_id: answer.conversationId,
      },
    });
  }

  it('lands the reply in the initiator conversation under the peer assistant actor', async () => {
    await seedContact();
    await seedInitiatorConversation();
    const { appendIncomingAnswer, a2aPeerAssistantActorId } = await import('../../../../src/main/features/a2a/outbound');
    const record = vi.fn(async () => {});

    const appended = await appendIncomingAnswer(USER, answer, { record });

    expect(appended).toBe(true);
    expect(record).toHaveBeenCalledWith({
      userId: USER,
      conversationId: answer.conversationId,
      actorId: a2aPeerAssistantActorId(PEER),
      actorName: 'Alice 的助理',
      text: '最多九折',
      messageId: answer.messageId,
    });
    expect(a2aPeerAssistantActorId(PEER)).not.toBe(a2aPeerAssistantActorId(ME));
  });

  it('never pastes an answer into a conversation this side did not start', async () => {
    await seedContact();
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(USER, { conversationId: answer.conversationId, title: '来访' });
    await chats.updateConversation(USER, answer.conversationId, {
      a2a: { role: 'receiver', peer_user_id: PEER, state: 'active', exchange_id: answer.conversationId },
    });
    const { appendIncomingAnswer } = await import('../../../../src/main/features/a2a/outbound');
    const record = vi.fn(async () => {});

    expect(await appendIncomingAnswer(USER, answer, { record })).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('drops an answer when the peer is no longer a contact', async () => {
    await seedInitiatorConversation();
    const contacts = await import('../../../../src/main/features/contacts/store');
    const { appendIncomingAnswer } = await import('../../../../src/main/features/a2a/outbound');
    const record = vi.fn(async () => {});

    expect(await appendIncomingAnswer(USER, answer, { record })).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(await contacts.listHistory(USER, PEER)).toEqual([]);
  });
});

describe('a2a outbound › hub refusal codes', () => {
  it('separates "questions disabled" and "not a contact" from a generic failure', async () => {
    const { relayFailureReason } = await import('../../../../src/main/features/a2a/outbound');
    expect(relayFailureReason('QUESTIONS_DISABLED')).toBe('questions_disabled');
    expect(relayFailureReason('NOT_CONTACT')).toBe('not_contact');
    expect(relayFailureReason('HUB_503')).toBe('delivery_failed');
    expect(relayFailureReason('')).toBe('delivery_failed');
  });

  it('reports the refusal code when the receiver disabled questions', async () => {
    await seedContact();
    const { sendA2AQuestion } = await import('../../../../src/main/features/a2a/outbound');
    const record = vi.fn(async () => {});

    const result = await sendA2AQuestion(USER, { contactUserId: PEER, text: '在吗' }, {
      ...deps(),
      record,
      sendDetailed: async () => ({ ok: false, code: 'QUESTIONS_DISABLED' }),
    });

    expect(result).toMatchObject({ sent: false, error: 'questions_disabled' });
    // The durable local reservation is written before transport, even when
    // the Hub then rejects delivery explicitly.
    expect(record).toHaveBeenCalledTimes(1);
  });
});
