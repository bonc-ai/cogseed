import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async (input: { text: string }) => ({
    id: 'replacement-msg',
    ts: '2026-08-06T12:00:00.000Z',
    from: 'user',
    to: ['commander'],
    text: input.text,
  })),
  runtimeSnapshot: vi.fn(() => ({ processing: false, inFlight: [] })),
  evictSession: vi.fn(),
  deleteSessionFileForUser: vi.fn(),
  clearForConversation: vi.fn(async () => undefined),
}));

vi.mock('../../../../src/main/features/group_chat/bus', () => ({
  abort: vi.fn(async () => undefined),
  dropConv: vi.fn(async () => undefined),
  enqueue: mocks.enqueue,
  isQuiescent: vi.fn(() => true),
  runtimeSnapshot: mocks.runtimeSnapshot,
  subscribe: vi.fn(),
}));

vi.mock('../../../../src/main/model/core-agent/session-store', () => ({
  evictSession: mocks.evictSession,
  deleteSessionFileForUser: mocks.deleteSessionFileForUser,
}));

vi.mock('../../../../src/main/features/local_agents/sessions', () => ({
  clearForConversation: mocks.clearForConversation,
}));

let tmpDir: string;
let previousWorkspace: string | undefined;
const UID = 'edit-user';
const CID = 'edit-cid';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-message-edit-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  mocks.enqueue.mockClear();
  mocks.runtimeSnapshot.mockClear();
  mocks.evictSession.mockClear();
  mocks.deleteSessionFileForUser.mockClear();
  mocks.clearForConversation.mockClear();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeConversationRows(rows: Array<Record<string, unknown>>): Promise<{
  layout: ReturnType<(typeof import('../../../../src/main/util/project-layout'))['conversationLayout']>;
  groupChat: typeof import('../../../../src/main/features/group_chat');
}> {
  const layoutModule = await import('../../../../src/main/util/project-layout');
  const groupChat = await import('../../../../src/main/features/group_chat');
  const layout = layoutModule.conversationLayout(UID, CID);
  fs.mkdirSync(path.dirname(layout.messageFile), { recursive: true });
  fs.writeFileSync(layout.messageFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  fs.mkdirSync(layout.visibilityDir, { recursive: true });
  fs.writeFileSync(layout.visibilityFile('commander'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return { layout, groupChat };
}

describe('group_chat user message replacement', () => {
  it('tombstones the selected tail, preserves request metadata, and resets context', async () => {
    const { layout, groupChat } = await writeConversationRows([
      { id: 'keep-msg', ts: '2026-08-06T11:00:00.000Z', from: 'user', to: ['commander'], text: 'keep' },
      {
        id: 'edit-msg',
        ts: '2026-08-06T11:01:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'old text',
        attachments: ['brief.md'],
        use_selections: [{ token: 'use:research' }],
        references: [{ source_cid: 'source-cid', source_msg_id: 'source-msg' }],
      },
      { id: 'after-msg', ts: '2026-08-06T11:02:00.000Z', from: 'commander', to: ['user'], text: 'old reply' },
    ]);

    const result = await groupChat.replaceUserMessage({
      userId: UID,
      cid: CID,
      messageId: 'edit-msg',
      text: 'new text',
    });

    expect(result).toMatchObject({ ok: true, msg: { text: 'new text' } });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      uid: UID,
      cid: CID,
      fromActorId: 'user',
      text: 'new text',
      attachments: ['brief.md'],
      use_selections: [{ token: 'use:research' }],
      references: [{ source_cid: 'source-cid', source_msg_id: 'source-msg' }],
    }));

    const mainRows = fs.readFileSync(layout.messageFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const sliceRows = fs.readFileSync(layout.visibilityFile('commander'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(mainRows.map((row) => row.id)).toEqual(['keep-msg', 'edit-msg', 'after-msg']);
    expect(mainRows.slice(1).every((row) => row.deleted_at && row.deleted_by_user && row.text === '')).toBe(true);
    expect(sliceRows.slice(1).every((row) => row.deleted_at && row.deleted_by_user && row.text === '')).toBe(true);
    expect((await groupChat.readMessages(UID, CID)).map((row) => row.id)).toEqual(['keep-msg']);
    expect(mocks.evictSession).toHaveBeenCalled();
    expect(mocks.deleteSessionFileForUser).toHaveBeenCalled();
    expect(mocks.clearForConversation).toHaveBeenCalledWith(UID, CID);
  });

  it('rejects assistant, deleted, invalid, and running targets before any rewrite', async () => {
    const { layout, groupChat } = await writeConversationRows([
      { id: 'assistant-msg', ts: '2026-08-06T11:00:00.000Z', from: 'commander', to: ['user'], text: 'reply' },
      { id: 'deleted-msg', ts: '2026-08-06T11:01:00.000Z', from: 'user', to: ['commander'], text: '', deleted_at: '2026-08-06T11:02:00.000Z' },
    ]);

    for (const messageId of ['assistant-msg', 'deleted-msg', 'missing-msg']) {
      await expect(groupChat.replaceUserMessage({ userId: UID, cid: CID, messageId, text: 'replacement' }))
        .resolves.toMatchObject({ ok: false });
    }
    mocks.runtimeSnapshot.mockReturnValueOnce({ processing: true, inFlight: ['commander'] });
    await expect(groupChat.replaceUserMessage({ userId: UID, cid: CID, messageId: 'assistant-msg', text: 'replacement' }))
      .resolves.toMatchObject({ ok: false });

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(fs.readFileSync(layout.messageFile, 'utf8')).toContain('"reply"');
  });
});
