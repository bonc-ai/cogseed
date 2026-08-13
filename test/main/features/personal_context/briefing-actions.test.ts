import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  autoTasks: {
    listTasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
  },
}));

vi.mock('../../../../src/main/features/auto_tasks', () => mocks.autoTasks);

import {
  BRIEFING_SNOOZE_DELAY_MS,
  installBriefingActionHandlers,
} from '../../../../src/main/features/personal_context/briefing-actions';
import { notifyTouchpointActionHandlers } from '../../../../src/main/features/touchpoints/actions';
import type { TouchpointActionRecord } from '../../../../src/main/features/touchpoints/types';

function record(action: TouchpointActionRecord['action'], content?: string): TouchpointActionRecord {
  return {
    version: 1,
    actionId: 'action-1',
    intentId: 'intent-1',
    userId: 'user-1',
    action,
    occurredAt: '2026-08-10T02:00:00.000Z',
    signatureHash: 'a'.repeat(64),
    consumedAt: '2026-08-10T02:00:01.000Z',
    ...(content ? { content } : {}),
  };
}

function dailyBriefingTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'at_briefing_1',
    title: 'Daily briefing',
    briefing: true,
    enabled: true,
    recipient: { kind: 'messaging', instanceId: 'inst_feishu_1', recipient: 'owner' },
    schedule: { type: 'daily', hour: 8, minute: 0 },
    ...overrides,
  };
}

describe('briefing touchpoint action handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T02:00:00.000Z'));
    mocks.autoTasks.listTasks.mockReset();
    mocks.autoTasks.createTask.mockReset();
    mocks.autoTasks.updateTask.mockReset();
    installBriefingActionHandlers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('snooze creates a one-time briefing task 30 minutes later on the same instance', async () => {
    mocks.autoTasks.listTasks.mockResolvedValue([dailyBriefingTask()]);
    mocks.autoTasks.createTask.mockResolvedValue({ ok: true, task: { id: 'at_snooze_1' } });

    await notifyTouchpointActionHandlers('user-1', record('snooze'));

    expect(mocks.autoTasks.createTask).toHaveBeenCalledWith('user-1', expect.objectContaining({
      briefing: true,
      enabled: true,
      recipient: { kind: 'messaging', instanceId: 'inst_feishu_1', recipient: 'owner' },
      schedule: {
        type: 'one_time',
        at: new Date(Date.now() + BRIEFING_SNOOZE_DELAY_MS).toISOString(),
      },
    }));
  });

  it('snooze is a no-op when no daily briefing task exists', async () => {
    mocks.autoTasks.listTasks.mockResolvedValue([]);

    await notifyTouchpointActionHandlers('user-1', record('snooze'));

    expect(mocks.autoTasks.createTask).not.toHaveBeenCalled();
  });

  it('adjust updates the daily briefing schedule from HH:mm content', async () => {
    mocks.autoTasks.listTasks.mockResolvedValue([dailyBriefingTask()]);
    mocks.autoTasks.updateTask.mockResolvedValue({ ok: true, task: dailyBriefingTask() });

    await notifyTouchpointActionHandlers('user-1', record('adjust', '20:30'));

    expect(mocks.autoTasks.updateTask).toHaveBeenCalledWith('user-1', 'at_briefing_1', {
      schedule: { type: 'daily', hour: 20, minute: 30 },
    });
  });

  it('adjust ignores unrecognized content without touching the schedule', async () => {
    mocks.autoTasks.listTasks.mockResolvedValue([dailyBriefingTask()]);

    await notifyTouchpointActionHandlers('user-1', record('adjust', '晚上八点'));
    await notifyTouchpointActionHandlers('user-1', record('adjust', '25:99'));
    await notifyTouchpointActionHandlers('user-1', record('adjust', '  '));

    expect(mocks.autoTasks.updateTask).not.toHaveBeenCalled();
  });

  it('unrelated actions do not reach briefing handlers', async () => {
    mocks.autoTasks.listTasks.mockResolvedValue([dailyBriefingTask()]);

    await notifyTouchpointActionHandlers('user-1', record('approve'));

    expect(mocks.autoTasks.createTask).not.toHaveBeenCalled();
    expect(mocks.autoTasks.updateTask).not.toHaveBeenCalled();
  });
});
