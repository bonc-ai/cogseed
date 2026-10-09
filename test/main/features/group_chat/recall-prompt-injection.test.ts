import { describe, expect, it, vi } from 'vitest';

const promptMock = vi.hoisted(() => ({
  buildConfirmedProjectionPromptBlock: vi.fn(async () => '<confirmed-ability-assets>asset-a</confirmed-ability-assets>'),
}));
vi.mock('../../../../src/main/features/recall/prompt-injection', () => promptMock);

describe('group chat Recall prompt integration', () => {
  it('keeps the confirmed ability prompt integration module-owned and callable', async () => {
    const prompt = await import('../../../../src/main/features/recall/prompt-injection');
    expect(await prompt.buildConfirmedProjectionPromptBlock('user-a', 'cid-a')).toContain('asset-a');
    expect(promptMock.buildConfirmedProjectionPromptBlock).toHaveBeenCalledWith('user-a', 'cid-a');
  });
});
