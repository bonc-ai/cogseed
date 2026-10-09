import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyVisionFallbackIfBlind,
  getVisionFallbackHandler,
  setVisionFallbackHandler,
  type VisionFallbackHandler,
} from '../../../src/main/features/vision_fallback';

const IMG_A = { data: 'aaa', mediaType: 'image/jpeg', name: 'a.jpg', absPath: '/tmp/a.jpg' };
const IMG_B = { data: 'bbb', mediaType: 'image/png' };

async function run(overrides: Partial<Parameters<typeof applyVisionFallbackIfBlind>[0]> = {}) {
  return applyVisionFallbackIfBlind({
    userId: 'u1',
    conversationId: 'c1',
    messageText: '看看这两张图',
    images: [IMG_A, IMG_B],
    resolveAbilities: async () => ({ providerId: 'p', modelId: 'm', vision: false }),
    ...overrides,
  });
}

describe('vision fallback seam', () => {
  beforeEach(() => {
    setVisionFallbackHandler(null);
  });
  afterEach(() => {
    setVisionFallbackHandler(null);
    vi.restoreAllMocks();
  });

  it('registers and clears the pluggable handler', () => {
    const h: VisionFallbackHandler = async () => ({});
    setVisionFallbackHandler(h);
    expect(getVisionFallbackHandler()).toBe(h);
    setVisionFallbackHandler(null);
    expect(getVisionFallbackHandler()).toBeNull();
  });

  it('passes through when no handler is registered (today\'s default)', async () => {
    expect(await run()).toBeNull();
  });

  it('passes through when the model is vision-capable or unknown', async () => {
    const handler = vi.fn(async () => ({ instructions: 'x' }));
    setVisionFallbackHandler(handler);
    expect(await run({ resolveAbilities: async () => ({ providerId: 'p', modelId: 'm', vision: true }) })).toBeNull();
    // Unknown capability never blocks passthrough.
    expect(await run({ resolveAbilities: async () => ({ providerId: 'p', modelId: 'm' }) })).toBeNull();
    expect(await run({ resolveAbilities: async () => null })).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes model-facing instructions through and drops non-passthrough images', async () => {
    setVisionFallbackHandler(async (input) => {
      expect(input.modelId).toBe('m');
      expect(input.images[0].absPath).toBe('/tmp/a.jpg');
      return {
        instructions: `用户发送了图片 a.jpg（路径 /tmp/a.jpg）。当前模型无法直接查看图片，请调用视觉工具处理。`,
        passthrough: [IMG_B],
        note: '已转为视觉工具指引',
      };
    });
    const out = await run();
    expect(out).not.toBeNull();
    expect(out!.messageText).toContain('看看这两张图');
    expect(out!.messageText).toContain('请调用视觉工具处理');
    // Only the handler's passthrough image survives inline.
    expect(out!.images).toEqual([IMG_B]);
    expect(out!.note).toBe('已转为视觉工具指引');
  });

  it('drops every inline image when the handler returns no passthrough', async () => {
    setVisionFallbackHandler(async () => ({ instructions: '图片已记录路径' }));
    const out = await run();
    expect(out!.images).toEqual([]);
    expect(out!.messageText).toContain('图片已记录路径');
  });

  it('never fails the turn: handler throw and ability-resolve throw both pass through', async () => {
    setVisionFallbackHandler(async () => { throw new Error('boom'); });
    expect(await run()).toBeNull();
    setVisionFallbackHandler(async () => ({ instructions: 'x' }));
    expect(await run({ resolveAbilities: async () => { throw new Error('offline'); } })).toBeNull();
  });

  it('skips entirely when the turn carries no images', async () => {
    const handler = vi.fn(async () => ({ instructions: 'x' }));
    setVisionFallbackHandler(handler);
    expect(await run({ images: [] })).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });
});
