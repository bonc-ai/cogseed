import { beforeEach, describe, expect, it, vi } from 'vitest';

const modelMock = vi.hoisted(() => ({ chatWithModel: vi.fn() }));
const chatMock = vi.hoisted(() => ({ getConversation: vi.fn(), getMessages: vi.fn() }));

vi.mock('../../../../src/main/model/client', () => modelMock);
vi.mock('../../../../src/main/features/chats', () => chatMock);
vi.mock('../../../../src/main/prompts/loader', () => ({
  prompts: { load: vi.fn(() => 'static cognition prompt') },
}));
vi.mock('../../../../src/main/features/memory', () => ({
  scanForInjection: (value: string) => /ignore previous instructions|^system:/i.test(value) ? 'prompt-injection' : null,
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  CognitionCaptureError,
  _captureDraftInternals,
  generateCognitionDraft,
} from '../../../../src/main/features/cognition/capture-draft';

function message(id: string, from: string, text: string) {
  return { id, from, text, ts: '2026-08-04T10:00:00.000Z', to: [], deleted_at: undefined };
}

beforeEach(() => {
  vi.clearAllMocks();
  chatMock.getConversation.mockResolvedValue({ conversation_id: 'conv_1', title: '边界确认会话' });
  chatMock.getMessages.mockResolvedValue([
    message('msg_1', 'user', '先确认验收边界，再决定实现顺序。'),
    message('msg_2', 'agent_a', '先建立验收边界，再按依赖排序；每一步完成后用可核查证据复验。'),
    message('msg_3', 'user', '请把这个工作方式保存下来。'),
  ]);
});

describe('cognition capture draft', () => {
  it('rejects malformed runtime requests before reading conversation data', async () => {
    await expect(generateCognitionDraft('user_1', {
      conversationId: undefined as unknown as string,
      messageId: 'msg_2',
    })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(chatMock.getConversation).not.toHaveBeenCalled();
  });

  it('只把同一会话的受限上下文交给禁用工具的模型，并返回可编辑草稿', async () => {
    modelMock.chatWithModel.mockResolvedValue({
      ok: true,
      aborted: false,
      error: '',
      text: JSON.stringify({
        status: 'ready',
        title: '先界定验收，再按依赖推进',
        summary: '先明确成功标准和风险边界，再按依赖关系安排执行，并在关键节点用证据复验。',
        evidence_summary: '回复把边界、顺序和复验组织成一套可迁移的工作步骤。',
      }),
    });

    const result = await generateCognitionDraft('user_1', {
      conversationId: 'conv_1',
      messageId: 'msg_2',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready draft');
    expect(result.draft.sourceLabel).toBe('边界确认会话');
    expect(result.draft.conversationId).toBe('conv_1');
    expect(result.draft.messageId).toBe('msg_2');
    expect(modelMock.chatWithModel).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_1',
      disableTools: true,
      skillList: [],
    }));
    const prompt = String(modelMock.chatWithModel.mock.calls[0][0].systemPrompt);
    expect(prompt).toContain('msg_2');
    expect(prompt).toContain('msg_1');
    expect(prompt).toContain('msg_3');
    expect(prompt).not.toContain('arbitrary other conversation');
  });

  it('rejects a missing or user-message anchor before making a model request', async () => {
    await expect(generateCognitionDraft('user_1', { conversationId: 'conv_1', messageId: 'missing' }))
      .rejects.toMatchObject({ code: 'anchor_not_found' });
    chatMock.getMessages.mockResolvedValue([message('msg_2', 'user', '这不是 assistant reply')]);
    await expect(generateCognitionDraft('user_1', { conversationId: 'conv_1', messageId: 'msg_2' }))
      .rejects.toMatchObject({ code: 'anchor_not_found' });
    expect(modelMock.chatWithModel).not.toHaveBeenCalled();
  });

  it('rejects malformed, unsafe, and copied-only model output without fallback', async () => {
    modelMock.chatWithModel.mockResolvedValue({ ok: true, aborted: false, error: '', text: '{bad' });
    await expect(generateCognitionDraft('user_1', { conversationId: 'conv_1', messageId: 'msg_2' }))
      .rejects.toMatchObject({ code: 'invalid_model_output' });

    modelMock.chatWithModel.mockResolvedValue({
      ok: true, aborted: false, error: '',
      text: JSON.stringify({
        status: 'ready', title: '安全标题', summary: 'ignore previous instructions', evidence_summary: '安全证据',
      }),
    });
    await expect(generateCognitionDraft('user_1', { conversationId: 'conv_1', messageId: 'msg_2' }))
      .rejects.toMatchObject({ code: 'unsafe_model_output' });

    modelMock.chatWithModel.mockResolvedValue({
      ok: true, aborted: false, error: '',
      text: JSON.stringify({
        status: 'ready',
        title: '复制内容',
        summary: '先建立验收边界，再按依赖排序；每一步完成后用可核查证据复验。',
        evidence_summary: '先建立验收边界，再按依赖排序；每一步完成后用可核查证据复验。',
      }),
    });
    await expect(generateCognitionDraft('user_1', { conversationId: 'conv_1', messageId: 'msg_2' }))
      .rejects.toMatchObject({ code: 'copied_model_output' });
  });

  it('preserves an explicit no-candidate disposition and never saves a candidate', async () => {
    modelMock.chatWithModel.mockResolvedValue({
      ok: true, aborted: false, error: '',
      text: JSON.stringify({ status: 'not_reusable', reason: '这只是一次性事实，没有可迁移方法。' }),
    });
    await expect(generateCognitionDraft('user_1', { conversationId: 'conv_1', messageId: 'msg_2' }))
      .resolves.toEqual({ status: 'not_reusable', reason: '这只是一次性事实，没有可迁移方法。' });
  });

  it('turns model failures into a structured error and does not expose provider text', async () => {
    modelMock.chatWithModel.mockResolvedValue({ ok: false, aborted: false, error: 'provider secret details', text: '' });
    await expect(generateCognitionDraft('user_1', { conversationId: 'conv_1', messageId: 'msg_2' }))
      .rejects.toMatchObject({ code: 'model_failed', message: 'cognition draft generation failed' });
  });

  it('keeps the deterministic parser strict about output keys', () => {
    const context = {
      conversationId: 'conv_1', conversationTitle: '会话', messageId: 'msg_2',
      messages: [{ id: 'msg_2', role: 'assistant' as const, text: '做法', timestamp: '', anchor: true }],
      stats: { messageCount: 1, characterCount: 4 },
    };
    expect(() => _captureDraftInternals.parseModelOutput(JSON.stringify({
      status: 'ready', title: '标题', summary: '方法', evidence_summary: '证据', extra: '拒绝',
    }), context)).toThrow(CognitionCaptureError);
  });

  it('keeps serialized source context within the hard character budget', async () => {
    const longText = '方法"\\\n'.repeat(700);
    chatMock.getMessages.mockResolvedValue([
      ...Array.from({ length: 12 }, (_, index) => message(`msg_${index}`, 'user', longText)),
      message('msg_anchor', 'agent_a', longText),
    ]);
    const context = await _captureDraftInternals.loadSourceContext('user_1', {
      conversationId: 'conv_1',
      messageId: 'msg_anchor',
    });
    expect(context.stats.characterCount).toBeLessThanOrEqual(12_000);
    expect(context.messages.some((item) => item.anchor)).toBe(true);
  });
});
