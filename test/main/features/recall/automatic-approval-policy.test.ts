import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../src/main/util/boot_init', () => ({ registerDeferred: () => {} }));

describe('automatic approval grants', () => {
  it('has no privileged automatic save entry in the candidate service', async () => {
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    expect(candidates).not.toHaveProperty('approveNewNightlyRecallCandidate');
  });
  it('requires explicit opt-in and does not restore legacy scheduling or review policies', async () => {
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    const { readRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    expect((await settings.readRecallCaptureSettings('retired-policy-user')).autoApproval).toBe(false);
    // Validation failures below do not write to the workspace.
    expect(await readRecallJsonRecord('retired-policy-user', 'capture-settings', 'settings')).toBeUndefined();
    await expect(settings.updateRecallCaptureSettings('retired-policy-user', { reviewPolicy: 'auto' })).rejects.toThrow(/automatic approval/);
    await expect(settings.updateRecallCaptureSettings('retired-policy-user', { executionPolicy: 'smart' })).rejects.toThrow(/only nightly/);
  });
});
