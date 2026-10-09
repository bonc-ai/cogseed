import { beforeEach, describe, expect, it } from 'vitest';
import { invokeHandlers } from '../../../src/main/ipc/personal-context';
import { resetPersonalContextApplicationModeForTest } from '../../../src/main/features/personal_context/application/service';
import { resetPersonalContextApplicationServiceForTest } from '../../../src/main/features/personal_context/application';

const ctx = { userId: 'ipc-user-1' };

async function call(channel: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const handler = invokeHandlers[channel];
  if (!handler) throw new Error(`missing handler ${channel}`);
  return handler(payload, ctx);
}

beforeEach(() => {
  resetPersonalContextApplicationModeForTest();
  resetPersonalContextApplicationServiceForTest();
});

describe('personal context center IPC', () => {
  it('switches into an isolated demo dashboard without provider configuration', async () => {
    const result = await call('personal_context.mode.set', { mode: 'demo' }) as { dashboard: { mode: string; resources: { discovered: number } } };
    expect(result.dashboard.mode).toBe('demo');
    expect(result.dashboard.resources.discovered).toBeGreaterThan(0);
    const discovered = await call('personal_context.resources.discover') as { resources: unknown[] };
    expect(discovered.resources.length).toBeGreaterThan(0);
  });

  it('rejects invalid modes, candidate ids, schedules, and resource arrays', async () => {
    await expect(call('personal_context.mode.set', { mode: 'fake' })).rejects.toThrow('invalid personal context mode');
    await expect(call('personal_context.review.approve', { candidateId: '../bad' })).rejects.toThrow('invalid candidate id');
    await expect(call('personal_context.briefing.schedule', { hour: 24, minute: 0 })).rejects.toThrow('hour');
    await expect(call('personal_context.resources.select', { resources: 'bad' })).rejects.toThrow('resources must be an array');
  });

  it('exposes the briefing unschedule channel with a stable result shape', async () => {
    const result = await call('personal_context.briefing.unschedule') as { dashboard: { mode: string }; removed: boolean };
    expect(result.dashboard.mode).toBe('real');
    expect(typeof result.removed).toBe('boolean');
  });

  it('returns a setup guide with the fixed redirect uri even without credentials', async () => {
    const result = await call('personal_context.setup_guide') as { guide: { credentialReady: boolean; redirectUri: string; appId?: string; redirectConfigured: boolean } };
    expect(typeof result.guide.credentialReady).toBe('boolean');
    expect(result.guide.redirectUri).toBe('http://127.0.0.1:36415/oauth/feishu/callback');
    expect(typeof result.guide.redirectConfigured).toBe('boolean');
  });

  it('confirms the redirect-url setup flag and makes the guide report it', async () => {
    const before = await call('personal_context.setup_guide') as { guide: { redirectConfigured: boolean } };
    await call('personal_context.setup_guide.confirm');
    const after = await call('personal_context.setup_guide') as { guide: { redirectConfigured: boolean } };
    expect(after.guide.redirectConfigured).toBe(true);
    expect(before.guide.redirectConfigured).toBe(false);
  });

  it('rejects renderer-crafted resources that omit required storage fields', async () => {
    await expect(call('personal_context.resources.select', { resources: [{ resourceId: 'feishu:t:calendar:c', resourceType: 'calendar', title: 'x' }] }))
      .rejects.toThrow('observedAt');
  });
});
