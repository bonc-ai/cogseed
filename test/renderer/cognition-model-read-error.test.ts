import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 模型主快照读取失败必须显示分区错误，不能冒充尚未配置模型。
 * captureModelError 保留失败信息；captureSettings 的空对象兜底保持不变。
 * IPC 与模型配置全部由内存桩提供。
 */

const rootDir = resolve(__dirname, '../..');
const viewsSource = readFileSync(resolve(rootDir, 'src/renderer/modules/cognition-assets/views.js'), 'utf8');

const globalScope = globalThis as unknown as Record<string, unknown>;
type Invoke = (channel: string, payload: Record<string, unknown>) => Promise<unknown>;
let invokeImpl: Invoke = async () => ({ ok: true });

const NS = (() => {
  const stub: Record<string, unknown> = {};
  globalScope.window = {
    CogAssets: stub,
    cogseed: { invoke: (channel: string, payload: Record<string, unknown>) => invokeImpl(channel, payload) },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/core.js');
  return stub as unknown as {
    store: Record<string, unknown>;
    reload: () => Promise<void>;
  };
})();

describe('模型主快照读失败的分区错误标记', () => {
  it('settings.get 失败：captureModelError 落标记；captureSettings/captureModel 形状与旧行为一致、errors 照记', async () => {
    invokeImpl = async (channel) => (channel === 'recall.captures.settings.get'
      ? { ok: false, error: 'settings unreadable', code: 'E_IO' }
      : { ok: true });
    await NS.reload();
    expect(String(NS.store.captureModelError || '')).not.toBe(''); // 修前：无此标记，null 被当「未配置」
    expect(NS.store.captureSettings).toEqual({}); // 与 api.soft 兜底 {} 的旧行为一致（整理页 warn 不出现）
    expect(NS.store.captureModel).toBe(null);
    expect((NS.store.errors as Array<{ channel: string }>).some((entry) => entry.channel === 'recall.captures.settings.get')).toBe(true);
  });

  it('settings.get 成功：标记清空、模型照常落盘（失败→重试→自愈不卡死）', async () => {
    invokeImpl = async (channel) => (channel === 'recall.captures.settings.get'
      ? { ok: true, settings: { executionPolicy: 'nightly' }, model: { configured: true, authorizationRequired: false } }
      : { ok: true });
    await NS.reload();
    expect(NS.store.captureModelError).toBe('');
    expect(NS.store.captureModel).toMatchObject({ configured: true });
    expect(NS.store.captureSettings).toMatchObject({ executionPolicy: 'nightly' });
  });

  it('热重载读取旧主进程快照时保留已证明的 API 配置与授权状态', async () => {
    invokeImpl = async channel => channel === 'recall.captures.settings.get'
      ? { ok: true, settings: { executionPolicy: 'nightly' }, model: { configured: true, authorizationRequired: false } }
      : { ok: true };
    await NS.reload();
    expect(NS.store.captureModelError).toBe('');
    expect(NS.store.captureModel).toMatchObject({ runtimeStatus: 'legacy', apiConfigured: true, available: undefined });
    expect((NS.store.captureModel as Record<string, unknown>).channel).toBeUndefined();
    invokeImpl = async channel => channel === 'recall.captures.settings.get'
      ? { ok: true, settings: {}, model: { configured: true, authorizationRequired: true } }
      : { ok: true };
    await NS.reload();
    expect(NS.store.captureModel).toMatchObject({ channel: 'unavailable', authorizationRequired: true, available: false });
  });

  it('旧主进程未配置 API 不能证明 CLI 不可用，显式 unknown 也不能被配置标记覆盖', async () => {
    invokeImpl = async channel => channel === 'recall.captures.settings.get'
      ? { ok: true, settings: {}, model: { configured: false, authorizationRequired: false } }
      : { ok: true };
    await NS.reload();
    expect(NS.store.captureModel).not.toHaveProperty('channel');
    invokeImpl = async channel => channel === 'recall.captures.settings.get'
      ? { ok: true, settings: {}, model: { configured: true, authorizationRequired: false, runtimeStatus: 'unknown', runtimeError: 'profile read failed' } }
      : { ok: true };
    await NS.reload();
    expect(NS.store.captureModel).toMatchObject({ runtimeStatus: 'unknown', runtimeError: 'profile read failed' });
    expect(NS.store.captureModel).not.toHaveProperty('channel');
  });

  it('视图不再消费模型配置提醒，读取失败仍保持设置未知', () => {
    expect(viewsSource).not.toContain('NS.assetSettings.modelStatus');
    expect(viewsSource).not.toContain('ca-settings-model');
    expect(viewsSource).not.toContain("'cognition.settings_channel_unknown'");
    expect(viewsSource).not.toContain("'cognition.settings_channel_unavailable'");
    expect(viewsSource).toContain('const stateUnknown = Boolean(S.captureModelError) || !S.captureSettings');
  });
});
