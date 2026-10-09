import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hasTouchpointActionHandlers,
  notifyTouchpointActionHandlers,
  registerTouchpointActionHandler,
} from '../../../../src/main/features/touchpoints/actions';
import type { TouchpointActionRecord } from '../../../../src/main/features/touchpoints/types';

function record(action: TouchpointActionRecord['action']): TouchpointActionRecord {
  return {
    version: 1,
    actionId: 'action-1',
    intentId: 'intent-1',
    userId: 'user-1',
    action,
    occurredAt: '2026-08-10T02:00:00.000Z',
    signatureHash: 'a'.repeat(64),
    consumedAt: '2026-08-10T02:00:01.000Z',
  };
}

describe('touchpoint action handlers', () => {
  beforeEach(() => {
    // 注册表是模块级单例：测试间清理已注册 handler 不可行（无注销 API），
    // 用唯一动作名隔离用例。
  });

  it('notifies handlers registered for the consumed action only', async () => {
    const snooze = vi.fn(async () => undefined);
    const adjust = vi.fn(async () => undefined);
    registerTouchpointActionHandler('snooze', snooze);
    registerTouchpointActionHandler('adjust', adjust);

    await notifyTouchpointActionHandlers('user-1', record('snooze'));

    expect(snooze).toHaveBeenCalledWith('user-1', record('snooze'));
    expect(adjust).not.toHaveBeenCalled();
  });

  it('isolates a failing handler from the others', async () => {
    const boom = vi.fn(async () => {
      throw new Error('boom');
    });
    const fine = vi.fn(async () => undefined);
    registerTouchpointActionHandler('approve', boom);
    registerTouchpointActionHandler('approve', fine);

    // notify 不抛错：坏 handler 不影响后续。
    await expect(notifyTouchpointActionHandlers('user-1', record('approve'))).resolves.toBeUndefined();
    expect(fine).toHaveBeenCalledTimes(1);
  });

  it('reports registered actions and is a no-op for unknown ones', async () => {
    registerTouchpointActionHandler('reject', vi.fn(async () => undefined));
    expect(hasTouchpointActionHandlers('reject')).toBe(true);
    await expect(notifyTouchpointActionHandlers('user-1', record('reject'))).resolves.toBeUndefined();
    expect(hasTouchpointActionHandlers('revoke_grant')).toBe(false);
    await expect(notifyTouchpointActionHandlers('user-1', record('revoke_grant'))).resolves.toBeUndefined();
  });
});
