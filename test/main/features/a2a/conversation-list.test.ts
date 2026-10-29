import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ME = 'cs_self';
const PEER = 'cs_alice';
const USER = 'u1';
let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-conversation-list-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../../src/main/features/chats');
  vi.doUnmock('../../../../src/main/features/contacts/store');
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function seedContact() {
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(USER), {
    version: 1,
    contacts: [{ userId: PEER, name: 'Alice', addedAt: '2026-10-25T00:00:00.000Z' }],
  });
}

async function seedA2A(cid: string, peer: string, state: 'active' | 'waiting' | 'ended', title: string) {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(USER, { conversationId: cid, title });
  await chats.updateConversation(USER, cid, {
    a2a: { outgoing: true, peer_user_id: peer, state, exchange_id: cid, workspace: `/private/${cid}` },
  });
  return chats;
}

async function appendMessage(cid: string, text: string, createdAt: string) {
  const { conversationLayout } = await import('../../../../src/main/util/project-layout');
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  const chats = await import('../../../../src/main/features/chats');
  const file = conversationLayout(USER, cid).messageFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await appendJsonlAtomic(file, {
    id: `m-${cid}`, from: 'user', to: ['user'], text, created_at: createdAt,
  });
  await chats.bumpConversationActivity(USER, cid, createdAt);
}

it('returns only live conversations for this contact in deterministic activity order', async () => {
  await seedContact();
  const { a2aConversationId } = await import('../../../../src/main/features/a2a/extensions');
  const legacyCid = a2aConversationId(ME, PEER);
  await seedA2A(legacyCid, PEER, 'active', '旧会话');
  await seedA2A('a2a-newer', PEER, 'waiting', '报价讨论');
  await seedA2A('a2a-ended', PEER, 'ended', '已结束');
  await seedA2A('a2a-other', 'cs_other', 'active', '其他联系人');
  await appendMessage(legacyCid, '较早一条', '2099-01-01T00:00:00.000Z');
  await appendMessage('a2a-newer', '同会话旧消息', '2099-01-01T12:00:00.000Z');
  await appendMessage('a2a-newer', `  最新   ${'甲'.repeat(90)}\n尾巴`, '2099-01-02T00:00:00.000Z');

  const { listA2AConversationsForContact } = await import(
    '../../../../src/main/features/a2a/conversation-list'
  );
  const rows = await listA2AConversationsForContact(USER, PEER);
  expect(rows.map((row) => row.conversationId)).toEqual(['a2a-newer', legacyCid]);
  expect(rows[0]).toEqual(expect.objectContaining({
    title: '报价讨论', state: 'waiting', preview: `最新 ${'甲'.repeat(77)}`,
  }));
  expect(rows[0].preview).toHaveLength(80);
  expect(rows[0]).not.toHaveProperty('workspace');
  expect(rows[0]).not.toHaveProperty('messages');
});

it('caps equal-activity rows at 50 using conversation id as the tie-breaker', async () => {
  await seedContact();
  for (let index = 0; index < 51; index += 1) {
    const cid = `a2a-cap-${String(index).padStart(2, '0')}`;
    const chats = await seedA2A(cid, PEER, 'active', cid);
    await chats.bumpConversationActivity(USER, cid, '2099-01-01T00:00:00.000Z');
  }

  const { listA2AConversationsForContact } = await import(
    '../../../../src/main/features/a2a/conversation-list'
  );
  const rows = await listA2AConversationsForContact(USER, PEER);
  expect(rows).toHaveLength(50);
  expect(rows.map((row) => row.conversationId)).toEqual(
    Array.from({ length: 50 }, (_, index) => `a2a-cap-${String(index).padStart(2, '0')}`),
  );
});

it('falls back to an empty preview when the message file is unreadable', async () => {
  await seedContact();
  await seedA2A('a2a-unreadable', PEER, 'active', '无法读取');
  const { conversationLayout } = await import('../../../../src/main/util/project-layout');
  const file = conversationLayout(USER, 'a2a-unreadable').messageFile;
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);

  const { listA2AConversationsForContact } = await import(
    '../../../../src/main/features/a2a/conversation-list'
  );
  await expect(listA2AConversationsForContact(USER, PEER)).resolves.toEqual([
    expect.objectContaining({ conversationId: 'a2a-unreadable', preview: '' }),
  ]);
});

it('isolates compact marker results from later cached reads and filtering', async () => {
  await seedContact();
  const chats = await seedA2A('a2a-isolated', PEER, 'active', '隔离会话');
  const first = await chats.listA2AConversationDirectoryRows(USER);
  expect(first[0].a2a?.peer_user_id).toBe(PEER);
  first[0].a2a!.peer_user_id = 'cs_mutated';

  const { listA2AConversationsForContact } = await import(
    '../../../../src/main/features/a2a/conversation-list'
  );
  const rows = await listA2AConversationsForContact(USER, PEER);
  expect(rows.map((row) => row.conversationId)).toEqual(['a2a-isolated']);

  const second = await chats.listA2AConversationDirectoryRows(USER);
  expect(second[0].a2a).toEqual({ outgoing: true, peer_user_id: PEER, state: 'active' });
});

it('uses compact rows and bounded project-aware preview enrichment', async () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    conversation_id: `a2a-bounded-${String(index).padStart(2, '0')}`,
    title: `Conversation ${index}`,
    project_id: `project-${index}`,
    updated_at: `2099-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    a2a: { outgoing: true, peer_user_id: PEER, state: 'active' as const },
  }));
  const listConversations = vi.fn(async () => rows);
  const listA2AConversationDirectoryRows = vi.fn(async () => rows);
  let activeReads = 0;
  let maxActiveReads = 0;
  const getMessagesPage = vi.fn(async () => {
    activeReads += 1;
    maxActiveReads = Math.max(maxActiveReads, activeReads);
    await new Promise<void>((resolve) => setImmediate(resolve));
    activeReads -= 1;
    return { history: [], nextCursor: null };
  });
  const getMessages = vi.fn(async () => {
    activeReads += 1;
    maxActiveReads = Math.max(maxActiveReads, activeReads);
    await new Promise<void>((resolve) => setImmediate(resolve));
    activeReads -= 1;
    return [];
  });
  vi.doMock('../../../../src/main/features/chats', () => ({
    getMessages,
    getMessagesPage,
    listA2AConversationDirectoryRows,
    listConversations,
  }));
  vi.doMock('../../../../src/main/features/contacts/store', () => ({
    getCachedContact: vi.fn(async () => ({ userId: PEER })),
  }));

  const { listA2AConversationsForContact } = await import(
    '../../../../src/main/features/a2a/conversation-list'
  );
  await listA2AConversationsForContact(USER, PEER);

  expect(listA2AConversationDirectoryRows).toHaveBeenCalledWith(USER);
  expect(listConversations).not.toHaveBeenCalled();
  expect(getMessagesPage).toHaveBeenCalledTimes(50);
  expect(getMessagesPage.mock.calls.every((call) => call[4] === rows[Number(call[1].slice(-2))].project_id)).toBe(true);
  expect(maxActiveReads).toBeLessThanOrEqual(8);
});
