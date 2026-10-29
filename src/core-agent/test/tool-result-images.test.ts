/**
 * C1/R-09 — tool-result image externalization (the DSH route).
 *
 * Contract under test: tool-produced images stay attributed blocks; over budget they
 * are recorded as offloaded and replaced by a text handle that names the read-only
 * copy; user attachments are never touched; and the whole projection is
 * deterministic, so replay and route switches reproduce the same request.
 */
import { describe, expect, it } from 'vitest';

import {
  TOOL_RESULT_IMAGE_BUDGET,
  externalizeToolResultImages,
  markOffloadedToolImages,
  projectOffloadedToolImages,
  toolResultImageHandleText,
} from '../src/shared/tool-result-images.js';
import type { ImageContent, Message } from '../src/shared/types.js';

function toolImage(toolUseId: string, over: Partial<ImageContent> = {}): ImageContent {
  return {
    type: 'image',
    data: 'A'.repeat(12),
    mediaType: 'image/png',
    toolUseId,
    ...over,
  };
}

function messagesWith(...content: ImageContent[]): Message[] {
  return [{ role: 'user', content: [{ type: 'text', text: 'see attached' }, ...content] }];
}

describe('toolResultImageHandleText', () => {
  it('⭐ names the read-only copy and tells the model to read it with file tools', () => {
    const text = toolResultImageHandleText(toolImage('toolu_1', {
      name: 'chart.png',
      readonlyPath: '/tmp/run/chart.png',
    }));

    expect(text).toContain('image omitted from this request');
    expect(text).toContain('"chart.png" (toolu_1)');
    expect(text).toContain('"/tmp/run/chart.png"');
    expect(text).toContain('image/png');
    expect(text).toContain('Read that path with your file tools');
    expect(text).toContain('copy it to a writable location');
  });

  it('⚠️ without a path it names the limitation instead of pretending the image is readable', () => {
    const text = toolResultImageHandleText(toolImage('toolu_2'));

    expect(text).toContain('No local read-only copy is available');
    expect(text).not.toContain('Read-only copy saved at');
  });
});

describe('markOffloadedToolImages', () => {
  it('under budget → nothing is offloaded', () => {
    const messages = messagesWith(toolImage('toolu_1'), toolImage('toolu_2'));
    const marked = markOffloadedToolImages(messages, { maxImages: 4 });
    expect(marked.map((m) => m.content.some((b) => b.type === 'image' && b.offloaded === true)))
      .toEqual([false]);
  });

  it('⭐ over the count budget the OLDEST images are offloaded first', () => {
    const messages = messagesWith(
      toolImage('toolu_old'),
      toolImage('toolu_mid'),
      toolImage('toolu_new'),
    );
    const marked = markOffloadedToolImages(messages, { maxImages: 2 });
    const images = marked[0].content.filter((b): b is ImageContent => b.type === 'image');
    expect(images.map((b) => [b.toolUseId, b.offloaded === true])).toEqual([
      ['toolu_old', true],
      ['toolu_mid', false],
      ['toolu_new', false],
    ]);
  });

  it('⚠️ 用户附件不参与：没有 tool_use 归属的图片即便超预算也原地不动', () => {
    const userImage: ImageContent = { type: 'image', data: 'A'.repeat(64), mediaType: 'image/png' };
    const messages: Message[] = [{ role: 'user', content: [userImage, toolImage('toolu_1')] }];

    const marked = markOffloadedToolImages(messages, { maxImages: 1, maxBase64Chars: 1 });

    expect((marked[0].content[0] as ImageContent).offloaded).toBeUndefined();
    expect((marked[0].content[1] as ImageContent).offloaded).toBe(true);
  });

  it('byte budget also removes whole oldest occurrences until it fits', () => {
    const big = (id: string) => toolImage(id, { data: 'A'.repeat(100) });
    const messages = messagesWith(big('toolu_1'), big('toolu_2'), big('toolu_3'));
    const marked = markOffloadedToolImages(messages, { maxBase64Chars: 150 });
    const images = marked[0].content.filter((b): b is ImageContent => b.type === 'image');
    expect(images.map((b) => b.offloaded === true)).toEqual([true, true, false]);
  });

  it('⚠️ 重放稳定：已 offload 的块不再计数，边界不会因为再次调用而回退', () => {
    const messages = messagesWith(toolImage('a'), toolImage('b'), toolImage('c'));
    const once = markOffloadedToolImages(messages, { maxImages: 2 });
    const twice = markOffloadedToolImages(once, { maxImages: 2 });
    expect(twice[0].content.filter((b) => b.type === 'image' && b.offloaded === true)).toHaveLength(1);
  });
});

describe('projectOffloadedToolImages', () => {
  it('replaces offloaded images with handle text and keeps the rest in order', () => {
    const messages = messagesWith(toolImage('toolu_1', { readonlyPath: '/w/a.png' }), toolImage('toolu_2'));
    const marked = markOffloadedToolImages(messages, { maxImages: 1 });

    const projected = projectOffloadedToolImages(marked);

    const blocks = projected[0].content;
    expect(blocks[0]).toEqual({ type: 'text', text: 'see attached' });
    expect(blocks[1].type).toBe('text');
    expect((blocks[1] as { text: string }).text).toContain('/w/a.png');
    expect(blocks[2].type).toBe('image');
  });

  it('⭐ idempotent: a second projection returns the identical shape', () => {
    const marked = markOffloadedToolImages(messagesWith(toolImage('a'), toolImage('b')), { maxImages: 1 });
    const once = projectOffloadedToolImages(marked);
    const twice = projectOffloadedToolImages(once);
    expect(twice).toEqual(once);
  });
});

describe('externalizeToolResultImages', () => {
  it('deterministic: same input + budget → same output', () => {
    const messages = messagesWith(toolImage('a'), toolImage('b'), toolImage('c'));
    expect(externalizeToolResultImages(messages, { maxImages: 2 }))
      .toEqual(externalizeToolResultImages(messages, { maxImages: 2 }));
  });

  it('⭐ 纯文本路由（maxImages: 0）把工具图片全部外置，用户附件不受影响', () => {
    const userImage: ImageContent = { type: 'image', data: 'B'.repeat(30), mediaType: 'image/jpeg' };
    const messages: Message[] = [{
      role: 'user',
      content: [userImage, toolImage('toolu_1', { readonlyPath: '/w/1.png' }), toolImage('toolu_2')],
    }];

    const projected = externalizeToolResultImages(messages, { maxImages: 0 });

    const blocks = projected[0].content;
    expect(blocks[0].type).toBe('image'); // user attachment survives
    expect(blocks[1].type).toBe('text');
    expect(blocks[2].type).toBe('text');
  });

  it('the default budget leaves a normal multi-image turn untouched', () => {
    const messages = messagesWith(toolImage('a'), toolImage('b'));
    const projected = externalizeToolResultImages(messages);
    expect(projected[0].content.filter((b) => b.type === 'image')).toHaveLength(2);
    expect(TOOL_RESULT_IMAGE_BUDGET.maxImages).toBeGreaterThanOrEqual(2);
  });
});
