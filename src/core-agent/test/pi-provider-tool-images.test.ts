/**
 * C1/R-09 — provider-boundary contract for tool-result images.
 *
 * The plan's original shape (images inside `toolResult.content`) is NOT what the host
 * ships: the host contract types `tool_result.content` as `string`, and the pi-ai
 * converter pair (OpenAI/Gemini) is why the "images ride the next user turn" fallback
 * exists. The owner chose the DSH route instead — externalize + text handle — so this
 * contract pins that: a tool image never reaches a route whose model cannot accept
 * images, and the toolResult message itself never splits.
 */
import { describe, expect, it } from 'vitest';

import { buildPiContext } from '../src/providers/pi-provider.js';
import type { Message } from '../src/shared/types.js';

function history(over: { data?: string; readonlyPath?: string; toolUseId?: string } = {}): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: over.toolUseId || 'call-1', name: 'view_image', input: { path: 'safe.png' } }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: over.toolUseId || 'call-1', content: 'image rendered' },
        {
          type: 'image',
          data: over.data || 'AAAA',
          mediaType: 'image/png',
          toolUseId: over.toolUseId || 'call-1',
          ...(over.readonlyPath ? { readonlyPath: over.readonlyPath } : {}),
        },
      ],
    },
  ];
}

describe('buildPiContext — tool-result images (C1/R-09)', () => {
  it('⚠️ 文本模型：工具图片外置为文本句柄，绝不以图片块进入请求', () => {
    const ctx = buildPiContext(
      history({ readonlyPath: '/w/safe.png' }),
      undefined,
      undefined,
      { api: 'openai-completions', provider: 'pi', id: 'text-only', input: ['text'] },
    );

    const toolResult = ctx.messages.find((m) => m.role === 'toolResult');
    expect(toolResult).toBeTruthy();
    expect((toolResult as { content: Array<{ type: string }> }).content.every((b) => b.type === 'text')).toBe(true);

    const leaked = ctx.messages.flatMap((m) => m.content).some((b) => b.type === 'image');
    expect(leaked).toBe(false);

    const texts = ctx.messages
      .flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(texts).toContain('/w/safe.png');
  });

  it('视觉模型下预算内：图片仍走既有的「紧随其后的用户消息」形状（toolResult 不被拆分）', () => {
    const ctx = buildPiContext(
      history(),
      undefined,
      undefined,
      { api: 'openai-completions', provider: 'pi', id: 'vision-model', input: ['text', 'image'] },
    );

    const toolResult = ctx.messages.find((m) => m.role === 'toolResult');
    expect(toolResult).toBeTruthy();
    const userWithImage = ctx.messages.find(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'image'),
    );
    expect(userWithImage).toBeTruthy();
  });

  it('用户附件（无 tool_use 归属）不参与外置', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'image', data: 'USER', mediaType: 'image/png' }] },
    ];
    const ctx = buildPiContext(messages, undefined, undefined, {
      api: 'openai-completions', provider: 'pi', id: 'text-only', input: ['text'],
    });
    const image = ctx.messages.flatMap((m) => m.content).find((b) => b.type === 'image');
    expect(image).toBeTruthy();
  });
});
