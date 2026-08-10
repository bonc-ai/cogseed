/**
 * personal_context IPC 参数校验测试：非法输入在进入 feature 层之前被拒绝。
 */
import { describe, expect, it } from 'vitest';

describe('personal context ipc validation', () => {
  it('rejects unsupported provider ids before reaching the feature layer', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/personal-context');
    const ctx = { userId: 'user-1' };
    await expect(
      invokeHandlers['personal_context.begin_authorize']({ providerId: 'wechat' }, ctx),
    ).rejects.toThrow('unsupported personal context provider');
    await expect(
      invokeHandlers['personal_context.get_status']({ providerId: 'google' }, ctx),
    ).rejects.toThrow('unsupported personal context provider');
    await expect(
      invokeHandlers['personal_context.revoke']({}, ctx),
    ).rejects.toThrow('unsupported personal context provider');
    await expect(
      invokeHandlers['personal_context.health_check']({ providerId: 'lark' }, ctx),
    ).rejects.toThrow('unsupported personal context provider');
  });

  it('rejects invalid instance ids', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/personal-context');
    await expect(
      invokeHandlers['personal_context.begin_authorize'](
        { providerId: 'feishu', instanceId: '../bad' },
        { userId: 'user-1' },
      ),
    ).rejects.toThrow('invalid messaging instance id');
    await expect(
      invokeHandlers['personal_context.begin_authorize'](
        { providerId: 'feishu', instanceId: 'bad id with space' },
        { userId: 'user-1' },
      ),
    ).rejects.toThrow('invalid messaging instance id');
  });
});
