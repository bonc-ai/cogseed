import { beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({ conversation: vi.fn(), page: vi.fn(), enabled: vi.fn(), asset: vi.fn() }));
vi.mock('../../../../src/main/features/chats', () => ({ getConversation: mocks.conversation, getMessagesPage: mocks.page, getMessages: vi.fn() }));
vi.mock('../../../../src/main/features/chat_attachments', () => ({ resolveAttachmentAbsPath: vi.fn(), warmConversationSpace: vi.fn() }));
vi.mock('../../../../src/main/features/recall/source-control', () => ({ isCognitionSourceEnabled: mocks.enabled }));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({ readAbilityAsset: mocks.asset }));
vi.mock('../../../../src/main/features/recall/candidate-service', () => ({ readRecallCandidate: vi.fn() }));
import { cognitionMessageSourceRef, readLocatedSource } from '../../../../src/main/features/recall/source-locator';
import { readReviewEvidence } from '../../../../src/main/features/recall/review-evidence';
import { readJsonlPage } from '../../../../src/main/storage';

const ref = cognitionMessageSourceRef('chat-a', { id: 'message-a', text: '原文' });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.conversation.mockResolvedValue({ conversation_id: 'chat-a', title: '示例' });
  mocks.page.mockResolvedValue({ history: [], nextCursor: null });
  mocks.enabled.mockResolvedValue(true);
  mocks.asset.mockResolvedValue({ evidenceRefs: [ref] });
});

it('区分已查找的缺失消息、停用来源和读取失败，缺失状态传递到审核详情', async () => {
  expect(await readLocatedSource('owner', ref)).toEqual({ state: 'missing' });
  expect(mocks.page).toHaveBeenCalledWith('owner', 'chat-a', 100, undefined, undefined, { strict: true });
  expect(await readReviewEvidence('owner', { assetId: 'asset-a' })).toMatchObject([{ state: 'missing' }]);
  mocks.enabled.mockResolvedValue(false);
  expect(await readLocatedSource('owner', ref)).toEqual({ state: 'unavailable' });
  mocks.enabled.mockResolvedValue(true);
  mocks.page.mockRejectedValue(new Error('disk error'));
  expect(await readLocatedSource('owner', ref)).toEqual({ state: 'read_failed' });
  mocks.page.mockRejectedValue(Object.assign(new Error('file absent'), { code: 'ENOENT' }));
  expect(await readLocatedSource('owner', ref)).toEqual({ state: 'missing' });
});

it('核对缺失时读取失败和损坏记录不会变成空列表，普通读取保持原行为', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'missing-source-read-'));
  try {
    const file = path.join(root, 'messages.jsonl');
    await expect(readJsonlPage(file, 100, undefined, { strict: true })).rejects.toThrow();
    expect((await readJsonlPage(file)).records).toEqual([]);
    await fs.writeFile(file, '{"id":"one"}\n{invalid}\n');
    await expect(readJsonlPage(file, 100, undefined, { strict: true })).rejects.toThrow('invalid JSONL record');
    expect((await readJsonlPage(file)).records).toEqual([{ id: 'one' }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
