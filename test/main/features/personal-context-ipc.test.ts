/**
 * personal_context IPC 参数校验测试：非法输入在进入 feature 层之前被拒绝。
 */
import { describe, expect, it } from 'vitest';
import { pickFeishuInstance } from '../../../src/main/features/personal_context/manager';

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

  it('get_setup_guide returns credential readiness and the fixed redirect uri', async () => {
    const { invokeHandlers } = await import('../../../src/main/ipc/personal-context');
    const result = await invokeHandlers['personal_context.get_setup_guide']({}, { userId: 'user-1' }) as {
      guide: { credentialReady: boolean; redirectUri: string };
    };
    expect(result.guide.redirectUri).toBe('http://127.0.0.1:36415/oauth/feishu/callback');
    expect(typeof result.guide.credentialReady).toBe('boolean');
  });
});

describe('pickFeishuInstance', () => {
  const inst = (id: string, over: Partial<{ brand: string; kind: string }> = {}) => ({
    id,
    feishuTenantBrand: over.brand,
    status: { kind: over.kind ?? 'disconnected' },
  });

  it('prefers the feishu (china) brand instance even when it is not first and not connected', () => {
    const picked = pickFeishuInstance([
      inst('lark-a', { brand: 'lark' }),
      inst('lark-b', { brand: 'lark', kind: 'connected' }),
      inst('feishu-c', { brand: 'feishu' }),
    ]);
    expect(picked).toBe('feishu-c');
  });

  it('falls back to the connected instance when no feishu-brand instance exists', () => {
    const picked = pickFeishuInstance([
      inst('lark-a', { brand: 'lark' }),
      inst('lark-b', { brand: 'lark', kind: 'connected' }),
    ]);
    expect(picked).toBe('lark-b');
  });

  it('falls back to the first configured instance when none are connected', () => {
    const picked = pickFeishuInstance([
      inst('lark-a', { brand: 'lark' }),
      inst('feishu-b', { brand: 'lark' }), // brand 异常时按位置兜底
    ]);
    expect(picked).toBe('lark-a');
  });

  it('returns undefined for an empty candidate list', () => {
    expect(pickFeishuInstance([])).toBeUndefined();
  });
});
