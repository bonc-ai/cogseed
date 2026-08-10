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

  it('rejects renderer-crafted resources that omit required storage fields', async () => {
    await expect(call('personal_context.resources.select', { resources: [{ resourceId: 'feishu:t:calendar:c', resourceType: 'calendar', title: 'x' }] }))
      .rejects.toThrow('observedAt');
  });
});
