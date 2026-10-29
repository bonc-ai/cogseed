import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ candidate: vi.fn(), asset: vi.fn(), conversation: vi.fn(), messages: vi.fn(), enabled: vi.fn(), located: vi.fn() }));
vi.mock('../../../../src/main/features/recall/source-locator', () => ({ readLocatedSource: mocks.located }));
vi.mock('../../../../src/main/features/recall/candidate-service', () => ({ readRecallCandidate: mocks.candidate }));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({ readAbilityAsset: mocks.asset }));
vi.mock('../../../../src/main/features/chats', () => ({ getConversation: mocks.conversation, getMessages: mocks.messages }));
vi.mock('../../../../src/main/features/recall/source-control', () => ({ isCognitionSourceEnabled: mocks.enabled }));
import { readReviewEvidence } from '../../../../src/main/features/recall/review-evidence';
const ref = { kind: 'conversation', id: 'conversation-a', taxonomyVersion: 2, subtype: 'session' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.candidate.mockResolvedValue({ createdAt: '2026-10-11T12:00:00Z', evidenceRefs: [ref] });
  mocks.asset.mockResolvedValue({ createdAt: '2026-10-11T12:00:00Z', evidenceRefs: [ref] });
  mocks.conversation.mockResolvedValue({ conversation_id: ref.id, title: '周报讨论' });
  mocks.enabled.mockResolvedValue(true);
  mocks.messages.mockResolvedValue([
    { from: 'user', text: '按进展、风险和计划组织。 token=do-not-copy', ts: '2026-10-11T11:00:00Z' },
    { from: 'assistant', text: '模型推断不应冒充用户原文', ts: '2026-10-11T11:01:00Z' },
    { from: 'user', text: '候选生成后的发言不进入当时节选', ts: '2026-10-11T13:00:00Z' },
  ]);
});
describe('审核详情的真实来源原文投影', () => {
  it('只读取所属用户已关联的会话，节选标明上下文且排除后续消息与秘密', async () => {
    const rows = await readReviewEvidence('owner-a', { candidateId: 'candidate-a' });
    expect(mocks.candidate).toHaveBeenCalledWith('owner-a', 'candidate-a');
    expect(mocks.conversation).toHaveBeenCalledWith('owner-a', 'conversation-a');
    expect(rows[0]).toMatchObject({ state: 'available', title: '周报讨论', excerptKind: 'conversation_context' });
    expect(rows[0].excerpt).toContain('按进展、风险和计划组织');
    expect(JSON.stringify(rows)).not.toContain('do-not-copy');
    expect(JSON.stringify(rows)).not.toContain('模型推断');
    expect(JSON.stringify(rows)).not.toContain('候选生成后的');
  });
  it('暂停、删除与降级来源不暴露旧摘录，也不回退到标题推测', async () => {
    mocks.candidate.mockResolvedValue({ evidenceRefs: [{ ...ref, excerpt: '已撤销的旧摘录' }] });
    mocks.enabled.mockResolvedValue(false);
    expect((await readReviewEvidence('owner-a', { candidateId: 'candidate-a' }))[0]).toMatchObject({ state: 'unavailable' });
    expect(mocks.messages).not.toHaveBeenCalled();
    expect(JSON.stringify(await readReviewEvidence('owner-a', { candidateId: 'candidate-a' }))).not.toContain('已撤销的旧摘录');
    mocks.enabled.mockResolvedValue(true);
    mocks.conversation.mockResolvedValue({ conversation_id: ref.id, deleted_at: '2026-10-11' });
    expect((await readReviewEvidence('owner-a', { candidateId: 'candidate-a' }))[0].excerpt).toBeUndefined();
  });
  it('所有权读取失败不继续读来源；任意来源定位参数不能替代已关联目标', async () => {
    mocks.asset.mockRejectedValue(new Error('asset not found'));
    await expect(readReviewEvidence('other-user', { assetId: 'private-asset' })).rejects.toThrow('asset not found');
    expect(mocks.conversation).not.toHaveBeenCalled();
    await expect(readReviewEvidence('owner-a', { candidateId: '../bad' })).rejects.toThrow('invalid review target');
    await expect(readReviewEvidence('owner-a', { candidateId: 'a', assetId: 'b' })).rejects.toThrow('one review target');
  });
  it('IO 失败单列为读取失败，不伪装成不存在；哈希消息引用不猜父会话', async () => {
    mocks.messages.mockRejectedValue(new Error('disk failed'));
    expect((await readReviewEvidence('owner-a', { candidateId: 'candidate-a' }))[0].state).toBe('read_failed');
    mocks.candidate.mockResolvedValue({ evidenceRefs: [{ ...ref, subtype: 'message', id: 'msg-opaque' }] });
    mocks.conversation.mockClear();
    expect((await readReviewEvidence('owner-a', { candidateId: 'candidate-a' }))[0].state).toBe('unrecorded');
    expect(mocks.conversation).not.toHaveBeenCalled();
  });
  it('定位证据显示经核对的长段落和附件入口，变化后移除旧摘录及入口', async () => {
    const located = { kind: 'artifact_file', subtype: 'artifact', taxonomyVersion: 2, id: 'att-synthetic',
      locator: { conversationId: 'conversation-a', messageId: 'message-a', attachmentName: 'transcript.txt' } };
    mocks.candidate.mockResolvedValue({ evidenceRefs: [located, located] });
    const excerpt = '合成会议转写。'.repeat(60) + '预计测试后可用，不能视为上线承诺。';
    mocks.located.mockResolvedValue({ state: 'available', title: 'transcript.txt', excerpt, location: { startLine: 2, endLine: 8 } });
    const result = await readReviewEvidence('owner-a', { candidateId: 'candidate-a' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ excerpt, openTarget: located.locator, location: { startLine: 2, endLine: 8 } });
    mocks.located.mockResolvedValue({ state: 'changed', title: 'transcript.txt' });
    const changed = (await readReviewEvidence('owner-a', { candidateId: 'candidate-a' }))[0];
    expect(changed.state).toBe('changed'); expect(changed.excerpt).toBeUndefined(); expect(changed.openTarget).toBeUndefined();
  });
});
