import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
const mocks = vi.hoisted(() => ({ conversation: vi.fn(), page: vi.fn(), enabled: vi.fn(), resolve: vi.fn(), warm: vi.fn() }));
vi.mock('../../../../src/main/features/chats', () => ({ getConversation: mocks.conversation, getMessagesPage: mocks.page }));
vi.mock('../../../../src/main/features/chat_attachments', () => ({ resolveAttachmentAbsPath: mocks.resolve, warmConversationSpace: mocks.warm }));
vi.mock('../../../../src/main/features/recall/source-control', () => ({ isCognitionSourceEnabled: mocks.enabled }));
import { readLocatedSource, resolveLegacyOntologySource } from '../../../../src/main/features/recall/source-locator';
import { normalizeCognitionSourceRef, normalizeCognitionSourceRefs } from '../../../../src/main/features/recall/source-service';
import { cognitionAttachmentSourceId } from '../../../../src/main/features/recall/source-identity';

let root: string;
const quote = '合成项目预计测试通过后可用，尚未确认上线日期。';
const label = `会话 synthetic-chat/synthetic-message · 已确认 · ${quote}`;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-locator-'));
  mocks.conversation.mockResolvedValue({ conversation_id: 'synthetic-chat', title: '合成项目会议' });
  mocks.page.mockResolvedValue({ history: [{ id: 'synthetic-message', text: '请根据附件整理项目记录。',
    ts: '2026-01-01T00:00:00Z', attachments: ['transcript.txt', 'summary.txt'] }], nextCursor: null });
  mocks.enabled.mockResolvedValue(true);
  mocks.resolve.mockImplementation((_user, _cid, name) => ({ ok: true, absPath: path.join(root, name) }));
  await fs.writeFile(path.join(root, 'transcript.txt'), `主持人：项目进展？\n发言人：${quote}\n结束。`);
  await fs.writeFile(path.join(root, 'summary.txt'), '会议讨论了合成项目进展。');
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe('owned text attachment evidence', () => {
  it('resolves the original passage, not the upload request; retains stable identity and locator through normalization', async () => {
    const result = await resolveLegacyOntologySource('owner', label);
    expect(result.recorded).toBe(true); expect(result.issue).toBeUndefined();
    expect(result.refs).toHaveLength(1);
    const ref = result.refs[0];
    expect(ref.id).toBe(cognitionAttachmentSourceId('synthetic-chat', 'synthetic-message', 'transcript.txt'));
    expect(normalizeCognitionSourceRefs([ref], { metadataOnly: true })[0].locator).toEqual(ref.locator);
    expect(await readLocatedSource('owner', ref)).toMatchObject({
      state: 'available', title: 'transcript.txt', excerpt: `发言人：${quote}`, location: { startLine: 2, endLine: 2 },
    });
    expect(mocks.conversation).toHaveBeenCalledWith('owner', 'synthetic-chat');
    expect(await resolveLegacyOntologySource('owner', label.replace(quote, '附件中没有这句话。')))
      .toMatchObject({ recorded: true, refs: [], issue: 'unmatched' });
    expect(await resolveLegacyOntologySource('owner', '会话 synthetic-chat/synthetic-message · 已确认'))
      .toMatchObject({ recorded: true, refs: [], issue: 'unmatched' });
  });
  it('reads the full anchored paragraph and retains different passages of the same source', async () => {
    const ref = (await resolveLegacyOntologySource('owner', label.replace(quote, '合成项目预计测试通过后可用'))).refs[0];
    expect((await readLocatedSource('owner', ref)).excerpt).toBe(`发言人：${quote}`);
    const text = await fs.readFile(path.join(root, 'transcript.txt'), 'utf8');
    const last = { ...ref, locator: { ...ref.locator!, range: { start: text.indexOf('结束'), end: text.length } } };
    const refs = normalizeCognitionSourceRefs([ref, last]);
    expect(refs).toHaveLength(1);
    expect(await readLocatedSource('owner', refs[0])).toMatchObject({
      excerpt: `发言人：${quote}\n结束。`, location: { startLine: 2, endLine: 3 },
    });
  });
  it('rejects ambiguous passages, including identical quotes in two attachments', async () => {
    await fs.writeFile(path.join(root, 'summary.txt'), quote);
    expect(await resolveLegacyOntologySource('owner', label)).toMatchObject({ recorded: true, refs: [], issue: 'ambiguous' });
    await fs.writeFile(path.join(root, 'summary.txt'), '无引文。');
    await fs.appendFile(path.join(root, 'transcript.txt'), quote);
    expect(await resolveLegacyOntologySource('owner', label)).toMatchObject({ issue: 'ambiguous' });
  });
  it('retains unavailable/changed states without reusing stale excerpts or guessing a new passage', async () => {
    const ref = (await resolveLegacyOntologySource('owner', label)).refs[0];
    await fs.appendFile(path.join(root, 'transcript.txt'), '\n补充记录。');
    expect(await readLocatedSource('owner', ref)).toEqual({ state: 'changed', title: 'transcript.txt' });
    mocks.enabled.mockImplementation(async (_uid, source) => source.id !== 'synthetic-chat');
    expect(await readLocatedSource('owner', ref)).toEqual({ state: 'unavailable' });
    expect(await resolveLegacyOntologySource('owner', label)).toMatchObject({ recorded: true, issue: 'unavailable' });
    mocks.enabled.mockResolvedValue(true);
    await fs.unlink(path.join(root, 'summary.txt'));
    expect(await resolveLegacyOntologySource('owner', label)).toMatchObject({ recorded: true, issue: 'read_failed' });
  });
  it('rejects forged IDs, unlisted attachments and unsafe or unversioned coordinates; old refs remain readable', async () => {
    const ref = (await resolveLegacyOntologySource('owner', label)).refs[0];
    expect(await readLocatedSource('owner', { ...ref, id: 'forged-id' })).toEqual({ state: 'unavailable' });
    mocks.page.mockResolvedValue({ history: [{ id: 'synthetic-message', attachments: [], text: quote }], nextCursor: null });
    expect(await readLocatedSource('owner', ref)).toEqual({ state: 'unavailable' });
    expect(normalizeCognitionSourceRef({ ...ref, locator: { ...ref.locator, attachmentName: '../secret.txt' } })).toBeUndefined();
    expect(normalizeCognitionSourceRef({ ...ref, sourceVersion: undefined })).toBeUndefined();
    expect(normalizeCognitionSourceRef({ kind: 'conversation', id: 'legacy-chat' })).toMatchObject({ id: 'legacy-chat', subtype: 'session' });
  });
});
